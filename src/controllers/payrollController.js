import { pool, query, transaction } from '../db/index.js';
import { reportPeriod, indiaDate } from '../services/superAdminAttendanceReport.js';
import { buildPayrollPreview, rupeesToPaise } from '../services/payrollCalculator.js';
import { createPaymentAdapter, providerConfigStatus, validateBankDetails } from '../services/paymentProvider.js';
import { enqueuePayrollPayments, reconcileWebhookEvent } from '../services/payrollPaymentWorker.js';
import { csvExport, xlsxExport } from '../utils/reportExport.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const respondError = (res, err) => res.status(err.status || 500).json({
  success: false,
  error: err.status ? err.message : 'Could not complete the payroll operation. Please retry.',
  ...(err.details ? { details: err.details } : {}),
});
const validDate = (val, label) => {
  const s = String(val ?? '').trim();
  const date = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s.startsWith('0000') || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== s) {
    fail(`${label} must be a valid YYYY-MM-DD date.`);
  }
  return s;
};
const safeId = (val, label = 'ID') => {
  const n = Number(val);
  if (!Number.isSafeInteger(n) || n <= 0) fail(`Invalid ${label}.`);
  return n;
};

async function audit(client, actorId, action, entityType, entityId, beforeData, afterData) {
  await client.query(
    'INSERT INTO payroll_audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1,$2,$3,$4,$5,$6)',
    [actorId, action, entityType, entityId, beforeData ? JSON.stringify(beforeData) : null, afterData ? JSON.stringify(afterData) : null]
  );
}

async function loadCalculationContext(period) {
  const [empRes, attRes, holRes, reqRes, histRes, salRes, bankRes] = await Promise.all([
    query("SELECT id, employee_id, first_name, last_name, department_name, designation, role, joining_date, is_active FROM employees WHERE is_active = true AND role <> 'SUPER_ADMIN' ORDER BY first_name, id"),
    query('SELECT * FROM attendances WHERE work_date >= $1 AND work_date <= $2', [period.first, period.last]),
    query('SELECT * FROM holidays WHERE holiday_date >= $1 AND holiday_date <= $2', [period.first, period.last]),
    query("SELECT * FROM requests WHERE status IN ('APPROVED','PENDING') AND start_date <= $2 AND end_date >= $1", [period.first, period.last]),
    query('SELECT * FROM employee_salary_history ORDER BY effective_from DESC, id DESC'),
    query('SELECT * FROM employee_salaries'),
    query('SELECT id, employee_id, account_holder_name, bank_name, account_number_masked, ifsc_code, account_type, is_verified FROM employee_bank_accounts'),
  ]);
  return {
    employees: empRes.rows,
    attendances: attRes.rows,
    holidays: holRes.rows,
    requests: reqRes.rows,
    salaryHistory: histRes.rows,
    currentSalaries: salRes.rows,
    bankAccounts: bankRes.rows,
  };
}

// ---------------------------------------------------------------------------
// 1. Payroll Dashboard
// ---------------------------------------------------------------------------
export async function getPayrollDashboard(req, res) {
  try {
    const today = indiaDate();
    const year = Number(req.query.year || today.slice(0, 4));
    const month = Number(req.query.month || today.slice(5, 7));
    const period = reportPeriod({ year, month });

    if (req.user.role === 'EMPLOYEE') {
      const [salRes, latestRes, histRes] = await Promise.all([
        query('SELECT monthly_salary_paise, effective_from, updated_at FROM employee_salaries WHERE employee_id = $1', [req.user.id]),
        query(
          `SELECT pr.*, pp.year, pp.month, pp.status AS period_status
           FROM payroll_records pr
           JOIN payroll_periods pp ON pp.id = pr.payroll_period_id
           WHERE pr.employee_id = $1 AND pp.status <> 'REJECTED'
           ORDER BY pp.year DESC, pp.month DESC LIMIT 6`,
          [req.user.id]
        ),
        query(
          `SELECT h.*, u.first_name AS updated_by_first_name, u.last_name AS updated_by_last_name
           FROM employee_salary_history h LEFT JOIN employees u ON u.id = h.updated_by
           WHERE h.employee_id = $1 ORDER BY h.effective_from DESC, h.id DESC LIMIT 10`,
          [req.user.id]
        ),
      ]);

      // Compute live current-month salary summary if not yet generated
      let liveSummary = latestRes.rows[0] || null;
      if (!liveSummary && salRes.rows[0]) {
        const [attRes, holRes, reqRes] = await Promise.all([
          query('SELECT * FROM attendances WHERE employee_id = $1 AND work_date >= $2 AND work_date <= $3', [req.user.id, period.first, period.last]),
          query('SELECT * FROM holidays WHERE holiday_date >= $1 AND holiday_date <= $2', [period.first, period.last]),
          query("SELECT * FROM requests WHERE employee_id = $1 AND status IN ('APPROVED','PENDING') AND start_date <= $3 AND end_date >= $2", [req.user.id, period.first, period.last]),
        ]);
        const preview = buildPayrollPreview(
          {
            employees: [req.user],
            attendances: attRes.rows,
            holidays: holRes.rows,
            requests: reqRes.rows,
            salaryHistory: histRes.rows,
            currentSalaries: [{ employee_id: req.user.id, ...salRes.rows[0] }],
            bankAccounts: [],
          },
          { year, month }
        );
        if (preview.records[0]) {
          liveSummary = {
            ...preview.records[0],
            year,
            month,
            period_status: 'LIVE_PREVIEW',
          };
        }
      }

      return res.json({
        success: true,
        data: {
          role: 'EMPLOYEE',
          year,
          month,
          current_salary: salRes.rows[0] || null,
          latest_summary: liveSummary,
          latest_payslips: latestRes.rows,
          salary_history: histRes.rows,
        },
      });
    }

    const [empCount, periodRow, recentPeriods] = await Promise.all([
      query("SELECT COUNT(*)::int AS total FROM employees WHERE is_active = true AND role <> 'SUPER_ADMIN'"),
      query('SELECT * FROM payroll_periods WHERE year = $1 AND month = $2', [year, month]),
      query(
        `SELECT pp.*, p.first_name AS prepared_by_name
         FROM payroll_periods pp
         LEFT JOIN employees p ON p.id = pp.prepared_by
         ORDER BY pp.year DESC, pp.month DESC LIMIT 12`
      ),
    ]);

    const selected = periodRow.rows[0] || null;
    let totals = null;
    let isLivePreview = false;

    if (selected) {
      totals = {
        total_employees: Number(selected.total_employees),
        total_monthly_payroll_paise: Number(selected.total_monthly_salary_paise),
        total_present_days: Number(selected.total_present_days),
        total_absent_days: Number(selected.total_absent_days),
        total_salary_deductions_paise: Number(selected.total_deduction_paise),
        total_payable_salary_paise: Number(selected.total_payable_paise),
      };
    } else {
      const ctx = await loadCalculationContext(period);
      const preview = buildPayrollPreview(ctx, { year, month });
      isLivePreview = true;
      totals = {
        total_employees: preview.totals.total_employees || empCount.rows[0].total,
        total_monthly_payroll_paise: preview.totals.total_monthly_salary_paise,
        total_present_days: preview.totals.total_present_days,
        total_absent_days: preview.totals.total_absent_days,
        total_salary_deductions_paise: preview.totals.total_deduction_paise,
        total_payable_salary_paise: preview.totals.total_payable_paise,
      };
    }

    return res.json({
      success: true,
      data: {
        role: req.user.role,
        year,
        month,
        is_live_preview: isLivePreview,
        ...totals,
        selected_period: selected,
        recent_periods: recentPeriods.rows,
      },
    });
  } catch (err) { return respondError(res, err); }
}

