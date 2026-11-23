import { query } from '../db/index.js';
import { ATTENDANCE_RADIUS_M } from './punchGeofence.js';
export async function configuredOffice(user) {
  const office = (await query('SELECT * FROM office_locations WHERE is_active = true ORDER BY (id = COALESCE($1, -1)) DESC, is_primary DESC, id DESC LIMIT 1', [user?.office_id || null])).rows[0] || null;
  return office ? { ...office, radius_m: ATTENDANCE_RADIUS_M, max_accuracy_m: Math.min(Number(office.max_accuracy_m ?? 75), 75) } : null;
}
