import { query, transaction } from '../db/index.js';
import { createPersonalRequest } from './superAdminRequestsController.js';
import { employeeRequestPayload } from '../services/employeeRequestPolicy.js';

/**
 * GET /api/requests/my
 * Returns requests submitted by the logged-in user (both Employee and HR's own requests)
 */
export async function getMyRequests(req, res) {
  try {
    const employeeId = req.user.id;
    const result = await query(`
      SELECT r.*,
             e.employee_id as emp_code,
             e.first_name,
             e.last_name,
             e.department_name,
             e.designation,
             e.avatar_url,
             e.role as employee_role,
             a.check_in as recorded_check_in,
             a.check_out as recorded_check_out,
             a.status as recorded_status,
             a.total_work_minutes as recorded_work_minutes
      FROM requests r
      JOIN employees e ON r.employee_id = e.id
      LEFT JOIN attendances a ON a.employee_id = r.employee_id AND a.work_date = r.start_date
      WHERE r.employee_id = $1
      ORDER BY r.submission_date DESC, r.id DESC
    `, [employeeId]);
    return res.json({
      success: true,
      data: result.rows
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
 * Submit a new request or attendance correction ticket
 * HR Admin can raise for another employee via target_employee_id
 */
export async function submitMyRequest(req, res) {
  try {
    if (req.body?.target_employee_id && Number(req.body.target_employee_id) !== Number(req.user.id)) {
      return res.status(403).json({ success: false, error: 'Personal requests must be for your own account. HR should use attendance correction tickets for another employee.' });
    }
    req.body = employeeRequestPayload(req.body);
    return createPersonalRequest(req, res);
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error.status ? error.message : 'Could not submit your request. Please retry.' });
  }
}

/**
 * PATCH /api/requests/:id/cancel
 * Cancel a pending request submitted by the logged-in user or raised by HR
 */
export async function cancelMyRequest(req, res) {
  try {
    const userId = req.user.id;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid request ID.' });
    }
    const cancelled = await transaction(async client => {
      const result = await client.query(
        `UPDATE requests
         SET status = 'CANCELLED'
         WHERE id = $1
           AND (employee_id = $2 OR metadata->>'raised_by' = $2::text)
           AND status = 'PENDING'
         RETURNING *`,
        [id, userId]
      );
      if (!result.rowCount) {
        throw Object.assign(new Error('Only pending requests you own or raised can be cancelled.'), { status: 400 });
      }
      const cancelled = result.rows[0];
      const nowIso = new Date().toISOString();

      // Every change must be recorded in an audit log
      await client.query(`
        INSERT INTO application_audit_log (application_id, actor_id, action, old_status, new_status, remark, created_at)
        VALUES ($1, $2, 'cancel', 'PENDING', 'CANCELLED', 'Ticket cancelled by user', $3)
      `, [id, userId, nowIso]);
      return cancelled;
    });

    return res.json({
      success: true,
      message: 'Ticket cancelled successfully.',
      data: cancelled
    });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/requests/:id/audit-log
 * Get full audit log history for a ticket
 */
export async function getRequestAuditLog(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid request ID.' });
    }
    const ticket = await query('SELECT employee_id FROM requests WHERE id = $1', [id]);
    if (!ticket.rowCount || (req.user.role === 'EMPLOYEE' && Number(ticket.rows[0].employee_id) !== Number(req.user.id))) {
      return res.status(404).json({ success: false, error: 'Request not found.' });
    }
    const result = await query(`
      SELECT al.*, e.first_name, e.last_name, e.role as actor_role, e.employee_id as emp_code
      FROM application_audit_log al
      LEFT JOIN employees e ON e.id = al.actor_id
      WHERE al.application_id = $1
      ORDER BY al.created_at ASC
    `, [id]);
    return res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
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