// ---------------------------------------------------------------------------
// 2. Employee Salaries, Revisions & Bank Accounts
// ---------------------------------------------------------------------------
export async function listEmployeeSalaries(req, res) {
  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    const department = String(req.query.department || 'ALL');
    const params = [];
    let sql = `
      SELECT e.id, e.employee_id AS employee_code, e.first_name, e.last_name, e.department_name, e.designation, e.joining_date, e.role,
             es.monthly_salary_paise, es.effective_from, es.updated_at AS salary_updated_at,
             u.first_name AS updated_by_first_name, u.last_name AS updated_by_last_name,
             ba.id AS bank_account_id, ba.account_holder_name, ba.bank_name, ba.account_number_masked, ba.ifsc_code, ba.account_type, ba.is_verified AS bank_verified
      FROM employees e
      LEFT JOIN employee_salaries es ON es.employee_id = e.id
      LEFT JOIN employees u ON u.id = es.updated_by
      LEFT JOIN employee_bank_accounts ba ON ba.employee_id = e.id
      WHERE e.is_active = true AND e.role <> 'SUPER_ADMIN'
    `;
    if (department && department !== 'ALL') {
      params.push(department);
      sql += ` AND e.department_name = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (LOWER(e.first_name || ' ' || e.last_name) LIKE $${params.length} OR LOWER(e.employee_id) LIKE $${params.length} OR LOWER(e.department_name) LIKE $${params.length})`;
    }
    sql += ' ORDER BY e.first_name, e.id';
    const rows = (await query(sql, params)).rows;
    return res.json({ success: true, data: rows });
  } catch (err) { return respondError(res, err); }
}

