// src/controllers/superAdminController.js
import { query } from '../db/index.js';
import { auditLog } from '../utils/auditLog.js';

/**
 * GET /api/super-admin/dashboard
 * Returns aggregated data for the Super Admin dashboard.
 */
export async function getDashboardData(req, res) {
  try {
    // ---- Geofence Config ----
    let geofence = null;
    const gfRes = await query('SELECT * FROM geofenceconfigs ORDER BY created_at DESC LIMIT 1');
    geofence = gfRes.rows[0] || null;

    // ---- Pending Requests (top 5) ----
    const pendingRes = await query(`SELECT r.id, r.type, r.startdate, r.enddate, r.days, r.reason,
              u.name, u.empcode
       FROM requests r
       JOIN users u ON r.userid = u.id
       WHERE r.status = 'PENDING'
       ORDER BY r.createdat ASC
       LIMIT 5`);

    // ---- Organization Attendance Summary ----
    const summaryRes = await query(`SELECT status, COUNT(*) AS cnt FROM attendances GROUP BY status`);
    const orgSummary = {};
    summaryRes.rows.forEach(row => {
      orgSummary[row.status] = Number(row.cnt);
    });

    // ---- Team Status (first 12 users, excluding SUPER_ADMIN) ----
    const teamRes = await query(`SELECT u.id, u.name, u.empcode, u.department, u.role,
              (SELECT status FROM attendances a WHERE a.userid = u.id ORDER BY date DESC LIMIT 1) AS latestStatus
       FROM users u
       WHERE u.role <> 'SUPER_ADMIN'
       ORDER BY u.name ASC
       LIMIT 12`);

    // ---- Recent Attendance Logs (latest 5) ----
    const recentRes = await query(`SELECT a.id, u.name, a.date, a.status, a.checkin, a.checkout,
              a.workminutes, a.mode
       FROM attendances a
       JOIN users u ON a.userid = u.id
       ORDER BY a.date DESC
       LIMIT 5`);
    res.json({
      success: true,
      data: {
        geofence,
        pendingRequests: pendingRes.rows,
        orgSummary,
        teamStatus: teamRes.rows,
        recentAttendance: recentRes.rows
      }
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

/**
 * PATCH /api/requests/:id/decision
 * Accept or reject a request with audit logging.
 */
export async function decisionOnRequest(req, res) {
  const {
    id
  } = req.params;
  const {
    status,
    reviewNote
  } = req.body; // status = 'APPROVED' | 'REJECTED'
  if (!['APPROVED', 'REJECTED'].includes(status)) {
    return res.status(400).json({
      error: 'Invalid status value.'
    });
  }
  try {
    const updRes = await query(`UPDATE requests SET status = $1, reviewedby = $2, reviewnote = $3, updatedat = NOW()
       WHERE id = $4 RETURNING *`, [status, req.user.id, reviewNote ?? null, id]);
    if (updRes.rowCount === 0) {
      return res.status(404).json({
        error: 'Request not found.'
      });
    }
    await auditLog(`${status}_REQUEST`, 'Request', id, JSON.stringify({
      reviewer: req.user.id,
      note: reviewNote
    }));
    res.json({
      success: true,
      data: updRes.rows[0]
    });
  } catch (err) {
    console.error('Decision error:', err);
    res.status(500).json({
      error: err.message
    });
  }
}

// Additional CRUD handlers (users, attendance, geofence) can be added similarly.
