import { query } from '../db/index.js';

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
    const targetEmpId = parseInt(req.params.id, 10);
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;
    const monthStr = String(month).padStart(2, '0');
    const startPattern = `${year}-${monthStr}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endPattern = `${year}-${monthStr}-${String(lastDay).padStart(2, '0')}`;
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
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

/**
 * Forbidden modification endpoints for HR Admin
 */
export async function forbidEmployeeEdit(req, res) {
  return res.status(403).json({
    success: false,
    error: 'Action Forbidden: Editing, adding, or deleting employees is a Super Admin privilege and is not available in the current phase. HR Admin is strictly read-only.'
  });
}
