import express from 'express';
import { authenticateUser, requireRoles } from '../middleware/auth.js';
import { query } from '../db/index.js';
import { configuredOffice } from '../services/officeConfiguration.js';
import { ATTENDANCE_RADIUS_M } from '../services/punchGeofence.js';
import { matchesOfficeWifi, officeConnection } from '../services/officeNetworks.js';
import { saveOffice, updatePrimaryOfficeCoordinates } from '../controllers/superAdminOfficesController.js';
const router = express.Router();
router.use(authenticateUser);
// Preserve the existing read API, now resolved to the account's assigned/default office.
router.get('/', async (req, res, next) => {
  try {
    const office = await configuredOffice(req.user);
    // Network registration lists are administrative settings, not employee directory data.
    if (!office) return res.json({
      success: true,
      data: null
    });
    const {
      office_ips,
      office_public_ip,
      office_public_ipv6_cidr,
      ...location
    } = office;
    const connection = officeConnection(req);
    const loopback = connection.type === 'LAN' && ['127.0.0.1', '::1'].includes(connection.ip);
    res.json({
      success: true,
      data: req.user.role === 'SUPER_ADMIN' ? office : {
        ...location,
        office_wifi_matched: matchesOfficeWifi(req, office),
        office_public_ip_configured: Boolean(office_public_ip),
        office_public_ipv6_configured: Boolean(office_public_ipv6_cidr),
        office_connection_ip: connection.ip,
        office_connection_type: connection.type,
        ...(loopback && office.wifi_attendance_enabled && req.app.locals.officeLanUrl ? { office_lan_url: req.app.locals.officeLanUrl } : {})
      }
    });
  } catch (error) {
    next(error);
  }
});
// Keep legacy GPS updates compatible, targeting just the primary office and auditing them.
router.put('/', requireRoles('SUPER_ADMIN'), async (req, res, next) => {
  if (req.body?.office_id !== undefined) return updatePrimaryOfficeCoordinates(req, res);
  try {
    const current = await configuredOffice({});
    const users = current ? (await query('SELECT id FROM employees WHERE office_id = $1 AND is_active = true', [current.id])).rows : [];
    req.params.id = current?.id ? String(current.id) : undefined;
    req.body = {
      name: 'KNOOVIQ HQ',
      radius_m: ATTENDANCE_RADIUS_M,
      max_accuracy_m: 50,
      timezone: 'Asia/Kolkata',
      office_ips: [],
      ...current,
      ...req.body,
      is_primary: true,
      user_ids: users.map(e => e.id)
    };
    return saveOffice(req, res);
  } catch (error) {
    next(error);
  }
});
export default router;
