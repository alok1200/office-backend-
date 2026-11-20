import { requestCategories, calculateRequest } from './superAdminRequestPolicy.js';
import { indiaDate } from './superAdminAttendanceReport.js';
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function employeeRequestPayload(body, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Provide request details.');
  const category = body.category || ({ LEAVE: body.leave_category || body.metadata?.category || 'CL', WFH: 'WFH', OTHER: 'OFFICIAL', REGULARIZATION: 'REGULARIZATION', HOLIDAY: 'HOLIDAY' })[body.request_type];
  if (!requestCategories[category] || (body.request_type && requestCategories[category].type !== body.request_type)) fail('Choose a valid request type and leave category.');
  const payload = { category, start_date: body.start_date, end_date: body.end_date, half_day: body.half_day ?? false, reason: body.reason };
  calculateRequest(payload); // Validate calendar dates before comparing their keys.
  if (category === 'REGULARIZATION' && (payload.start_date !== payload.end_date || payload.start_date > indiaDate(now))) fail('Attendance regularization must cover one date that is not in the future.');
  if (category === 'REGULARIZATION' && payload.half_day) fail('Use reviewed punch times for regularization instead of the half-day option.');
  if (category === 'HOLIDAY' && payload.half_day) fail('Holiday requests must cover full days.');
  return payload;
}
