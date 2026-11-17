import { query } from '../db/index.js';

/**
 * GET /api/requests/my
 * Returns requests submitted by the logged-in user (both Employee and HR's own requests)
 */
export async function getMyRequests(req, res) {
  try {
    const employeeId = req.user.id;
    let list = [];
    const result = await query(`SELECT r.*, e.employee_id as emp_code, e.first_name, e.last_name, e.department_name
         FROM requests r
         JOIN employees e ON r.employee_id = e.id
         WHERE r.employee_id = $1
         ORDER BY r.submission_date DESC`, [employeeId]);
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
 * POST /api/requests/my
 * Submit a new request for the logged-in user
 */
export async function submitMyRequest(req, res) {
  try {
    const employeeId = req.user.id;
    const {
      request_type,
      start_date,
      end_date,
      reason
    } = req.body;
    const validTypes = ['LEAVE', 'HOLIDAY', 'REGULARIZATION', 'WFH', 'OTHER'];
    if (!request_type || !validTypes.includes(request_type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid request type. Must be one of: ${validTypes.join(', ')}`
      });
    }
    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        error: 'Start date and end date are required.'
      });
    }
    if (new Date(end_date) < new Date(start_date)) {
      return res.status(400).json({
        success: false,
        error: 'End date cannot be earlier than start date.'
      });
    }
    if (!reason || reason.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Reason or description is required.'
      });
    }
    const nowIso = new Date().toISOString();
    let newRequest = null;
    const insertRes = await query(`INSERT INTO requests (employee_id, request_type, start_date, end_date, reason, status, submission_date)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)
         RETURNING *`, [employeeId, request_type, start_date, end_date, reason.trim(), nowIso]);
    newRequest = insertRes.rows[0];
    return res.status(201).json({
      success: true,
      message: 'Request submitted successfully and is pending review.',
      data: newRequest
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

/**
 * GET /api/requests/company
 * HR Admin view-only: returns company-wide requests with search, filter, and sort
 */
export async function getCompanyRequests(req, res) {
  try {
    const {
      status,
      type,
      department,
      search,
      sortBy
    } = req.query;
    let list = [];
    let sql = `
        SELECT r.*, e.employee_id as emp_code, e.first_name, e.last_name, e.department_name, e.designation,
          approver.first_name as approver_first_name, approver.last_name as approver_last_name
        FROM requests r
        JOIN employees e ON r.employee_id = e.id
        LEFT JOIN employees approver ON r.decision_by = approver.id
        WHERE 1=1
      `;
    const params = [];
    if (status && status !== 'ALL') {
      params.push(status);
      sql += ` AND r.status = $${params.length}`;
    }
    if (type && type !== 'ALL') {
      params.push(type);
      sql += ` AND r.request_type = $${params.length}`;
    }
    if (department && department !== 'ALL') {
      params.push(department);
      sql += ` AND e.department_name = $${params.length}`;
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      sql += ` AND (LOWER(e.first_name || ' ' || e.last_name) LIKE $${params.length} OR LOWER(e.employee_id) LIKE $${params.length} OR LOWER(r.reason) LIKE $${params.length})`;
    }
    sql += ` ORDER BY r.submission_date ${sortBy === 'ASC' ? 'ASC' : 'DESC'}`;
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
 * Super Admin Decision Endpoint (Locked / Disabled in this phase)
 * Explicit enforcement: strictly disallow HR Admin or Employee from approving/rejecting
 */
export async function decideRequest(req, res) {
  // Requirement: "Super Admin is reserved for future privileged operations. Do not implement those operations in the current phase."
  // Requirement: "HR Admin must not approve, reject, accept, deny, edit, or delete another employee's request."
  return res.status(403).json({
    success: false,
    error: 'Action Forbidden: Request approval and rejection is reserved for Super Admin in a later phase. HR Admin and Employees have zero decision permissions.'
  });
}
