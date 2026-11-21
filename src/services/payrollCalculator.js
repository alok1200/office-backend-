import { dateKey } from './superAdminRequestPolicy.js';
import { plannedRequestForDate, resolveAttendanceStatus } from './plannedAttendance.js';
import { indiaDate, reportPeriod } from './superAdminAttendanceReport.js';

export const WORKING_DAYS = 30;

/**
 * Parse a rupee amount (number or string like "30000" or "30000.50") into integer paise.
 * Avoids binary floating-point rounding drift.
 */
export function rupeesToPaise(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) throw Object.assign(new Error('Salary must be a positive amount.'), { status: 400 });
    return Math.round(input * 100);
  }
  const str = String(input ?? '').trim().replaceAll(',', '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(str)) throw Object.assign(new Error('Enter a valid salary amount with up to 2 decimal places.'), { status: 400 });
  const [whole, frac = ''] = str.split('.');
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(paise) || paise <= 0) throw Object.assign(new Error('Salary must be a positive amount.'), { status: 400 });
  return paise;
}

export function paiseToRupees(paise) {
  return Number(paise || 0) / 100;
}

export function formatINR(paise) {
  const value = paiseToRupees(paise);
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Exact fixed-30-day salary calculation in integer paise using BigInt rational arithmetic.
 * Daily Salary = Monthly Salary / 30
 * Absent Deduction = Daily Salary * Absent Days
 * Final Salary = Monthly Salary - Absent Deduction
 */
export function calculateSalaryBreakdown(monthlySalaryPaise, rawAbsentDays) {
  const monthly = BigInt(monthlySalaryPaise);
  if (monthly <= 0n) throw Object.assign(new Error('Monthly salary must be greater than zero.'), { status: 400 });

  // Clamp absent days to [0, 30] in 0.5-day increments (half-day precision).
  const clampedAbsent = Math.max(0, Math.min(WORKING_DAYS, Number(rawAbsentDays || 0)));
  const absentHalves = Math.round(clampedAbsent * 2); // 0..60
  const absentDays = absentHalves / 2;
  const presentDays = (WORKING_DAYS * 2 - absentHalves) / 2;

  // Daily salary rounded half-up to nearest paisa.
  const dailySalaryPaise = Number((monthly + 15n) / 30n);
  // Exact absent deduction: (monthly * absentHalves) / 60, rounded half-up to nearest paisa.
  const absentDeductionPaise = Number((monthly * BigInt(absentHalves) + 30n) / 60n);
  const finalPayablePaise = Number(monthly) - absentDeductionPaise;

  return {
    monthly_salary_paise: Number(monthly),
    working_days: WORKING_DAYS,
    present_days: presentDays,
    absent_days: absentDays,
    daily_salary_paise: dailySalaryPaise,
    absent_deduction_paise: absentDeductionPaise,
    final_payable_paise: finalPayablePaise,
  };
}

/**
 * Resolve the applicable monthly salary for an employee for a given payroll period.
 * Uses the latest salary history entry with effective_from <= period.last,
 * falling back to employee_salaries if effective_from <= period.last.
 */
export function resolveApplicableSalary(employeeId, periodLastDate, salaryHistory = [], currentSalaries = []) {
  const eligibleHistory = salaryHistory
    .filter(h => h.employee_id === employeeId && dateKey(h.effective_from) <= periodLastDate)
    .sort((a, b) => dateKey(b.effective_from).localeCompare(dateKey(a.effective_from)) || b.id - a.id);
  if (eligibleHistory.length > 0) {
    return {
      monthly_salary_paise: Number(eligibleHistory[0].updated_salary_paise),
      effective_from: dateKey(eligibleHistory[0].effective_from),
    };
  }
  const current = currentSalaries.find(s => s.employee_id === employeeId && dateKey(s.effective_from) <= periodLastDate);
  if (current) {
    return {
      monthly_salary_paise: Number(current.monthly_salary_paise),
      effective_from: dateKey(current.effective_from),
    };
  }
  return null;
}

/**
 * Build attendance-integrated monthly payroll preview for all eligible employees.
 * Respects approved paid leave, weekly offs, company holidays, and detects incomplete/unapproved attendance blockers.
 */
export function buildPayrollPreview({
  employees,
  attendances,
  holidays,
  requests,
  salaryHistory,
  currentSalaries,
  bankAccounts = [],
}, periodInput, now = new Date()) {
  const period = reportPeriod(periodInput);
  const today = indiaDate(now);
  const daysInMonth = Number(period.last.slice(-2));

  // Eligible employees: active non-SUPER_ADMIN employees who joined on or before the end of the payroll period.
  const eligible = employees
    .filter(e => e.is_active && e.role !== 'SUPER_ADMIN' && (!e.joining_date || dateKey(e.joining_date) <= period.last))
    .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`) || a.id - b.id);

  const attMap = new Map(attendances.map(a => [`${a.employee_id}:${dateKey(a.work_date)}`, a]));
  const holidayMap = new Map(holidays.map(h => [dateKey(h.holiday_date), h]));
  const bankMap = new Map(bankAccounts.map(b => [b.employee_id, b]));
  const approvedRequests = requests.filter(r => r.status === 'APPROVED');
  const pendingRequests = requests.filter(r => r.status === 'PENDING' && dateKey(r.start_date) <= period.last && dateKey(r.end_date) >= period.first);

  const blockers = [];
  if (period.first > today) {
    blockers.push(`Payroll period ${period.prefix} is in the future and has no completed attendance.`);
  }
  if (pendingRequests.length > 0) {
    blockers.push(`${pendingRequests.length} unapproved (pending) leave/attendance request(s) exist for ${period.prefix}. Approve or reject them before processing payroll.`);
  }

  const rows = [];
  let totalMonthlyPaise = 0;
  let totalPresentDays = 0;
  let totalAbsentDays = 0;
  let totalDeductionPaise = 0;
  let totalPayablePaise = 0;

  for (const emp of eligible) {
    const empName = `${emp.first_name || ''} ${emp.last_name || ''}`.trim();
    const joinDate = emp.joining_date ? dateKey(emp.joining_date) : null;

    let rawAbsent = 0;
    let presentCount = 0;
    let halfDayCount = 0;
    let paidLeaveCount = 0;
    let holidayCount = 0;
    let weeklyOffCount = 0;
    let futureCount = 0;
    let openWorkdayDates = [];

    for (let day = 1; day <= daysInMonth; day++) {
      const workDate = `${period.prefix}-${String(day).padStart(2, '0')}`;
      if (joinDate && workDate < joinDate) continue;

      const attendance = attMap.get(`${emp.id}:${workDate}`);
      if (attendance && ['CHECKED_IN', 'ON_BREAK'].includes(attendance.current_state)) {
        openWorkdayDates.push(workDate);
      }

      const holiday = holidayMap.get(workDate);
      const planned = plannedRequestForDate(approvedRequests, emp.id, workDate);
      const status = resolveAttendanceStatus({ attendance, holiday, planned, workDate, today });

      if (status === 'ABSENT') {
        rawAbsent += 1;
      } else if (status === 'HALF_DAY') {
        rawAbsent += 0.5;
        halfDayCount += 1;
      } else if (status === 'PRESENT' || status === 'WFH' || status === 'OFFICIAL_WORK_OUTSIDE') {
        presentCount += 1;
      } else if (status === 'LEAVE') {
        paidLeaveCount += 1;
      } else if (status === 'HOLIDAY') {
        holidayCount += 1;
      } else if (status === 'WEEKLY_OFF') {
        weeklyOffCount += 1;
      } else if (status === 'FUTURE' || status === 'NOT_CHECKED_IN') {
        futureCount += 1;
      }
    }

    if (openWorkdayDates.length > 0) {
      blockers.push(`${empName} (${emp.employee_id}) has an incomplete/open attendance punch on ${openWorkdayDates.join(', ')}.`);
    }
    if (futureCount > 0 && period.last >= today) {
      blockers.push(`Attendance for ${period.prefix} is incomplete (${futureCount} day(s) not yet completed for ${empName}).`);
    }

    const salary = resolveApplicableSalary(emp.id, period.last, salaryHistory, currentSalaries);
    if (!salary) {
      blockers.push(`${empName} (${emp.employee_id}) has no active monthly salary configured on or before ${period.last}.`);
    }

    const breakdown = salary
      ? calculateSalaryBreakdown(salary.monthly_salary_paise, rawAbsent)
      : {
          monthly_salary_paise: 0,
          working_days: WORKING_DAYS,
          present_days: Math.max(0, WORKING_DAYS - Math.min(WORKING_DAYS, rawAbsent)),
          absent_days: Math.min(WORKING_DAYS, rawAbsent),
          daily_salary_paise: 0,
          absent_deduction_paise: 0,
          final_payable_paise: 0,
        };

    const bank = bankMap.get(emp.id) || null;
    totalMonthlyPaise += breakdown.monthly_salary_paise;
    totalPresentDays += breakdown.present_days;
    totalAbsentDays += breakdown.absent_days;
    totalDeductionPaise += breakdown.absent_deduction_paise;
    totalPayablePaise += breakdown.final_payable_paise;

    rows.push({
      employee_id: emp.id,
      employee_name: empName,
      employee_code: emp.employee_id,
      department_name: emp.department_name || '',
      designation: emp.designation || '',
      salary_configured: Boolean(salary),
      salary_effective_from: salary?.effective_from || null,
      bank_configured: Boolean(bank),
      bank_account_masked: bank?.account_number_masked || null,
      bank_name: bank?.bank_name || null,
      ...breakdown,
      attendance_summary: {
        recorded_present: presentCount,
        half_days: halfDayCount,
        paid_leaves: paidLeaveCount,
        holidays: holidayCount,
        weekly_offs: weeklyOffCount,
        unpaid_absent: rawAbsent,
        incomplete_days: futureCount,
      },
    });
  }

  // Deduplicate period-level incomplete message if repeated across employees
  const uniqueBlockers = [...new Set(blockers)];

  return {
    period,
    can_process: uniqueBlockers.length === 0 && rows.length > 0,
    blockers: uniqueBlockers,
    totals: {
      total_employees: rows.length,
      total_monthly_salary_paise: totalMonthlyPaise,
      total_present_days: Math.round(totalPresentDays * 100) / 100,
      total_absent_days: Math.round(totalAbsentDays * 100) / 100,
      total_deduction_paise: totalDeductionPaise,
      total_payable_paise: totalPayablePaise,
    },
    records: rows,
  };
}
