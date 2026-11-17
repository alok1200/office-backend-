export const requestCategories = {
  CL: { label: 'Casual Leave', type: 'LEAVE', allowance: 12 },
  SL: { label: 'Sick Leave', type: 'LEAVE', allowance: 10 },
  EL: { label: 'Earned Leave', type: 'LEAVE', allowance: 15 },
  WFH: { label: 'Remote Work', type: 'WFH', allowance: 24 },
  OFFICIAL: { label: 'Official work outside', type: 'OTHER' },
  REGULARIZATION: { label: 'Attendance regularization', type: 'REGULARIZATION' },
};
export const dateKey = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const invalid = message => { const error = new Error(message); error.status = 400; throw error; };
export function calculateRequest(payload, holidays = []) {
  const { category, start_date, end_date, half_day = false } = payload;
  if (!requestCategories[category]) invalid('Choose a valid request type.');
  for (const value of [start_date, end_date]) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) invalid('Choose valid From and To dates.');
  }
  if (Number(start_date.slice(0, 4)) < 2000 || Number(end_date.slice(0, 4)) > 2100) invalid('Choose dates between 2000 and 2100.');
  if (end_date < start_date) invalid('To date cannot be earlier than From date.');
  if (start_date.slice(0, 4) !== end_date.slice(0, 4)) invalid('Submit separate requests for each calendar year.');
  if (typeof half_day !== 'boolean') invalid('Half day must be true or false.');
  if (half_day && start_date !== end_date) invalid('Half day requests must cover a single date.');
  const holidayDates = new Set(holidays.map(h => dateKey(h.holiday_date)));
  const dates = [];
  for (const day = new Date(`${start_date}T00:00:00Z`), end = new Date(`${end_date}T00:00:00Z`); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const key = dateKey(day);
    if (day.getUTCDay() !== 0 && !holidayDates.has(key)) dates.push(key);
  }
  if (!dates.length) invalid('The selected dates contain no working days. Sundays and holidays are skipped.');
  return { category, dates, days: half_day ? 0.5 : dates.length, year: Number(start_date.slice(0, 4)), half_day };
}
export function getAllowanceBalances(requests, year) {
  return Object.entries(requestCategories).filter(([, c]) => c.allowance !== undefined).map(([category, config]) => {
    const relevant = requests.filter(r => r.metadata?.category === category && Number(r.metadata?.year) === year);
    const total = status => relevant.filter(r => r.status === status).reduce((sum, r) => sum + Number(r.metadata?.days || 0), 0);
    const used = total('APPROVED');
    const pending = total('PENDING');
    return { category, label: config.label, allowance: config.allowance, used, pending, remaining: Math.max(0, config.allowance - used - pending) };
  });
}
export function validateSubmission(payload, context) {
  const calculation = calculateRequest(payload, context.holidays);
  if (typeof payload.reason !== 'string' || payload.reason.trim().length < 10 || payload.reason.trim().length > 2000) invalid('Reason must contain 10 to 2000 characters.');
  const balance = getAllowanceBalances(context.requests, calculation.year).find(b => b.category === calculation.category);
  if (balance && calculation.days > balance.remaining) invalid(`Only ${balance.remaining} day(s) remain for ${balance.label}. Pending requests reserve your balance.`);
  const overlaps = context.requests.some(r => ['PENDING', 'APPROVED'].includes(r.status) && dateKey(r.start_date) <= payload.end_date && dateKey(r.end_date) >= payload.start_date);
  if (overlaps) invalid('You already have a pending or approved request overlapping these dates.');
  return calculation;
}
