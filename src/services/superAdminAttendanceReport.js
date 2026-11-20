import { dateKey } from './superAdminRequestPolicy.js';
import { plannedRequestForDate, resolveAttendanceStatus } from './plannedAttendance.js';
export const indiaDate = (value = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
export function reportPeriod(input) {
  const year = Number(input.year), month = Number(input.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) throw Object.assign(new Error('Choose a valid year and month.'), { status: 400 });
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  return { year, month, first: `${prefix}-01`, last: `${prefix}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`, prefix };
}
export function buildMonthlyReport({ employees, attendances, breaks = [], holidays, requests = [] }, period, employeeId, now = new Date()) {
  const eligible = employees.filter(e => e.is_active && e.role !== 'SUPER_ADMIN');
  if (employeeId && !eligible.some(e => e.id === employeeId)) throw Object.assign(new Error('Employee not found.'), { status: 404 });
  const selected = employeeId ? eligible.filter(e => e.id === employeeId) : eligible;
  const attMap = new Map(attendances.map(a => [`${a.employee_id}:${dateKey(a.work_date)}`, a]));
  const holidayMap = new Map(holidays.map(h => [dateKey(h.holiday_date), h]));
  const breakMap = new Map();
  for (const b of breaks) { if (!breakMap.has(b.attendance_id)) breakMap.set(b.attendance_id, []); breakMap.get(b.attendance_id).push(b); }
  const rows = [];
  const today = indiaDate(now);
  for (const employee of selected) {
    for (let day = 1; day <= Number(period.last.slice(-2)); day++) {
      const workDate = `${period.prefix}-${String(day).padStart(2, '0')}`;
      if (employee.joining_date && workDate < dateKey(employee.joining_date)) continue;
      const attendance = attMap.get(`${employee.id}:${workDate}`);
      const planned = plannedRequestForDate(requests, employee.id, workDate);
      const status=resolveAttendanceStatus({attendance,holiday:holidayMap.get(workDate),planned,workDate,today});
      let work = attendance?.total_work_minutes || 0, rest = attendance?.total_break_minutes || 0;
      if (attendance?.check_in && ['CHECKED_IN', 'ON_BREAK'].includes(attendance.current_state)) {
        rest = (breakMap.get(attendance.id) || []).reduce((sum, b) => sum + Math.max(0, Math.floor(((b.break_end ? new Date(b.break_end) : now) - new Date(b.break_start)) / 60000)), 0);
        work = Math.max(0, Math.floor((now - new Date(attendance.check_in)) / 60000) - rest);
      }
      rows.push({ work_date: workDate, employee_id: employee.id, employee_code: employee.employee_id, employee_name: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(), department: employee.department_name || '', status, check_in: attendance?.check_in || null, check_out: attendance?.check_out || null, total_work_minutes: work, total_break_minutes: rest, mode: attendance?.mode || attendance?.work_mode || (attendance?.check_in ? 'Not recorded' : '—'), notes: attendance?.notes || holidayMap.get(workDate)?.name || '' });
    }
  }
  rows.sort((a, b) => a.work_date.localeCompare(b.work_date) || a.employee_name.localeCompare(b.employee_name) || a.employee_id - b.employee_id);
  return { rows, employees: eligible.map(e => ({ id: e.id, code: e.employee_id, name: `${e.first_name || ''} ${e.last_name || ''}`.trim() })), year: period.year, month: period.month, total: rows.length, timezone: 'Asia/Kolkata' };
}
