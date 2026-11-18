import { indiaDate } from './superAdminAttendanceReport.js';
export const CORRECTION_WORKFLOW = 'HR_ATTENDANCE_CORRECTION';
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function validateCorrectionTicket(body, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Provide correction ticket details.');
  const employeeId = Number(body.employee_id);
  if (!Number.isSafeInteger(employeeId) || employeeId <= 0) fail('Select an employee.');
  const day = body.work_date;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0,10) !== day || day > indiaDate(now)) fail('Choose a valid attendance date that is not in the future.');
  if (!['MISSED_CHECK_IN','MISSED_CHECK_OUT','BOTH'].includes(body.correction_type)) fail('Choose the missing punch type.');
  if (typeof body.reason !== 'string' || body.reason.trim().length < 10 || body.reason.trim().length > 1000) fail('Provide a reason of 10–1000 characters.');
  const valid = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  const { check_in, check_out } = body;
  if (!valid(check_in) || !valid(check_out)) fail('Provide both proposed punch times with a timezone.');
  const start = new Date(check_in), end = new Date(check_out);
  if (start >= end || end > now || indiaDate(start) !== day || indiaDate(end) !== day) fail('Punch times must be on the selected date in IST, in order, and not in the future.');
  return { employee_id: employeeId, work_date: day, correction_type: body.correction_type, reason: body.reason.trim(), proposed_correction: { check_in: start.toISOString(), check_out: end.toISOString() } };
}
export function attendanceFingerprint(record, breaks = []) {
  return JSON.stringify({ record: record ? Object.fromEntries(['id','check_in','check_out','current_state','status','total_work_minutes','total_break_minutes','updated_at'].map(key => [key, record[key] ?? null])) : null, breaks: breaks.map(row => ({ id: row.id, break_start: row.break_start, break_end: row.break_end, duration_minutes: row.duration_minutes })).sort((a,b)=>a.id-b.id) });
}
