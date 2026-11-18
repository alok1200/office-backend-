import express from 'express';
import { createPersonalRequest } from '../controllers/superAdminRequestsController.js';
import { authenticateUser, requireRoles } from '../middleware/auth.js';
import {
  getMyRequests,
  submitMyRequest,
  cancelMyRequest,
  getCompanyRequests,
  decideRequest,
  getRequestAuditLog
} from '../controllers/requestController.js';

import { listAttendanceCorrections, createAttendanceCorrection, correctionAudit } from '../controllers/attendanceCorrectionsController.js';
const router = express.Router();

router.use(authenticateUser);
router.get('/attendance-corrections', requireRoles('EMPLOYEE','HR_ADMIN','SUPER_ADMIN'), listAttendanceCorrections);
router.post('/attendance-corrections', requireRoles('HR_ADMIN'), createAttendanceCorrection);
router.get('/attendance-corrections/:id/audit', requireRoles('EMPLOYEE','HR_ADMIN','SUPER_ADMIN'), correctionAudit);

// Employee & HR own requests
router.get('/my', getMyRequests);
router.post('/my', (req, res) => req.user.role === 'SUPER_ADMIN' ? createPersonalRequest(req, res) : submitMyRequest(req, res));
router.patch('/:id/cancel', cancelMyRequest);
router.get('/:id/audit-log', getRequestAuditLog);

// HR Admin company-wide read-only view
router.get('/company', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), getCompanyRequests);

// Request decision endpoints (Reserved for future Super Admin phase)
// HR Admin and Employee will be blocked
router.post('/:id/approve', decideRequest);
router.post('/:id/reject', decideRequest);
router.post('/:id/decide', decideRequest);

export default router;