export async function upsertEmployeeSalary(req, res) {
  let client;
  try {
    const employeeId = safeId(req.params.employeeId, 'employee ID');
    const monthlySalaryPaise = req.body.monthly_salary_paise !== undefined
      ? Number(req.body.monthly_salary_paise)
      : rupeesToPaise(req.body.monthly_salary);
    if (!Number.isSafeInteger(monthlySalaryPaise) || monthlySalaryPaise <= 0) fail('Monthly salary must be a positive amount.');
    const effectiveFrom = validDate(req.body.effective_from || indiaDate(), 'Effective from date');
    const updateReason = String(req.body.update_reason || '').trim();
    if (updateReason.length < 3 || updateReason.length > 500) fail('Provide an update reason of 3–500 characters.');

    client = await pool.connect();
    await client.query('BEGIN');
    const emp = (await client.query("SELECT id, first_name, last_name, employee_id, role, is_active FROM employees WHERE id = $1 FOR UPDATE", [employeeId])).rows[0];
    if (!emp || !emp.is_active || emp.role === 'SUPER_ADMIN') fail('Eligible active employee not found.', 404);

    const existing = (await client.query('SELECT * FROM employee_salaries WHERE employee_id = $1 FOR UPDATE', [employeeId])).rows[0] || null;
    const previousPaise = existing ? Number(existing.monthly_salary_paise) : null;

    const saved = (await client.query(
      `INSERT INTO employee_salaries (employee_id, monthly_salary_paise, effective_from, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
       ON CONFLICT (employee_id)
       DO UPDATE SET monthly_salary_paise = EXCLUDED.monthly_salary_paise, effective_from = EXCLUDED.effective_from, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [employeeId, monthlySalaryPaise, effectiveFrom, req.user.id]
    )).rows[0];

    const historyRow = (await client.query(
      `INSERT INTO employee_salary_history (employee_id, previous_salary_paise, updated_salary_paise, effective_from, updated_by, update_reason)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [employeeId, previousPaise, monthlySalaryPaise, effectiveFrom, req.user.id, updateReason]
    )).rows[0];

    await audit(client, req.user.id, existing ? 'UPDATE_SALARY' : 'SET_SALARY', 'employee_salary', saved.id, existing, { salary: saved, history: historyRow });
    await client.query('COMMIT');
    return res.json({
      success: true,
      message: `Monthly salary updated for ${emp.first_name} ${emp.last_name} (${emp.employee_id}).`,
      data: { salary: saved, history: historyRow },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, err);
  } finally { client?.release(); }
}

export async function getSalaryHistory(req, res) {
  try {
    const params = [];
    let where = 'WHERE 1=1';
    if (req.user.role === 'EMPLOYEE') {
      params.push(req.user.id);
      where += ` AND h.employee_id = $${params.length}`;
    } else if (req.query.employee_id) {
      params.push(safeId(req.query.employee_id, 'employee ID'));
      where += ` AND h.employee_id = $${params.length}`;
    }
    const rows = (await query(
      `SELECT h.*, e.first_name, e.last_name, e.employee_id AS employee_code, e.department_name,
              u.first_name AS updated_by_first_name, u.last_name AS updated_by_last_name
       FROM employee_salary_history h
       JOIN employees e ON e.id = h.employee_id
       LEFT JOIN employees u ON u.id = h.updated_by
       ${where}
       ORDER BY h.created_at DESC, h.id DESC`,
      params
    )).rows;
    return res.json({ success: true, data: rows });
  } catch (err) { return respondError(res, err); }
}

export async function upsertBankAccount(req, res) {
  let client;
  try {
    const employeeId = safeId(req.params.employeeId, 'employee ID');
    const bank = validateBankDetails(req.body);

    client = await pool.connect();
    await client.query('BEGIN');
    const emp = (await client.query("SELECT id, first_name, last_name, employee_id, role, is_active FROM employees WHERE id = $1 FOR UPDATE", [employeeId])).rows[0];
    if (!emp || !emp.is_active || emp.role === 'SUPER_ADMIN') fail('Eligible active employee not found.', 404);

    const before = (await client.query('SELECT id, employee_id, bank_name, account_number_masked, ifsc_code, account_type FROM employee_bank_accounts WHERE employee_id = $1 FOR UPDATE', [employeeId])).rows[0] || null;
    const saved = (await client.query(
      `INSERT INTO employee_bank_accounts (employee_id, account_holder_name, bank_name, account_number_encrypted, account_number_masked, ifsc_code, account_type, is_verified, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,CURRENT_TIMESTAMP)
       ON CONFLICT (employee_id)
       DO UPDATE SET account_holder_name = EXCLUDED.account_holder_name, bank_name = EXCLUDED.bank_name,
         account_number_encrypted = EXCLUDED.account_number_encrypted, account_number_masked = EXCLUDED.account_number_masked,
         ifsc_code = EXCLUDED.ifsc_code, account_type = EXCLUDED.account_type, is_verified = true, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
       RETURNING id, employee_id, account_holder_name, bank_name, account_number_masked, ifsc_code, account_type, is_verified, updated_at`,
      [employeeId, bank.account_holder_name, bank.bank_name, bank.account_number_encrypted, bank.account_number_masked, bank.ifsc_code, bank.account_type, req.user.id]
    )).rows[0];

    await audit(client, req.user.id, 'SAVE_BANK_ACCOUNT', 'employee_bank_account', saved.id, before, saved);
    await client.query('COMMIT');
    return res.json({ success: true, message: `Bank details saved for ${emp.first_name} ${emp.last_name}.`, data: saved });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, err);
  } finally { client?.release(); }
}

// ---------------------------------------------------------------------------
// 3. Monthly Payroll Calculation, Generation, Submission, Approval & Rejection
// ---------------------------------------------------------------------------
export async function previewMonthlyPayroll(req, res) {
  try {
    const period = reportPeriod({ year: req.query.year, month: req.query.month });
    const existingPeriod = (await query('SELECT * FROM payroll_periods WHERE year = $1 AND month = $2', [period.year, period.month])).rows[0] || null;
    if (existingPeriod && ['APPROVED', 'AUTHORIZED', 'PROCESSING', 'COMPLETED', 'PARTIALLY_PAID'].includes(existingPeriod.status)) {
      const snapshotRows = (await query(
        `SELECT pr.*, ba.account_number_masked AS bank_account_masked, ba.bank_name, sp.status AS payment_status, sp.provider_utr
         FROM payroll_records pr
         LEFT JOIN employee_bank_accounts ba ON ba.employee_id = pr.employee_id
         LEFT JOIN salary_payments sp ON sp.payroll_record_id = pr.id
         WHERE pr.payroll_period_id = $1 ORDER BY pr.employee_name, pr.id`,
        [existingPeriod.id]
      )).rows;
      return res.json({
        success: true,
        data: {
          period,
          finalized: true,
          existing_period: existingPeriod,
          can_process: false,
          blockers: [],
          totals: {
            total_employees: Number(existingPeriod.total_employees),
            total_monthly_salary_paise: Number(existingPeriod.total_monthly_salary_paise),
            total_present_days: Number(existingPeriod.total_present_days),
            total_absent_days: Number(existingPeriod.total_absent_days),
            total_deduction_paise: Number(existingPeriod.total_deduction_paise),
            total_payable_paise: Number(existingPeriod.total_payable_paise),
          },
          records: snapshotRows,
        },
      });
    }
    const ctx = await loadCalculationContext(period);
    const preview = buildPayrollPreview(ctx, period);
    return res.json({ success: true, data: { ...preview, finalized: false, existing_period: existingPeriod } });
  } catch (err) { return respondError(res, err); }
}

