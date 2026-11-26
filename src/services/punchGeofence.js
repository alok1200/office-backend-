import { distanceMeters } from '../utils/geo.js';
import { matchesOfficeWifi } from './officeNetworks.js';
export const ATTENDANCE_RADIUS_M = 100;
export const MAX_ATTENDANCE_ACCURACY_M = 100;
export const attendanceAccuracyLimit = value => Math.min(Number(value ?? 75), MAX_ATTENDANCE_ACCURACY_M);
const fail = (code, message, details = {}, status = 400) => { throw Object.assign(new Error(message), { status, code, details }); };
const numeric = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value));
const attendanceActions = new Set(['CHECK_IN', 'START_BREAK', 'END_BREAK', 'CHECK_OUT']);
export function verifyPunchGeofence(office, body) {
  if (!office) fail('OFFICE_NOT_CONFIGURED', 'Your office location has not been configured. Contact your administrator.', {}, 409);
  const radius = ATTENDANCE_RADIUS_M, maximumAccuracy = attendanceAccuracyLimit(office.max_accuracy_m);
  if (!numeric(office.latitude) || !numeric(office.longitude) || Math.abs(Number(office.latitude)) > 90 || Math.abs(Number(office.longitude)) > 180 || !numeric(office.radius_m) || Number(office.radius_m) <= 0 || !Number.isFinite(maximumAccuracy) || maximumAccuracy <= 0) fail('OFFICE_NOT_CONFIGURED', 'Office GPS settings are invalid. Contact your administrator.', {}, 409);
  const latitude = body.latitude ?? body.lat, longitude = body.longitude ?? body.lng;
  if (!numeric(latitude) || !numeric(longitude) || Math.abs(Number(latitude)) > 90 || Math.abs(Number(longitude)) > 180 || !numeric(body.accuracy) || Number(body.accuracy) < 0) fail('GPS_REQUIRED', 'GPS did not provide a usable location. Enable precise location and retry.');
  const accuracy = Number(body.accuracy);
  if (accuracy > maximumAccuracy) fail('LOW_ACCURACY', `GPS accuracy is ±${Math.round(accuracy)} m. This office requires ±${maximumAccuracy} m or better. Refresh GPS near a window or outdoors.`, { accuracy_m: accuracy, max_accuracy_m: maximumAccuracy });
  const distance = distanceMeters(Number(latitude), Number(longitude), Number(office.latitude), Number(office.longitude));
  if (distance > radius) fail('OUTSIDE_GEOFENCE', `You are ${distance < 1000 ? distance.toFixed(2) : Math.round(distance)} m from the saved office. GPS verification requires being within ${radius} m.`, { distance_m: Math.round(distance * 100) / 100, allowed_m: radius });
  return { distance_m: distance, allowed_m: radius, accuracy_m: accuracy };
}

export function verifyPunchLocation(office, req) {
  try {
    verifyPunchGeofence(office, req.body);
    return 'GPS';
  } catch (error) {
    const canFallBack = error.code === 'GPS_REQUIRED' || error.code === 'LOW_ACCURACY';
    if (canFallBack || error.code === 'OUTSIDE_GEOFENCE') {
      const wifiMatched = matchesOfficeWifi(req, office);
      if (attendanceActions.has(req.body.action) && canFallBack && wifiMatched) return 'OFFICE_WIFI';
      error.details = {
        ...error.details,
        wifi_attendance_enabled: Boolean(office?.wifi_attendance_enabled),
        office_wifi_matched: wifiMatched
      };
    }
    throw error;
  }
}
