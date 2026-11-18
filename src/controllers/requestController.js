import { query } from '../db/index.js';

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
      WHERE r.employee_id = $1 OR (r.metadata->>'raised_by_id')::int = $1
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
    const {
      request_type,
      start_date,
      end_date,
      reason,
      metadata,
      target_employee_id
    } = req.body;

    // Determine target employee: HR Admin and Super Admin can raise on behalf of another employee
    let employeeId = req.user.id;
    if (target_employee_id && (req.user.role === 'HR_ADMIN' || req.user.role === 'SUPER_ADMIN')) {
      const parsedTarget = Number(target_employee_id);
      if (Number.isSafeInteger(parsedTarget) && parsedTarget > 0) {
        employeeId = parsedTarget;
      }
    }

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
    const metaObj = metadata && typeof metadata === 'object' ? { ...metadata } : {};

    // If raised by HR Admin on behalf of an employee
    if (employeeId !== req.user.id) {
      metaObj.raised_by_id = req.user.id;
      metaObj.raised_by_name = `${req.user.first_name} ${req.user.last_name}`;
      metaObj.raised_by_role = req.user.role;

      const targetEmp = (await query('SELECT first_name, last_name, employee_id, department_name FROM employees WHERE id = $1', [employeeId])).rows[0];
      if (targetEmp) {
        metaObj.target_employee_name = `${targetEmp.first_name} ${targetEmp.last_name}`;
        metaObj.target_emp_code = targetEmp.employee_id;
        metaObj.target_department = targetEmp.department_name;
      }
    }

    const insertRes = await query(`
      INSERT INTO requests (employee_id, request_type, start_date, end_date, reason, status, submission_date, metadata)
      VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7)
      RETURNING *
    `, [employeeId, request_type, start_date, end_date, reason.trim(), nowIso, JSON.stringify(metaObj)]);

    const newRequest = insertRes.rows[0];

    // Every change must be recorded in an audit log
    const auditRemark = employeeId !== req.user.id
      ? `Attendance correction ticket raised by HR Admin (${req.user.first_name} ${req.user.last_name}) for employee #${employeeId}`
      : `Ticket raised by employee #${employeeId}`;

    await query(`
      INSERT INTO application_audit_log (application_id, actor_id, action, old_status, new_status, remark, created_at)
      VALUES ($1, $2, 'submit', NULL, 'PENDING', $3, $4)
    `, [newRequest.id, req.user.id, auditRemark, nowIso]);

    // Send notification to Super Admins
    const superAdmins = (await query(`SELECT id FROM employees WHERE role = 'SUPER_ADMIN' AND is_active = TRUE`)).rows;
    for (const sa of superAdmins) {
      await query(`
        INSERT INTO notifications (recipient_id, title, message, category, is_read, created_at)
        VALUES ($1, $2, $3, 'REQUEST', false, $4)
      `, [
        sa.id,
        `New Attendance Correction Ticket #${newRequest.id}`,
        `${req.user.first_name} ${req.user.last_name} (${req.user.role}) raised an attendance correction ticket for work date ${start_date}.`,
        nowIso
      ]);
    }

    // If raised by HR for an employee, notify the employee as well
    if (employeeId !== req.user.id) {
      await query(`
        INSERT INTO notifications (recipient_id, title, message, category, is_read, created_at)
        VALUES ($1, $2, $3, 'ATTENDANCE', false, $4)
      `, [
        employeeId,
        `Attendance Correction Ticket #${newRequest.id} raised on your behalf`,
        `HR Admin (${req.user.first_name} ${req.user.last_name}) raised an attendance correction ticket for you on ${start_date}. Status: Pending Super Admin Review.`,
        nowIso
      ]);
    }

    return res.status(201).json({
      success: true,
      message: 'Attendance correction ticket submitted successfully and is pending Super Admin review.',
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
    const result = await query(
      `UPDATE requests
       SET status = 'CANCELLED'
       WHERE id = $1
         AND (employee_id = $2 OR (metadata->>'raised_by_id')::int = $2)
         AND status = 'PENDING'
       RETURNING *`,
      [id, userId]
    );
    if (!result.rowCount) {
      return res.status(400).json({ success: false, error: 'Only pending requests you own or raised can be cancelled.' });
    }
    const cancelled = result.rows[0];
    const nowIso = new Date().toISOString();

    // Every change must be recorded in an audit log
    await query(`
      INSERT INTO application_audit_log (application_id, actor_id, action, old_status, new_status, remark, created_at)
      VALUES ($1, $2, 'cancel', 'PENDING', 'CANCELLED', 'Ticket cancelled by user', $3)
    `, [id, userId, nowIso]);

    return res.json({
      success: true,
      message: 'Ticket cancelled successfully.',
      data: cancelled
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
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
