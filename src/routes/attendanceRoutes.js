import express from 'express';
import { authenticateUser, requireRoles } from '../middleware/auth.js';
import { blockSuperAdminPunch } from '../middleware/superAdmin.js';
import {
  getTodayAttendance,
  recordPunch,
  getMyCalendar,
  getCompanyAttendance,
  getCompanySummary
} from '../controllers/attendanceController.js';

const router = express.Router();

// Apply auth to all attendance routes
router.use(authenticateUser);

// Employee & HR own attendance endpoints
router.get('/today', getTodayAttendance);
router.post('/punch', blockSuperAdminPunch, recordPunch);
router.get('/calendar', getMyCalendar);

// HR Admin company-wide endpoints (view-only)
router.get('/company', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), getCompanyAttendance);
router.get('/summary', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), getCompanySummary);

// Explicitly reject modification attempts on company attendance
router.all(['/company/edit', '/company/regularize', '/company/punch-behalf'], (req, res) => {
  return res.status(403).json({
    success: false,
    error: 'Action Forbidden: Modifying another employee attendance or punching on their behalf is not permitted.'
  });
});

export default router;
