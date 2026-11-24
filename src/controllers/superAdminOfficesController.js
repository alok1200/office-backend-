import { pool, query, transaction } from '../db/index.js';
import { matchOfficeIP, peerAddress, validateOffice, validateOfficeCoordinates } from '../services/officeNetworks.js';
import { ATTENDANCE_RADIUS_M, attendanceAccuracyLimit } from '../services/punchGeofence.js';
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), {
    status
  });
};
const officeId = value => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail('Invalid office ID.');
  return id;
};
const respondError = (res, error) => res.status(error.status || 500).json({
  success: false,
  error: error.status ? error.message : 'Could not update office settings. Please retry.'
});
const safeUser = e => ({
  id: e.id,
  name: `${e.first_name || ''} ${e.last_name || ''}`.trim(),
  code: e.employee_id,
  email: e.email,
  role: e.role,
  office_id: e.office_id || null
});
async function sqlSnapshot(run) {
  const offices = (await run('SELECT * FROM office_locations WHERE is_active = true ORDER BY is_primary DESC, id DESC')).rows;
  const users = (await run('SELECT id, first_name, last_name, employee_id, email, role, office_id FROM employees WHERE is_active = true ORDER BY first_name, id')).rows;
  return {
    offices,
    users
  };
}
function primaryOffice(offices) {
  return offices.find(o => o.is_primary) || offices[0];
}
export async function listOffices(req, res) {
  try {
    const snapshot = await sqlSnapshot(query);
    const primary = primaryOffice(snapshot.offices);
    const ip = peerAddress(req);
    const offices = snapshot.offices.map(o => {
      const assigned = snapshot.users.filter(u => u.office_id === o.id);
      const inherited = o.id === primary?.id ? snapshot.users.filter(u => !u.office_id) : [];
      return {
        ...o,
        radius_m: ATTENDANCE_RADIUS_M,
        max_accuracy_m: attendanceAccuracyLimit(o.max_accuracy_m),
        timezone: o.timezone || 'Asia/Kolkata',
        office_ips: o.office_ips || [],
        is_primary: o.id === primary?.id,
        user_ids: assigned.map(u => u.id),
        users_count: assigned.length + inherited.length,
        inherited_users_count: inherited.length,
        network_matches: ip ? matchOfficeIP(ip, o.office_ips || []) : false
      };
    });
    res.json({
      success: true,
      data: {
        offices,
        users: snapshot.users.map(safeUser),
        connection_ip: ip,
        connection_source: 'Direct connection seen by the API server',
        matched_office_ids: offices.filter(o => o.network_matches).map(o => o.id)
      }
    });
  } catch (error) {
    respondError(res, error);
  }
}
function validateAssignment(data, users, before, offices) {
  if (data.user_ids.some(id => !users.some(u => u.id === id))) fail('One or more selected users are inactive or no longer exist.');
  if (before?.is_primary && !data.is_primary) fail('Choose a different primary office first.');
  if (!before && !offices.length) data.is_primary = true;
}
export async function updatePrimaryOfficeCoordinates(req, res) {
  try {
    const id = officeId(req.body.office_id);
    const { latitude, longitude } = validateOfficeCoordinates(req.body);
    const saved = await transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(784291)');
      const { rows: [before] } = await client.query('SELECT * FROM office_locations WHERE is_active = true ORDER BY is_primary DESC, id DESC LIMIT 1');
      if (before?.id !== id) fail('The primary office changed. Reload the office settings and try again.', 409);

      const { rows: [office] } = await client.query(
        'UPDATE office_locations SET latitude=$1, longitude=$2, updated_by=$3, updated_at=now() WHERE id=$4 RETURNING *',
        [latitude, longitude, req.user.id, id]
      );
      await client.query(
        "INSERT INTO admin_audit_log (actor_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1,'UPDATE_OFFICE','office',$2,$3,$4)",
        [req.user.id, id, JSON.stringify(before), JSON.stringify(office)]
      );
      return office;
    });
    res.json({
      success: true,
      data: { ...saved, radius_m: ATTENDANCE_RADIUS_M, max_accuracy_m: attendanceAccuracyLimit(saved.max_accuracy_m) },
      message: 'Primary office location updated.'
    });
  } catch (error) {
    respondError(res, error);
  }
}
export async function saveOffice(req, res) {
  let client;
  try {
    const id = req.params.id ? officeId(req.params.id) : null;
    const data = validateOffice(req.body);
    data.radius_m = ATTENDANCE_RADIUS_M;
    data.max_accuracy_m = attendanceAccuracyLimit(data.max_accuracy_m);
    const now = new Date().toISOString();
    let saved;
    client = await pool.connect();
    await client.query('BEGIN');
    // Serialize office configuration changes and assignment updates across admins.
    await client.query('SELECT pg_advisory_xact_lock(784291)');
    const snapshot = await sqlSnapshot(client.query.bind(client));
    if (snapshot.offices.length && !snapshot.offices.some(o => o.is_primary)) {
      snapshot.offices[0].is_primary = true;
      await client.query('UPDATE office_locations SET is_primary = true WHERE id = $1', [snapshot.offices[0].id]);
    }
    const before = id ? snapshot.offices.find(o => o.id === id) : null;
    if (id && !before) fail('Office not found.', 404);
    validateAssignment(data, snapshot.users, before, snapshot.offices);
    if (data.is_primary) await client.query('UPDATE office_locations SET is_primary = false WHERE is_primary = true');
    const args = [data.name, data.latitude, data.longitude, data.radius_m, data.max_accuracy_m, data.address, data.timezone, JSON.stringify(data.office_ips), data.is_primary, req.user.id, now];
    saved = id ? (await client.query('UPDATE office_locations SET name=$1, latitude=$2, longitude=$3, radius_m=$4, max_accuracy_m=$5, address=$6, timezone=$7, office_ips=$8, is_primary=$9, updated_by=$10, updated_at=$11 WHERE id=$12 RETURNING *', [...args, id])).rows[0] : (await client.query('INSERT INTO office_locations (name,latitude,longitude,radius_m,max_accuracy_m,address,timezone,office_ips,is_primary,updated_by,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', args)).rows[0];
    await client.query('UPDATE employees SET office_id = NULL WHERE office_id = $1 AND NOT (id = ANY($2::int[]))', [saved.id, data.user_ids]);
    await client.query('UPDATE employees SET office_id = $1 WHERE id = ANY($2::int[])', [saved.id, data.user_ids]);
    await client.query('INSERT INTO admin_audit_log (actor_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1,$2,$3,$4,$5,$6)', [req.user.id, id ? 'UPDATE_OFFICE' : 'CREATE_OFFICE', 'office', saved.id, JSON.stringify(before ? {
      ...before,
      user_ids: snapshot.users.filter(u => u.office_id === id).map(u => u.id)
    } : null), JSON.stringify({
      ...saved,
      user_ids: data.user_ids,
      previous_primary_id: primaryOffice(snapshot.offices)?.id || null,
      previous_assignments: snapshot.users.filter(u => data.user_ids.includes(u.id) || u.office_id === saved.id).map(u => ({
        user_id: u.id,
        office_id: u.office_id || null
      }))
    })]);
    await client.query('COMMIT');
    res.status(id ? 200 : 201).json({
      success: true,
      data: saved,
      message: id ? 'Office updated.' : 'Office added.'
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    respondError(res, error);
  } finally {
    client?.release();
  }
}
export async function deleteOffice(req, res) {
  let client;
  try {
    const id = officeId(req.params.id);
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(784291)');
    const snapshot = await sqlSnapshot(client.query.bind(client));
    const office = snapshot.offices.find(o => o.id === id);
    if (!office) fail('Office not found.', 404);
    if (snapshot.users.some(u => u.office_id === id) || primaryOffice(snapshot.offices)?.id === id) fail('Move assigned users and choose another primary office before removing this office.', 409);
    await client.query('UPDATE office_locations SET is_active = false WHERE id = $1', [id]);
    await client.query("INSERT INTO admin_audit_log (actor_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1,'DELETE_OFFICE','office',$2,$3,$4)", [req.user.id, id, JSON.stringify(office), JSON.stringify({
      ...office,
      is_active: false
    })]);
    await client.query('COMMIT');
    res.json({
      success: true,
      message: 'Office removed.'
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    respondError(res, error);
  } finally {
    client?.release();
  }
}
export async function officeAuditLog(req, res) {
  try {
    const rows = (await query('SELECT a.*, e.first_name, e.last_name FROM admin_audit_log a LEFT JOIN employees e ON a.actor_id = e.id ORDER BY a.created_at DESC, a.id DESC LIMIT 100')).rows;
    res.json({
      success: true,
      data: rows
    });
  } catch (error) {
    respondError(res, error);
  }
}
