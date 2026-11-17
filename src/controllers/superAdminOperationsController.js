import { pool, query } from '../db/index.js';
import { calculateRequest, dateKey } from '../services/superAdminRequestPolicy.js';
import { buildMonthlyReport, reportPeriod } from '../services/superAdminAttendanceReport.js';
import { planDecision } from '../services/superAdminDecision.js';
import { csvExport, xlsxExport } from '../utils/reportExport.js';
const errorResponse = (res, error) => res.status(error.status || 500).json({
  success: false,
  error: error.status ? error.message : 'Could not complete the operation. Please retry.'
});
export async function pendingApprovals(req, res) {
  try {
    let rows;
    rows = (await query("SELECT r.*, e.first_name, e.last_name, e.employee_id AS emp_code, e.department_name FROM requests r JOIN employees e ON e.id = r.employee_id WHERE r.status = 'PENDING' ORDER BY r.submission_date, r.id")).rows;
    const holidays = (await query('SELECT holiday_date FROM holidays')).rows;
    const data = rows.map(row => {
      let reviewDays = null;
      try {
        reviewDays = calculateRequest({
          category: row.metadata?.category || 'OFFICIAL',
          start_date: dateKey(row.start_date),
          end_date: dateKey(row.end_date),
          half_day: row.metadata?.half_day === true
        }, holidays).days;
      } catch {/* Invalid legacy dates require review; never invent a duration. */}
      return {
        ...row,
        review_days: reviewDays
      };
    });
    res.json({
      success: true,
      data
    });
  } catch (error) {
    errorResponse(res, error);
  }
}
export async function reviewRequest(req, res) {
  let client;
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('Invalid request ID.'), {
      status: 400
    });
    let reviewed;
    const now = new Date();
    client = await pool.connect();
    await client.query('BEGIN');
    const identity = (await client.query('SELECT employee_id FROM requests WHERE id = $1', [id])).rows[0];
    if (!identity) throw Object.assign(new Error('Request not found.'), {
      status: 404
    });
    // Same employee-first lock order as request submission and allowance checks.
    await client.query('SELECT id FROM employees WHERE id = $1 FOR UPDATE', [identity.employee_id]);
    const request = (await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
    const requests = (await client.query('SELECT * FROM requests WHERE employee_id = $1', [identity.employee_id])).rows;
    const holidays = (await client.query('SELECT holiday_date FROM holidays')).rows;
    const attendance = (await client.query('SELECT * FROM attendances WHERE employee_id = $1 AND work_date = $2 FOR UPDATE', [identity.employee_id, dateKey(request.start_date)])).rows[0];
    const breaks = attendance ? (await client.query('SELECT * FROM attendance_breaks WHERE attendance_id = $1', [attendance.id])).rows : [];
    const plan = planDecision(request, req.body, {
      requests,
      holidays,
      attendance,
      breaks
    }, now);
    if (plan.attendance) {
      const a = plan.attendance;
      const corrected = await client.query(`INSERT INTO attendances (employee_id, work_date, check_in, check_out, current_state, status, total_work_minutes, total_break_minutes, notes, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (employee_id, work_date) DO UPDATE SET check_in=EXCLUDED.check_in, check_out=EXCLUDED.check_out, current_state=EXCLUDED.current_state, status=EXCLUDED.status, total_work_minutes=EXCLUDED.total_work_minutes, total_break_minutes=EXCLUDED.total_break_minutes, notes=EXCLUDED.notes, updated_at=EXCLUDED.updated_at WHERE attendances.current_state NOT IN ('CHECKED_IN','ON_BREAK') RETURNING id`, [a.employee_id, a.work_date, a.check_in, a.check_out, a.current_state, a.status, a.total_work_minutes, a.total_break_minutes, a.notes, a.updated_at]);
      if (!corrected.rowCount) throw Object.assign(new Error('The employee has an active workday. Refresh before regularizing.'), {
        status: 409
      });
    }
    reviewed = (await client.query('UPDATE requests SET status=$1, decision_by=$2, decision_date=$3, decision_remarks=$4, metadata=$5 WHERE id=$6 RETURNING *', [plan.status, req.user.id, now.toISOString(), plan.note, JSON.stringify(plan.metadata), id])).rows[0];
    await client.query('INSERT INTO application_audit_log (application_id, actor_id, action, old_status, new_status, remark) VALUES ($1,$2,$3,$4,$5,$6)', [id, req.user.id, plan.status === 'APPROVED' ? 'approve' : 'reject', 'PENDING', plan.status, JSON.stringify({
      note: plan.note,
      correction: plan.metadata.correction || null
    })]);
    // The response and its private notification commit together, exactly once per decision.
    const title = `Request #${id} ${plan.status.toLowerCase()}`;
    const message = `Your ${request.request_type.replaceAll('_', ' ').toLowerCase()} request for ${dateKey(request.start_date)} to ${dateKey(request.end_date)} was ${plan.status.toLowerCase()}.${plan.note ? ' Response: ' + plan.note : ''}`;
    await client.query("INSERT INTO notifications (recipient_id, title, message, category, is_read, created_at) VALUES ($1,$2,$3,'REQUEST',false,$4)", [identity.employee_id, title, message, now.toISOString()]);
    await client.query('COMMIT');
    res.json({
      success: true,
      data: reviewed,
      message: `Request ${reviewed.status.toLowerCase()}.`
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    errorResponse(res, error);
  } finally {
    client?.release();
  }
}
async function loadReport(req) {
  const period = reportPeriod(req.query);
  const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
  if (req.query.employee_id && (!Number.isSafeInteger(employeeId) || employeeId <= 0)) throw Object.assign(new Error('Choose a valid employee.'), {
    status: 400
  });
  let data;
  const results = await Promise.all([query("SELECT id, employee_id, first_name, last_name, department_name, joining_date, role, is_active FROM employees WHERE is_active = true AND role <> 'SUPER_ADMIN' ORDER BY first_name, id"), query('SELECT * FROM attendances WHERE work_date >= $1 AND work_date <= $2', [period.first, period.last]), query('SELECT b.* FROM attendance_breaks b JOIN attendances a ON a.id=b.attendance_id WHERE a.work_date >= $1 AND a.work_date <= $2', [period.first, period.last]), query('SELECT * FROM holidays WHERE holiday_date >= $1 AND holiday_date <= $2', [period.first, period.last]), query("SELECT * FROM requests WHERE status = 'APPROVED' AND request_type = 'LEAVE' AND start_date <= $2 AND end_date >= $1", [period.first, period.last])]);
  data = {
    employees: results[0].rows,
    attendances: results[1].rows,
    breaks: results[2].rows,
    holidays: results[3].rows,
    requests: results[4].rows
  };
  return buildMonthlyReport(data, period, employeeId);
}
export async function monthlyAttendance(req, res) {
  try {
    res.json({
      success: true,
      data: await loadReport(req)
    });
  } catch (error) {
    errorResponse(res, error);
  }
}
export async function exportMonthlyAttendance(req, res) {
  try {
    if (!['csv', 'xlsx'].includes(req.query.format)) throw Object.assign(new Error('Choose CSV or XLSX.'), {
      status: 400
    });
    const report = await loadReport(req);
    const clock = value => value ? new Date(value).toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit'
    }) : '';
    const text = status => status === 'FUTURE' ? '' : status.replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
    const matrix = [['Date', 'Employee', 'Employee code', 'Department', 'Status', 'In (IST)', 'Out (IST)', 'Work (minutes)', 'Break (minutes)', 'Mode', 'Notes'], ...report.rows.map(r => [r.work_date, r.employee_name, r.employee_code, r.department, text(r.status), clock(r.check_in), clock(r.check_out), r.total_work_minutes, r.total_break_minutes, r.mode, r.notes])];
    const format = req.query.format;
    res.set('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="attendance-${report.year}-${String(report.month).padStart(2, '0')}.${format}"`);
    res.send(format === 'csv' ? csvExport(matrix) : xlsxExport(matrix));
  } catch (error) {
    errorResponse(res, error);
  }
}
