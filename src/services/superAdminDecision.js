import { calculateRequest, dateKey, getAllowanceBalances, requestCategories } from './superAdminRequestPolicy.js';
import { indiaDate } from './superAdminAttendanceReport.js';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function planDecision(request, payload, context, now = new Date()) {
  if (!request || request.status !== 'PENDING') fail('This request is no longer pending. Refresh the list.', 409);
  if (!['APPROVED', 'REJECTED'].includes(payload.status)) fail('Choose Approve or Reject.');
  if (typeof payload.note !== 'string' || payload.note.trim().length < 5 || payload.note.trim().length > 1000) fail('Provide a review note of 5–1000 characters.');
  const plan = { status: payload.status, note: payload.note.trim(), metadata: request.metadata || {}, attendance: null };
  if (plan.status === 'REJECTED') return plan;
  let category = request.metadata?.category;
  if (request.request_type === 'LEAVE') {
    category ||= payload.category;
    if (!['CL', 'SL', 'EL'].includes(category)) fail('Choose the leave category before approving this legacy leave request.');
  } else if (request.request_type === 'WFH') category = 'WFH';
  else if (request.request_type === 'REGULARIZATION') category = 'REGULARIZATION';
  else category = request.request_type === 'OTHER' && category === 'OFFICIAL' ? 'OFFICIAL' : null;
  const calculation = calculateRequest({ category: category || 'OFFICIAL', start_date: dateKey(request.start_date), end_date: dateKey(request.end_date), half_day: request.metadata?.half_day === true }, context.holidays);
  const balance = getAllowanceBalances(context.requests.filter(r => r.id !== request.id), calculation.year).find(b => b.category === category);
  if (balance && calculation.days > balance.remaining) fail(`Insufficient ${balance.label} balance: ${balance.remaining} day(s) available.`, 409);
  plan.metadata = { ...plan.metadata, ...calculation, category, label: category ? requestCategories[category].label : request.request_type };
  if (category !== 'REGULARIZATION') return plan;
  if (dateKey(request.start_date) !== dateKey(request.end_date)) fail('Regularization must cover one date. Reject this request and ask for separate daily requests.');
  const correction = payload.correction;
  const validTime = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  if (!correction || !validTime(correction.check_in) || !validTime(correction.check_out)) fail('Provide reviewed check-in and check-out times with a timezone.');
  const start = new Date(correction.check_in), end = new Date(correction.check_out);
  if (end <= start || end > now || indiaDate(start) !== dateKey(request.start_date) || indiaDate(end) !== dateKey(request.start_date)) fail('Correction times must be on the request date in IST, in order, and not in the future.');
  const existing = context.attendance;
  if (existing && ['CHECKED_IN', 'ON_BREAK'].includes(existing.current_state)) fail('An active workday cannot be regularized. Complete the workday first.', 409);
  const breaks = context.breaks || [];
  if (breaks.some(b => !b.break_end || new Date(b.break_start) < start || new Date(b.break_end) > end || new Date(b.break_end) < new Date(b.break_start))) fail('Existing break intervals do not fit the correction. Review them before approving.', 409);
  const rest = breaks.reduce((total, b) => total + Math.floor((new Date(b.break_end) - new Date(b.break_start)) / 60000), 0);
  const work = Math.max(0, Math.floor((end - start) / 60000) - rest);
  plan.attendance = { employee_id: request.employee_id, work_date: dateKey(request.start_date), check_in: start.toISOString(), check_out: end.toISOString(), current_state: 'CHECKED_OUT', status: work < 300 ? 'HALF_DAY' : 'PRESENT', total_work_minutes: work, total_break_minutes: rest, notes: `Regularized via request #${request.id}: ${plan.note}`, updated_at: now.toISOString() };
  plan.metadata.correction = { before: existing ? structuredClone(existing) : null, after: plan.attendance };
  return plan;
}
