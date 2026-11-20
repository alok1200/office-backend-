import { dateKey } from './superAdminRequestPolicy.js';
export function plannedRequestForDate(requests, employeeId, workDate) {
  return requests.find(request => request.employee_id === employeeId && request.status === 'APPROVED' &&
    (Array.isArray(request.metadata?.dates) ? request.metadata.dates.includes(workDate) :
      dateKey(request.start_date) <= workDate && dateKey(request.end_date) >= workDate && (request.request_type === 'HOLIDAY' || new Date(`${workDate}T12:00:00Z`).getUTCDay() !== 0)));
}
export function plannedAttendanceStatus(request) {
  if (!request) return null;
  if (request.request_type === 'LEAVE') return request.metadata?.half_day ? 'HALF_DAY' : 'LEAVE';
  if (request.request_type === 'HOLIDAY') return 'HOLIDAY';
  if (request.request_type === 'WFH') return 'WFH';
  if (request.request_type === 'OTHER' && request.metadata?.category === 'OFFICIAL') return 'OFFICIAL_WORK_OUTSIDE';
  return null;
}

// Saved attendance is authoritative; otherwise use company holidays and approved plans.
export function resolveAttendanceStatus({attendance,holiday,planned,workDate,today}) {
  if(attendance?.status)return attendance.status;
  if(holiday)return 'HOLIDAY';
  const status=plannedAttendanceStatus(planned);
  if(status)return status;
  if(new Date(`${workDate}T12:00:00Z`).getUTCDay()===0)return 'WEEKLY_OFF';
  if(workDate>today)return 'FUTURE';
  return workDate===today?'NOT_CHECKED_IN':'ABSENT';
}