export async function generateMonthlyPayroll(req, res) {
  let client;
  try {
    const period = reportPeriod({ year: req.body?.year, month: req.body?.month });
    const ctx = await loadCalculationContext(period);
    const preview = buildPayrollPreview(ctx, period);
    if (!preview.can_process) {
      throw Object.assign(new Error(preview.blockers[0] || 'Payroll cannot be generated until all attendance and salary prerequisites are complete.'), {
        status: 409,
        details: { blockers: preview.blockers },
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');
    const existing = (await client.query('SELECT * FROM payroll_periods WHERE year = $1 AND month = $2 FOR UPDATE', [period.year, period.month])).rows[0] || null;
    if (existing && !['DRAFT', 'REJECTED'].includes(existing.status)) {
      fail(`Payroll for ${period.prefix} is already ${existing.status.toLowerCase()} and cannot be regenerated.`, 409);
    }

    const t = preview.totals;
    let savedPeriod;
    if (existing) {
      await client.query('DELETE FROM payroll_records WHERE payroll_period_id = $1', [existing.id]);
      savedPeriod = (await client.query(
        `UPDATE payroll_periods
         SET status = 'DRAFT', prepared_by = $1, rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL,
             total_employees = $2, total_monthly_salary_paise = $3, total_present_days = $4,
             total_absent_days = $5, total_deduction_paise = $6, total_payable_paise = $7, updated_at = CURRENT_TIMESTAMP
         WHERE id = $8 RETURNING *`,
        [req.user.id, t.total_employees, t.total_monthly_salary_paise, t.total_present_days, t.total_absent_days, t.total_deduction_paise, t.total_payable_paise, existing.id]
      )).rows[0];
    } else {
      savedPeriod = (await client.query(
        `INSERT INTO payroll_periods (year, month, status, prepared_by, total_employees, total_monthly_salary_paise, total_present_days, total_absent_days, total_deduction_paise, total_payable_paise)
         VALUES ($1,$2,'DRAFT',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [period.year, period.month, req.user.id, t.total_employees, t.total_monthly_salary_paise, t.total_present_days, t.total_absent_days, t.total_deduction_paise, t.total_payable_paise]
      )).rows[0];
    }

    const insertedRecords = [];
    for (const r of preview.records) {
      const rec = (await client.query(
        `INSERT INTO payroll_records (payroll_period_id, employee_id, employee_name, employee_code, department_name, designation,
           monthly_salary_paise, working_days, present_days, absent_days, daily_salary_paise, absent_deduction_paise, final_payable_paise,
           salary_effective_from, attendance_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,30,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [savedPeriod.id, r.employee_id, r.employee_name, r.employee_code, r.department_name, r.designation,
          r.monthly_salary_paise, r.present_days, r.absent_days, r.daily_salary_paise, r.absent_deduction_paise, r.final_payable_paise,
          r.salary_effective_from, JSON.stringify(r.attendance_summary)]
      )).rows[0];
      insertedRecords.push(rec);
    }

    await audit(client, req.user.id, 'GENERATE_PAYROLL', 'payroll_period', savedPeriod.id, existing, { period: savedPeriod, count: insertedRecords.length });
    await client.query('COMMIT');
    return res.status(201).json({
      success: true,
      message: `Draft payroll generated for ${period.prefix} (${insertedRecords.length} employees).`,
      data: { period: savedPeriod, records: insertedRecords },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, err);
  } finally { client?.release(); }
}

export async function listPayrollPeriods(req, res) {
  try {
    const rows = (await query(
      `SELECT pp.*,
              prep.first_name || ' ' || prep.last_name AS prepared_by_name,
              sub.first_name || ' ' || sub.last_name AS submitted_by_name,
              app.first_name || ' ' || app.last_name AS approved_by_name,
              auth.first_name || ' ' || auth.last_name AS authorized_by_name
       FROM payroll_periods pp
       LEFT JOIN employees prep ON prep.id = pp.prepared_by
       LEFT JOIN employees sub ON sub.id = pp.submitted_by
       LEFT JOIN employees app ON app.id = pp.approved_by
       LEFT JOIN employees auth ON auth.id = pp.authorized_by
       ORDER BY pp.year DESC, pp.month DESC`
    )).rows;
    return res.json({ success: true, data: rows });
  } catch (err) { return respondError(res, err); }
}

export async function getPayrollPeriodDetails(req, res) {
  try {
    const id = safeId(req.params.id, 'payroll period ID');
    const period = (await query(
      `SELECT pp.*,
              prep.first_name || ' ' || prep.last_name AS prepared_by_name,
              sub.first_name || ' ' || sub.last_name AS submitted_by_name,
              app.first_name || ' ' || app.last_name AS approved_by_name,
              auth.first_name || ' ' || auth.last_name AS authorized_by_name
       FROM payroll_periods pp
       LEFT JOIN employees prep ON prep.id = pp.prepared_by
       LEFT JOIN employees sub ON sub.id = pp.submitted_by
       LEFT JOIN employees app ON app.id = pp.approved_by
       LEFT JOIN employees auth ON auth.id = pp.authorized_by
       WHERE pp.id = $1`,
      [id]
    )).rows[0];
    if (!period) fail('Payroll period not found.', 404);
    const [records, approvals] = await Promise.all([
      query(
        `SELECT pr.*, ba.bank_name, ba.account_number_masked, ba.ifsc_code,
                sp.id AS payment_id, sp.status AS payment_status, sp.provider, sp.provider_payout_id, sp.provider_utr, sp.failure_reason
         FROM payroll_records pr
         LEFT JOIN employee_bank_accounts ba ON ba.employee_id = pr.employee_id
         LEFT JOIN salary_payments sp ON sp.payroll_record_id = pr.id
         WHERE pr.payroll_period_id = $1 ORDER BY pr.employee_name, pr.id`,
        [id]
      ),
      query(
        `SELECT pa.*, e.first_name || ' ' || e.last_name AS actor_name, e.role AS actor_role
         FROM payroll_approvals pa LEFT JOIN employees e ON e.id = pa.actor_id
         WHERE pa.payroll_period_id = $1 ORDER BY pa.created_at DESC, pa.id DESC`,
        [id]
      ),
    ]);
    return res.json({ success: true, data: { period, records: records.rows, approvals: approvals.rows } });
  } catch (err) { return respondError(res, err); }
}

export async function submitPayrollPeriod(req, res) {
  let client;
  try {
    const id = safeId(req.params.id, 'payroll period ID');
    const remarks = String(req.body?.remarks || '').trim() || 'Submitted to Super Admin for approval.';
    client = await pool.connect();
    await client.query('BEGIN');
    const period = (await client.query('SELECT * FROM payroll_periods WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!period) fail('Payroll period not found.', 404);
    if (!['DRAFT', 'REJECTED'].includes(period.status)) fail(`Only draft or rejected payroll can be submitted (current status: ${period.status}).`, 409);

    const recCount = (await client.query('SELECT COUNT(*)::int AS c FROM payroll_records WHERE payroll_period_id = $1', [id])).rows[0].c;
    if (recCount === 0) fail('Generate payroll records before submitting.', 409);

    const updated = (await client.query(
      `UPDATE payroll_periods SET status = 'SUBMITTED', submitted_by = $1, submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [req.user.id, id]
    )).rows[0];
    await client.query('INSERT INTO payroll_approvals (payroll_period_id, actor_id, action, remarks) VALUES ($1,$2,$3,$4)', [id, req.user.id, 'SUBMIT', remarks]);
    await audit(client, req.user.id, 'SUBMIT_PAYROLL', 'payroll_period', id, period, updated);

    const admins = (await client.query("SELECT id FROM employees WHERE role = 'SUPER_ADMIN' AND is_active = true")).rows;
    for (const admin of admins) {
      await client.query(
        "INSERT INTO notifications (recipient_id, title, message, category) VALUES ($1,$2,$3,'ANNOUNCEMENT')",
        [admin.id, `Payroll Submitted (${period.year}-${String(period.month).padStart(2, '0')})`, `HR submitted monthly payroll for ${period.year}-${String(period.month).padStart(2, '0')} (${recCount} employees). Review in Payroll Approval.`]
      );
    }
    await client.query('COMMIT');
    return res.json({ success: true, message: 'Payroll submitted to Super Admin for approval.', data: updated });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, err);
  } finally { client?.release(); }
}

export async function approvePayrollPeriod(req, res) {
  let client;
  try {
    const id = safeId(req.params.id, 'payroll period ID');
    const remarks = String(req.body?.remarks || '').trim() || 'Approved by Super Admin.';
    client = await pool.connect();
    await client.query('BEGIN');
    const period = (await client.query('SELECT * FROM payroll_periods WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!period) fail('Payroll period not found.', 404);
    if (period.status !== 'SUBMITTED') fail(`Only submitted payroll can be approved (current status: ${period.status}).`, 409);
    // Segregation of duties: the preparer/submitter cannot approve the same payroll.
    if (period.prepared_by === req.user.id || period.submitted_by === req.user.id) {
      fail('Segregation of duties: the same user who prepared or submitted this payroll cannot approve it.', 403);
    }

    const updated = (await client.query(
      `UPDATE payroll_periods SET status = 'APPROVED', approved_by = $1, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [req.user.id, id]
    )).rows[0];
    await client.query('INSERT INTO payroll_approvals (payroll_period_id, actor_id, action, remarks) VALUES ($1,$2,$3,$4)', [id, req.user.id, 'APPROVE', remarks]);
    await audit(client, req.user.id, 'APPROVE_PAYROLL', 'payroll_period', id, period, updated);

    const recs = (await client.query('SELECT employee_id FROM payroll_records WHERE payroll_period_id = $1', [id])).rows;
    const label = `${period.year}-${String(period.month).padStart(2, '0')}`;
    for (const r of recs) {
      await client.query(
        "INSERT INTO notifications (recipient_id, title, message, category) VALUES ($1,$2,$3,'ANNOUNCEMENT')",
        [r.employee_id, `Payslip Ready (${label})`, `Your monthly salary for ${label} has been approved. View and download your payslip in Payslips.`]
      );
    }
    await client.query('COMMIT');
    return res.json({ success: true, message: `Payroll ${label} approved. Ready for payment authorization.`, data: updated });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, err);
  } finally { client?.release(); }
}

export async function rejectPayrollPeriod(req, res) {
  let client;
  try {
    const id = safeId(req.params.id, 'payroll period ID');
    const remarks = String(req.body?.remarks || '').trim();
    if (remarks.length < 5 || remarks.length > 1000) fail('Provide a rejection reason of 5–1000 characters.');
    client = await pool.connect();
    await client.query('BEGIN');
    const period = (await client.query('SELECT * FROM payroll_periods WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!period) fail('Payroll period not found.', 404);
    if (period.status !== 'SUBMITTED') fail(`Only submitted payroll can be rejected (current status: ${period.status}).`, 409);

    const updated = (await client.query(
      `UPDATE payroll_periods SET status = 'REJECTED', rejected_by = $1, rejected_at = CURRENT_TIMESTAMP, rejection_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [req.user.id, remarks, id]
    )).rows[0];
    await client.query('INSERT INTO payroll_approvals (payroll_period_id, actor_id, action, remarks) VALUES ($1,$2,$3,$4)', [id, req.user.id, 'REJECT', remarks]);
    await audit(client, req.user.id, 'REJECT_PAYROLL', 'payroll_period', id, period, updated);
    if (period.submitted_by) {
      await client.query(
        "INSERT INTO notifications (recipient_id, title, message, category) VALUES ($1,$2,$3,'ANNOUNCEMENT')",
        [period.submitted_by, `Payroll Rejected (${period.year}-${String(period.month).padStart(2, '0')})`, `Super Admin rejected the payroll submission. Reason: ${remarks}`]
      );
    }
    await client.query('COMMIT');
    return res.json({ success: true, message: 'Payroll rejected and returned to HR.', data: updated });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, err);
  } finally { client?.release(); }
}

// ---------------------------------------------------------------------------
// 4. Automatic Bulk Salary Payment Authorization, Tracking, Retry & Webhooks
// ---------------------------------------------------------------------------
export async function authorizePayrollPayments(req, res) {
  let client;
  try {
    const id = safeId(req.params.id, 'payroll period ID');
    if (req.body?.confirm !== true) fail('Explicit payment authorization confirmation is required.');
    const remarks = String(req.body?.remarks || '').trim() || 'Authorized bulk salary payment.';

    client = await pool.connect();
    await client.query('BEGIN');
    const period = (await client.query('SELECT * FROM payroll_periods WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!period) fail('Payroll period not found.', 404);
    if (period.status !== 'APPROVED') fail(`Payments can only be authorized for an APPROVED payroll (current status: ${period.status}).`, 409);

    const activeProviderRow = (await client.query('SELECT provider FROM payment_provider_settings WHERE is_active = true LIMIT 1')).rows[0];
    const provider = req.body?.provider ? String(req.body.provider).toUpperCase() : (activeProviderRow?.provider || 'RAZORPAYX');
    if (!['RAZORPAYX', 'CASHFREE'].includes(provider)) fail('Provider must be RAZORPAYX or CASHFREE.');

    const records = (await client.query(
      `SELECT pr.*, ba.id AS bank_account_id
       FROM payroll_records pr
       LEFT JOIN employee_bank_accounts ba ON ba.employee_id = pr.employee_id
       WHERE pr.payroll_period_id = $1 ORDER BY pr.id`,
      [id]
    )).rows;
    if (!records.length) fail('No payroll records found for this period.', 409);

    const missingBank = records.filter(r => Number(r.final_payable_paise) > 0 && !r.bank_account_id);
    if (missingBank.length > 0) {
      fail(`Bank account details are missing for: ${missingBank.map(r => `${r.employee_name} (${r.employee_code})`).join(', ')}. Register bank details before authorizing payments.`, 400);
    }

    const createdPayments = [];
    for (const r of records) {
      const idempotencyKey = `knooviq-pay-${period.year}${String(period.month).padStart(2, '0')}-rec-${r.id}-v1`;
      const inserted = await client.query(
        `INSERT INTO salary_payments (payroll_period_id, payroll_record_id, employee_id, bank_account_id, amount_paise, idempotency_key, provider, status, authorized_by, authorized_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,CURRENT_TIMESTAMP)
         ON CONFLICT (payroll_record_id) DO NOTHING
         RETURNING *`,
        [id, r.id, r.employee_id, r.bank_account_id, r.final_payable_paise, idempotencyKey, provider, req.user.id]
      );
      if (inserted.rows[0]) createdPayments.push(inserted.rows[0]);
    }

    const updated = (await client.query(
      `UPDATE payroll_periods SET status = 'PROCESSING', authorized_by = $1, authorized_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [req.user.id, id]
    )).rows[0];
    await client.query('INSERT INTO payroll_approvals (payroll_period_id, actor_id, action, remarks) VALUES ($1,$2,$3,$4)', [id, req.user.id, 'AUTHORIZE', remarks]);
    await audit(client, req.user.id, 'AUTHORIZE_PAYMENTS', 'payroll_period', id, period, { period: updated, provider, payment_count: createdPayments.length });
    await client.query('COMMIT');

    // Trigger asynchronous background worker
    enqueuePayrollPayments(id);

    return res.status(202).json({
      success: true,
      message: `Authorized ${createdPayments.length} salary payment(s) via ${provider}. Background transfers started.`,
      data: { period: updated, payments_queued: createdPayments.length },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, err);
  } finally { client?.release(); }
}

export async function listSalaryPayments(req, res) {
  try {
    const params = [];
    let where = 'WHERE 1=1';
    if (req.query.payroll_period_id) {
      params.push(safeId(req.query.payroll_period_id, 'payroll period ID'));
      where += ` AND sp.payroll_period_id = $${params.length}`;
    }
    if (req.query.status && req.query.status !== 'ALL') {
      params.push(String(req.query.status).toUpperCase());
      where += ` AND sp.status = $${params.length}`;
    }
    const rows = (await query(
      `SELECT sp.*, pr.employee_name, pr.employee_code, pr.department_name, pp.year, pp.month,
              ba.bank_name, ba.account_number_masked, ba.ifsc_code,
              auth.first_name || ' ' || auth.last_name AS authorized_by_name
       FROM salary_payments sp
       JOIN payroll_records pr ON pr.id = sp.payroll_record_id
       JOIN payroll_periods pp ON pp.id = sp.payroll_period_id
       LEFT JOIN employee_bank_accounts ba ON ba.id = sp.bank_account_id
       LEFT JOIN employees auth ON auth.id = sp.authorized_by
       ${where}
       ORDER BY sp.created_at DESC, sp.id DESC`,
      params
    )).rows;
    return res.json({ success: true, data: rows });
  } catch (err) { return respondError(res, err); }
}

export async function getPaymentTransactions(req, res) {
  try {
    const id = safeId(req.params.id, 'payment ID');
    const rows = (await query('SELECT * FROM payment_transactions WHERE salary_payment_id = $1 ORDER BY created_at DESC, id DESC', [id])).rows;
    return res.json({ success: true, data: rows });
  } catch (err) { return respondError(res, err); }
}

export async function retrySalaryPayment(req, res) {
  let client;
  try {
    const id = safeId(req.params.id, 'payment ID');
    const existing = (await query('SELECT * FROM salary_payments WHERE id = $1', [id])).rows[0];
    if (!existing) fail('Salary payment not found.', 404);
    if (existing.status === 'SUCCESS') fail('This salary payment has already succeeded and cannot be retried.', 409);
    if (existing.status === 'PENDING' || existing.status === 'PROCESSING') fail('This salary payment is already in progress.', 409);

    // Check actual provider status BEFORE allowing a retry to prevent duplicate bank transfers.
    const adapter = createPaymentAdapter(existing.provider);
    if (existing.provider_payout_id) {
      if (!adapter.isConfigured()) fail('The payment provider is unavailable. Confirm payout status before retrying.', 503);
      const liveStatus = await adapter.fetchPayoutStatus({ providerPayoutId: existing.provider_payout_id }).catch(() => null);
      if (!liveStatus) fail('Could not confirm the previous payout status. Please retry the status check later.', 503);
      await query(
        `INSERT INTO payment_transactions (salary_payment_id, provider, idempotency_key, request_type, provider_reference_id, status, http_status, response_payload)
         VALUES ($1,$2,$3,'STATUS_CHECK',$4,$5,$6,$7)`,
        [existing.id, existing.provider, existing.idempotency_key, liveStatus.providerPayoutId, liveStatus.status, liveStatus.httpStatus || 200, JSON.stringify(liveStatus.payload || {})]
      );
      if (liveStatus.status !== 'FAILED') {
        await query(
          `UPDATE salary_payments SET status = $1::varchar, provider_utr = COALESCE($2, provider_utr), failure_reason = NULL,
             completed_at = CASE WHEN $1 = 'SUCCESS' THEN CURRENT_TIMESTAMP ELSE completed_at END, updated_at = CURRENT_TIMESTAMP
           WHERE id = $3 AND status = 'FAILED' AND idempotency_key = $4`,
          [liveStatus.status, liveStatus.providerUtr, existing.id, existing.idempotency_key]
        );
        return res.status(409).json({
          success: false,
          error: `Provider reports this payout is already ${liveStatus.status}. Retry blocked to prevent duplicate transfer.`,
        });
      }
    }

    client = await pool.connect();
    await client.query('BEGIN');
    const locked = (await client.query('SELECT * FROM salary_payments WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!locked || locked.status !== 'FAILED' || locked.idempotency_key !== existing.idempotency_key) {
      fail('Payment changed while checking its status. Refresh before retrying.', 409);
    }

    const nextKey = locked.provider_payout_id
      ? `knooviq-pay-rec-${locked.payroll_record_id}-v${Number(locked.attempt_count) + 1}`
      : locked.idempotency_key;
    const updated = (await client.query(
      `UPDATE salary_payments SET status = 'PENDING', idempotency_key = $1, failure_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [nextKey, id]
    )).rows[0];
    await audit(client, req.user.id, 'RETRY_PAYMENT', 'salary_payment', id, locked, updated);
    await client.query('COMMIT');

    enqueuePayrollPayments(locked.payroll_period_id);
    return res.status(202).json({ success: true, message: 'Payment queued for retry.', data: updated });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, err);
  } finally { client?.release(); }
}

export async function handlePaymentWebhook(req, res) {
  try {
    const provider = String(req.params.provider || '').toUpperCase();
    if (!['RAZORPAYX', 'CASHFREE'].includes(provider)) {
      return res.status(400).json({ success: false, error: 'Unsupported provider.' });
    }
    const adapter = createPaymentAdapter(provider);
    if (!Buffer.isBuffer(req.rawBody) || !adapter.verifyWebhookSignature(req.rawBody, req.headers)) {
      return res.status(401).json({ success: false, error: 'Invalid webhook signature.' });
    }
    const parsed = adapter.parseWebhookEvent(req.body);
    const result = await transaction(async client => {
      const { rows: [log] } = await client.query(
        `INSERT INTO payment_webhook_logs (provider, event_id, event_type, signature_valid, payload)
         VALUES ($1, $2, $3, true, $4)
         ON CONFLICT (provider, event_id) WHERE event_id IS NOT NULL DO UPDATE
         SET event_type = EXCLUDED.event_type, signature_valid = true, payload = EXCLUDED.payload, processing_error = NULL
         WHERE NOT payment_webhook_logs.signature_valid OR NOT payment_webhook_logs.processed
         RETURNING id`,
        [provider, parsed.eventId, parsed.eventType, JSON.stringify(req.body)]
      );
      if (!log) return null;

      const reconciled = await reconcileWebhookEvent(client, provider, parsed);
      await client.query('UPDATE payment_webhook_logs SET processed = true WHERE id = $1', [log.id]);
      return reconciled;
    });
    return res.json(result ? { success: true, data: result } : { success: true, message: 'Duplicate webhook event ignored.' });
  } catch (err) { return respondError(res, err); }
}

// ---------------------------------------------------------------------------
// 5. Payment Provider Settings (Super Admin only; secrets stay in env vars)
// ---------------------------------------------------------------------------
export async function getProviderSettings(req, res) {
  try {
    const rows = (await query('SELECT provider, is_active, mode, account_identifier, webhook_url, updated_at FROM payment_provider_settings ORDER BY provider')).rows;
    const enriched = rows.map(row => ({ ...row, ...providerConfigStatus(row.provider) }));
    return res.json({ success: true, data: enriched });
  } catch (err) { return respondError(res, err); }
}

export async function updateProviderSettings(req, res) {
  let client;
  try {
    const provider = String(req.body?.provider || '').toUpperCase();
    if (!['RAZORPAYX', 'CASHFREE'].includes(provider)) fail('Provider must be RAZORPAYX or CASHFREE.');
    const mode = String(req.body?.mode || 'TEST').toUpperCase();
    if (!['TEST', 'LIVE'].includes(mode)) fail('Mode must be TEST or LIVE.');
    const account_identifier = String(req.body?.account_identifier || '').trim() || null;
    const webhook_url = String(req.body?.webhook_url || '').trim() || null;

    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('UPDATE payment_provider_settings SET is_active = false');
    const saved = (await client.query(
      `INSERT INTO payment_provider_settings (provider, is_active, mode, account_identifier, webhook_url, updated_by, updated_at)
       VALUES ($1, true, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (provider)
       DO UPDATE SET is_active = true, mode = EXCLUDED.mode, account_identifier = EXCLUDED.account_identifier,
         webhook_url = EXCLUDED.webhook_url, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
       RETURNING provider, is_active, mode, account_identifier, webhook_url, updated_at`,
      [provider, mode, account_identifier, webhook_url, req.user.id]
    )).rows[0];
    await audit(client, req.user.id, 'UPDATE_PROVIDER_SETTINGS', 'payment_provider', 0, null, saved);
    await client.query('COMMIT');
    return res.json({ success: true, message: `${provider} set as active payment provider (${mode}).`, data: { ...saved, ...providerConfigStatus(provider) } });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, err);
  } finally { client?.release(); }
}

// ---------------------------------------------------------------------------
// 6. Payroll Reports
// ---------------------------------------------------------------------------
export async function exportPayrollReport(req, res) {
  try {
    const period = reportPeriod({ year: req.query.year, month: req.query.month });
    const format = String(req.query.format || 'xlsx').toLowerCase();
    if (!['csv', 'xlsx'].includes(format)) fail('Export format must be csv or xlsx.');

    const pp = (await query('SELECT * FROM payroll_periods WHERE year = $1 AND month = $2', [period.year, period.month])).rows[0];
    if (!pp) fail(`No payroll found for ${period.prefix}.`, 404);

    const rows = (await query(
      `SELECT pr.*, ba.bank_name, ba.account_number_masked, sp.status AS payment_status, sp.provider_utr
       FROM payroll_records pr
       LEFT JOIN employee_bank_accounts ba ON ba.employee_id = pr.employee_id
       LEFT JOIN salary_payments sp ON sp.payroll_record_id = pr.id
       WHERE pr.payroll_period_id = $1 ORDER BY pr.employee_name, pr.id`,
      [pp.id]
    )).rows;

    const headers = ['Employee ID', 'Employee Name', 'Department', 'Monthly Salary (INR)', 'Working Days', 'Present Days', 'Absent Days', 'Daily Salary (INR)', 'Absent Deduction (INR)', 'Final Payable (INR)', 'Bank Account', 'Payment Status', 'UTR'];
    const dataRows = rows.map(r => [
      r.employee_code,
      r.employee_name,
      r.department_name,
      Number((Number(r.monthly_salary_paise) / 100).toFixed(2)),
      30,
      Number(r.present_days),
      Number(r.absent_days),
      Number((Number(r.daily_salary_paise) / 100).toFixed(2)),
      Number((Number(r.absent_deduction_paise) / 100).toFixed(2)),
      Number((Number(r.final_payable_paise) / 100).toFixed(2)),
      r.account_number_masked || 'Not registered',
      r.payment_status || pp.status,
      r.provider_utr || '',
    ]);

    const fileBase = `payroll-${period.prefix}`;
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`);
      return res.send(csvExport(headers, dataRows));
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`);
    return res.send(xlsxExport(headers, dataRows, `Payroll ${period.prefix}`));
  } catch (err) { return respondError(res, err); }
}
