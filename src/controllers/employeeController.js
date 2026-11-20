import { query, pool } from '../db/index.js';
import {reportPeriod, indiaDate} from '../services/superAdminAttendanceReport.js';

/**
 * GET /api/employees/me
 * Returns logged-in employee's own profile
 */
export async function getMyProfile(req, res) {
  try {
    const employeeId = req.user.id;
    const result = await query(`SELECT id, employee_id, email, first_name, last_name, role, department_name, designation, phone, joining_date, avatar_url, can_record_attendance, is_active, created_at
         FROM employees WHERE id = $1`, [employeeId]);
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    return res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

/**
 * GET /api/employees/company (HR Admin view-only directory)
 */
export async function getCompanyEmployees(req, res) {
  try {
    const {
      department,
      search
    } = req.query;
    let list = [];
    let sql = `
        SELECT id, employee_id, email, first_name, last_name, role, department_name, designation, phone, joining_date, avatar_url, can_record_attendance, is_active
        FROM employees WHERE is_active = true
      `;
    const params = [];
    if (department && department !== 'ALL') {
      params.push(department);
      sql += ` AND department_name = $${params.length}`;
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      sql += ` AND (LOWER(first_name || ' ' || last_name) LIKE $${params.length} OR LOWER(employee_id) LIKE $${params.length} OR LOWER(designation) LIKE $${params.length})`;
    }
    sql += ` ORDER BY id ASC`;
    const result = await query(sql, params);
    list = result.rows;
    return res.json({
      success: true,
      data: list
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

/**
 * GET /api/employees/:id/attendance-history (HR Admin view-only inspection)
 */
export async function getEmployeeAttendanceHistory(req, res) {
  try {
    const targetEmpId = Number(req.params.id);
    if (!Number.isSafeInteger(targetEmpId) || targetEmpId <= 0) return res.status(400).json({success:false,error:'Invalid employee ID.'});
    const today=indiaDate();
    const {first:startPattern,last:endPattern}=reportPeriod({year:req.query.year ?? today.slice(0,4),month:req.query.month ?? today.slice(5,7)});
    const target=(await query('SELECT id FROM employees WHERE id=$1',[targetEmpId])).rows[0];
    if (!target) return res.status(404).json({success:false,error:'Employee not found.'});
    let attendances = [];
    const result = await query(`SELECT a.*, COALESCE(json_agg(b.*) FILTER (WHERE b.id IS NOT NULL), '[]') as breaks
         FROM attendances a
         LEFT JOIN attendance_breaks b ON a.id = b.attendance_id
         WHERE a.employee_id = $1 AND a.work_date >= $2 AND a.work_date <= $3
         GROUP BY a.id
         ORDER BY a.work_date DESC`, [targetEmpId, startPattern, endPattern]);
    attendances = result.rows;
    return res.json({
      success: true,
      data: attendances
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      error: err.message
    });
  }
}

/**
 * Editing or deleting existing employees remains a Super Admin privilege.
 * (HR Admin can onboard new employees and manage their company assets.)
 */
export async function forbidEmployeeEdit(req, res) {
  return res.status(403).json({
    success: false,
    error: 'Action Forbidden: Editing or deleting existing employee records is not permitted.'
  });
}

// ---------------------------------------------------------------------------
// Employee onboarding & company assets (HR Admin / Super Admin)
// ---------------------------------------------------------------------------
const ASSET_TYPES = ['LAPTOP', 'DESKTOP', 'MONITOR', 'MOBILE', 'ACCESS_CARD', 'ID_CARD', 'HEADSET', 'KEYBOARD_MOUSE', 'FURNITURE', 'OTHER'];
const ASSET_CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max, label, required = false) => {
  const v = String(value ?? '').trim();
  if (required && !v) fail(`${label} is required.`);
  if (v.length > max) fail(`${label} must be at most ${max} characters.`);
  return v || null;
};
const dateValue = (value, label, required = false) => {
  const v = String(value ?? '').trim();
  if (!v) { if (required) fail(`${label} is required.`); return null; }
  if (!DATE_RE.test(v) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) fail(`${label} must be a valid date.`);
  return v;
};
const respondError = (res, error) => {
  if (error.code === '23505') {
    const field = /email/.test(error.detail || '') ? 'email address' : /asset|tag/.test(`${error.constraint} ${error.detail}`) ? 'asset tag' : 'employee ID';
    return res.status(409).json({ success: false, error: `That ${field} is already in use.` });
  }
  return res.status(error.status || 500).json({ success: false, error: error.status ? error.message : 'Could not complete the employee operation. Please retry.' });
};
function validateAsset(raw, joiningDate) {
  const asset_type = String(raw?.asset_type || '').toUpperCase();
  if (!ASSET_TYPES.includes(asset_type)) fail(`Asset type must be one of: ${ASSET_TYPES.join(', ')}.`);
  const condition = String(raw?.condition || 'GOOD').toUpperCase();
  if (!ASSET_CONDITIONS.includes(condition)) fail(`Asset condition must be one of: ${ASSET_CONDITIONS.join(', ')}.`);
  const issued_date = dateValue(raw?.issued_date, 'Asset issue date') || joiningDate || new Date().toISOString().slice(0, 10);
  return {
    asset_type,
    asset_name: text(raw?.asset_name, 150, 'Asset name', true),
    asset_tag: text(raw?.asset_tag, 100, 'Asset tag'),
    serial_number: text(raw?.serial_number, 150, 'Serial number'),
    condition,
    issued_date,
    notes: text(raw?.notes, 500, 'Asset notes')
  };
}
async function insertAsset(client, employeeId, asset, issuedBy) {
  return (await client.query(
    `INSERT INTO company_assets (employee_id, asset_type, asset_name, asset_tag, serial_number, condition, issued_date, notes, issued_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [employeeId, asset.asset_type, asset.asset_name, asset.asset_tag, asset.serial_number, asset.condition, asset.issued_date, asset.notes, issuedBy]
  )).rows[0];
}
const PUBLIC_COLUMNS = 'id, employee_id, email, first_name, last_name, role, department_name, designation, phone, joining_date, avatar_url, can_record_attendance, is_active, date_of_birth, address, emergency_contact_name, emergency_contact_phone, custom_fields';
function validateCustomFields(raw) {
  if (raw == null || raw === '') return [];
  if (!Array.isArray(raw)) fail('Other fields must be a list.');
  if (raw.length > 20) fail('At most 20 other fields can be added.');
  const seen = new Set();
  return raw.map(item => {
    const label = text(item?.label, 60, 'Field name', true);
    const value = text(item?.value, 500, `Value for "${label}"`, true);
    if (seen.has(label.toLowerCase())) fail(`The field name "${label}" is used more than once.`);
    seen.add(label.toLowerCase());
    return { label, value };
  });
}

/**
 * POST /api/employees/company
 * HR Admin onboards a new employee together with issued company assets.
 * Only EMPLOYEE accounts can be created here, so HR cannot grant themselves or others elevated roles.
 */
export async function createEmployee(req, res) {
  return createAccount(req, res, 'EMPLOYEE');
}

// Mounted only under the Super Admin router; the submitted role is never trusted.
export async function createHRAdmin(req, res) {
  return createAccount(req, res, 'HR_ADMIN');
}

async function createAccount(req, res, accountRole) {
  let client;
  try {
    const b = req.body || {};
    const first_name = text(b.first_name, 100, 'First name', true);
    const last_name = text(b.last_name, 100, 'Last name', true);
    const email = text(b.email, 255, 'Email', true).toLowerCase();
    if (!EMAIL_RE.test(email)) fail('Enter a valid email address.');
    const password = String(b.password || '');
    if (password.length < 8 || password.length > 128) fail('Temporary password must be 8–128 characters.');
    const department_name = text(b.department_name, 100, 'Department', true);
    const designation = text(b.designation, 100, 'Designation', true);
    const phone = text(b.phone, 50, 'Phone number');
    if (phone && !/^[0-9+()\-\s]{6,50}$/.test(phone)) fail('Enter a valid phone number.');
    const joining_date = dateValue(b.joining_date, 'Joining date') || new Date().toISOString().slice(0, 10);
    const date_of_birth = dateValue(b.date_of_birth, 'Date of birth');
    if (date_of_birth && date_of_birth >= joining_date) fail('Date of birth must be before the joining date.');
    const address = text(b.address, 500, 'Address');
    const emergency_contact_name = text(b.emergency_contact_name, 150, 'Emergency contact name');
    const emergency_contact_phone = text(b.emergency_contact_phone, 50, 'Emergency contact phone');
    const requestedCode = text(b.employee_id, 50, 'Employee ID');
    if (requestedCode && !/^[A-Za-z0-9_-]+$/.test(requestedCode)) fail('Employee ID may only contain letters, numbers, hyphen and underscore.');
    const custom_fields = validateCustomFields(b.custom_fields);
    if (b.assets != null && !Array.isArray(b.assets)) fail('Assets must be a list.');
    const rawAssets = b.assets || [];
    if (rawAssets.length > 25) fail('At most 25 assets can be issued at onboarding.');
    const assets = rawAssets.map(a => validateAsset(a, joining_date));
    const tags = assets.map(a => a.asset_tag?.toLowerCase()).filter(Boolean);
    if (new Set(tags).size !== tags.length) fail('Each asset tag can only be used once.');

    const { hashPassword } = await import('../utils/security.js');
    const { hash, salt } = hashPassword(password);

    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(784292)');
    let employee_id = requestedCode;
    if (!employee_id) {
      const last = (await client.query("SELECT COALESCE(MAX(NULLIF(regexp_replace(employee_id, '\\D', '', 'g'), '')::bigint), 1000) AS n FROM employees WHERE employee_id ~ '^KNV-[0-9]+$'")).rows[0];
      employee_id = `KNV-${Number(last.n) + 1}`;
    }
    const duplicate=(await client.query('SELECT email, employee_id FROM employees WHERE LOWER(email)=LOWER($1) OR LOWER(employee_id)=LOWER($2) LIMIT 1', [email, employee_id])).rows[0];
    if (duplicate) fail(duplicate.email.toLowerCase() === email ? 'That email address is already in use.' : 'That employee ID is already in use.', 409);
    const dept = (await client.query('SELECT id, name FROM departments WHERE LOWER(name) = LOWER($1)', [department_name])).rows[0];
    const office = (await client.query('SELECT id FROM office_locations WHERE is_primary = true AND is_active = true LIMIT 1')).rows[0];
    const employee = (await client.query(
      `INSERT INTO employees (employee_id, email, first_name, last_name, role, department_id, department_name, designation, phone, joining_date,
         password_hash, password_salt, can_record_attendance, attendance_enabled, is_active, date_of_birth, address, emergency_contact_name, emergency_contact_phone, created_by, office_id, custom_fields)
       VALUES ($1,$2,$3,$4,$19,$5,$6,$7,$8,$9,$10,$11,true,true,true,$12,$13,$14,$15,$16,$17,$18)
       RETURNING ${PUBLIC_COLUMNS}`,
      [employee_id, email, first_name, last_name, dept?.id || null, dept?.name || department_name, designation, phone, joining_date,
        hash, salt, date_of_birth, address, emergency_contact_name, emergency_contact_phone, req.user.id, office?.id || null, JSON.stringify(custom_fields), accountRole]
    )).rows[0];
    const savedAssets = [];
    for (const asset of assets) savedAssets.push(await insertAsset(client, employee.id, asset, req.user.id));
    await client.query(
      "INSERT INTO admin_audit_log (actor_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1,$4,'employee',$2,NULL,$3)",
      [req.user.id, employee.id, JSON.stringify({ employee, assets: savedAssets }), accountRole === 'HR_ADMIN' ? 'CREATE_HR_ADMIN' : 'CREATE_EMPLOYEE']
    );
    await client.query(
      "INSERT INTO notifications (recipient_id, title, message, category) VALUES ($1,$2,$3,'ANNOUNCEMENT')",
      [employee.id, 'Welcome to KNOOVIQ', `Your ${accountRole === 'HR_ADMIN' ? 'HR Admin account was created by Super Admin' : 'account was created by HR'}. Sign in with your work email and the password you were given.`]
    );
    await client.query('COMMIT');
    return res.status(201).json({ success: true, message: `${first_name} ${last_name} (${employee.employee_id}) was added.`, data: { ...employee, assets: savedAssets } });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, error);
  } finally { client?.release(); }
}

/**
 * GET /api/employees/:id/details — profile plus every asset (issued and returned).
 */
export async function getEmployeeDetails(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) fail('Invalid employee ID.');
    const employee = (await query(`SELECT ${PUBLIC_COLUMNS} FROM employees WHERE id = $1`, [id])).rows[0];
    if (!employee) fail('Employee not found.', 404);
    const assets = (await query('SELECT * FROM company_assets WHERE employee_id = $1 ORDER BY returned_date NULLS FIRST, issued_date DESC, id DESC', [id])).rows;
    return res.json({ success: true, data: { ...employee, assets } });
  } catch (error) { return respondError(res, error); }
}

/**
 * POST /api/employees/:id/assets — issue another asset to an existing employee.
 */
export async function addEmployeeAsset(req, res) {
  let client;
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) fail('Invalid employee ID.');
    const asset = validateAsset(req.body);
    client = await pool.connect();
    await client.query('BEGIN');
    const target = (await client.query('SELECT id, is_active FROM employees WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!target || !target.is_active) fail('Employee not found.', 404);
    const saved = await insertAsset(client, id, asset, req.user.id);
    await client.query("INSERT INTO admin_audit_log (actor_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1,'ISSUE_ASSET','company_asset',$2,NULL,$3)", [req.user.id, saved.id, JSON.stringify(saved)]);
    await client.query('COMMIT');
    return res.status(201).json({ success: true, message: 'Asset issued.', data: saved });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, error);
  } finally { client?.release(); }
}

/**
 * PATCH /api/employees/assets/:assetId/return — mark an issued asset as returned.
 */
export async function returnEmployeeAsset(req, res) {
  let client;
  try {
    const assetId = Number(req.params.assetId);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) fail('Invalid asset ID.');
    const returned_date = dateValue(req.body?.returned_date, 'Return date') || new Date().toISOString().slice(0, 10);
    client = await pool.connect();
    await client.query('BEGIN');
    const before = (await client.query('SELECT * FROM company_assets WHERE id = $1 FOR UPDATE', [assetId])).rows[0];
    if (!before) fail('Asset not found.', 404);
    if (before.returned_date) fail('This asset was already returned.', 409);
    if (returned_date < String(before.issued_date).slice(0, 10)) fail('Return date cannot be before the issue date.');
    const after = (await client.query('UPDATE company_assets SET returned_date = $1 WHERE id = $2 RETURNING *', [returned_date, assetId])).rows[0];
    await client.query("INSERT INTO admin_audit_log (actor_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1,'RETURN_ASSET','company_asset',$2,$3,$4)", [req.user.id, assetId, JSON.stringify(before), JSON.stringify(after)]);
    await client.query('COMMIT');
    return res.json({ success: true, message: 'Asset marked as returned.', data: after });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, error);
  } finally { client?.release(); }
}

/**
 * GET /api/employees/me/assets — the logged-in user's own assets.
 */
export async function getMyAssets(req, res) {
  try {
    const assets = (await query('SELECT * FROM company_assets WHERE employee_id = $1 ORDER BY returned_date NULLS FIRST, issued_date DESC, id DESC', [req.user.id])).rows;
    return res.json({ success: true, data: assets });
  } catch (error) { return respondError(res, error); }
}

/**
 * PATCH /api/employees/:id/password — HR Admin resets a forgotten password for an Employee account.
 */
export async function resetEmployeePassword(req, res) {
  let client;
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) fail('Invalid employee ID.');
    const password = String(req.body?.password || '');
    if (password.length < 8 || password.length > 128) fail('New password must be 8–128 characters.');

    const { hashPassword, revokeUserSessions, clearRateLimitForIdentifiers } = await import('../utils/security.js');
    const { hash, salt } = hashPassword(password);

    client = await pool.connect();
    await client.query('BEGIN');
    const target = (await client.query(
      'SELECT id, employee_id, email, first_name, last_name, role, is_active FROM employees WHERE id = $1 FOR UPDATE',
      [id]
    )).rows[0];
    if (!target || !target.is_active) fail('Employee not found.', 404);
    if (req.user.role === 'HR_ADMIN' && target.role !== 'EMPLOYEE') fail('HR Admin can only reset passwords for Employee accounts.', 403);
    if (req.user.role === 'SUPER_ADMIN' && target.role !== 'HR_ADMIN') fail('Super Admin can only reset passwords for HR Admin accounts here.', 403);

    await client.query(
      'UPDATE employees SET password_hash = $1, password_salt = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [hash, salt, id]
    );
    await client.query(
      "INSERT INTO admin_audit_log (actor_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1,'RESET_EMPLOYEE_PASSWORD','employee',$2,NULL,$3)",
      [req.user.id, id, JSON.stringify({ employee_id: target.employee_id, reset_by: req.user.id })]
    );
    await client.query(
      "INSERT INTO notifications (recipient_id, title, message, category) VALUES ($1,$2,$3,'ANNOUNCEMENT')",
      [id, 'Password Reset by HR', 'Your account password was reset by HR. Use your new password to sign in.']
    );
    await client.query('COMMIT');

    revokeUserSessions(id);
    clearRateLimitForIdentifiers([target.email, target.employee_id]);
    return res.json({
      success: true,
      message: `Password updated for ${target.first_name} ${target.last_name} (${target.employee_id}).`
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, error);
  } finally { client?.release(); }
}

/**
 * DELETE /api/employees/:id — HR Admin removes an Employee account when they leave the company.
 * Soft-deactivates the account so login and directory access end immediately while preserving audit/attendance history.
 */
export async function deleteEmployee(req, res) {
  let client;
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) fail('Invalid employee ID.');
    if (id === req.user.id) fail('You cannot delete your own account.', 400);

    const { revokeUserSessions, clearRateLimitForIdentifiers } = await import('../utils/security.js');

    client = await pool.connect();
    await client.query('BEGIN');
    const target = (await client.query(
      'SELECT id, employee_id, email, first_name, last_name, role, is_active FROM employees WHERE id = $1 FOR UPDATE',
      [id]
    )).rows[0];
    if (!target || !target.is_active) fail('Employee not found.', 404);
    if (req.user.role === 'HR_ADMIN' && target.role !== 'EMPLOYEE') fail('HR Admin can only delete Employee accounts.', 403);
    if (req.user.role === 'SUPER_ADMIN' && target.role !== 'HR_ADMIN') fail('Super Admin can only delete HR Admin accounts here.', 403);

    // Clear password credentials and release the email address while keeping audit/attendance foreign keys intact.
    const archivedEmail = `deleted-${id}-${Date.now()}@deleted.local`;
    await client.query(
      'UPDATE employees SET is_active = false, email = $1, password_hash = NULL, password_salt = NULL, can_record_attendance = false, attendance_enabled = false, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [archivedEmail, id]
    );
    const auditAction = target.role === 'HR_ADMIN' ? 'DELETE_HR_ADMIN' : 'DELETE_EMPLOYEE';
    await client.query(
      'INSERT INTO admin_audit_log (actor_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.id, auditAction, 'employee', id, JSON.stringify({ employee_id: target.employee_id, email: target.email, role: target.role, is_active: true }), JSON.stringify({ employee_id: target.employee_id, role: target.role, is_active: false, credentials_cleared: true, deleted_by: req.user.id })]
    );
    await client.query('COMMIT');

    revokeUserSessions(id);
    clearRateLimitForIdentifiers([target.email, target.employee_id]);
    return res.json({
      success: true,
      message: `${target.first_name} ${target.last_name} (${target.employee_id}) has been removed.`
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, error);
  } finally { client?.release(); }
}

/**
 * PUT /api/employees/:id — HR Admin edits an existing Employee's profile & custom fields.
 * Role, password, and active status are not modified here.
 */
export async function updateEmployee(req, res) {
  let client;
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) fail('Invalid employee ID.');
    const b = req.body || {};
    const first_name = text(b.first_name, 100, 'First name', true);
    const last_name = text(b.last_name, 100, 'Last name', true);
    const email = text(b.email, 255, 'Email', true).toLowerCase();
    if (!EMAIL_RE.test(email)) fail('Enter a valid email address.');
    const department_name = text(b.department_name, 100, 'Department', true);
    const designation = text(b.designation, 100, 'Designation', true);
    const phone = text(b.phone, 50, 'Phone number');
    if (phone && !/^[0-9+()\-\s]{6,50}$/.test(phone)) fail('Enter a valid phone number.');
    const joining_date = dateValue(b.joining_date, 'Joining date', true);
    const date_of_birth = dateValue(b.date_of_birth, 'Date of birth');
    if (date_of_birth && date_of_birth >= joining_date) fail('Date of birth must be before the joining date.');
    const address = text(b.address, 500, 'Address');
    const emergency_contact_name = text(b.emergency_contact_name, 150, 'Emergency contact name');
    const emergency_contact_phone = text(b.emergency_contact_phone, 50, 'Emergency contact phone');
    const requestedCode = text(b.employee_id, 50, 'Employee ID');
    if (requestedCode && !/^[A-Za-z0-9_-]+$/.test(requestedCode)) fail('Employee ID may only contain letters, numbers, hyphen and underscore.');
    const custom_fields = validateCustomFields(b.custom_fields);

    client = await pool.connect();
    await client.query('BEGIN');
    const before = (await client.query(`SELECT ${PUBLIC_COLUMNS} FROM employees WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!before || !before.is_active) fail('Employee not found.', 404);
    if (before.role !== 'EMPLOYEE') fail('HR Admin can only edit Employee accounts.', 403);

    const employee_id = requestedCode || before.employee_id;
    const dept = (await client.query('SELECT id, name FROM departments WHERE LOWER(name) = LOWER($1)', [department_name])).rows[0];
    const updated = (await client.query(
      `UPDATE employees
       SET employee_id = $1, email = $2, first_name = $3, last_name = $4, department_id = $5, department_name = $6,
           designation = $7, phone = $8, joining_date = $9, date_of_birth = $10, address = $11,
           emergency_contact_name = $12, emergency_contact_phone = $13, custom_fields = $14, updated_at = CURRENT_TIMESTAMP
       WHERE id = $15
       RETURNING ${PUBLIC_COLUMNS}`,
      [employee_id, email, first_name, last_name, dept?.id || null, dept?.name || department_name,
        designation, phone, joining_date, date_of_birth, address, emergency_contact_name, emergency_contact_phone,
        JSON.stringify(custom_fields), id]
    )).rows[0];
    await client.query(
      "INSERT INTO admin_audit_log (actor_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1,'UPDATE_EMPLOYEE','employee',$2,$3,$4)",
      [req.user.id, id, JSON.stringify(before), JSON.stringify(updated)]
    );
    await client.query('COMMIT');
    return res.json({
      success: true,
      message: `${updated.first_name} ${updated.last_name} (${updated.employee_id}) was updated.`,
      data: updated
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return respondError(res, error);
  } finally { client?.release(); }
}
