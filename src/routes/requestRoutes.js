import express from 'express';
import { createPersonalRequest } from '../controllers/superAdminRequestsController.js';
import { authenticateUser, requireRoles } from '../middleware/auth.js';
import {
  getMyRequests,
  submitMyRequest,
  getCompanyRequests,
  decideRequest
} from '../controllers/requestController.js';

const router = express.Router();

router.use(authenticateUser);

// Employee & HR own requests
router.get('/my', getMyRequests);
router.post('/my', (req, res) => req.user.role === 'SUPER_ADMIN' ? createPersonalRequest(req, res) : submitMyRequest(req, res));

// HR Admin company-wide read-only view
router.get('/company', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), getCompanyRequests);

// Request decision endpoints (Reserved for future Super Admin phase)
// HR Admin and Employee will be blocked
router.post('/:id/approve', decideRequest);
router.post('/:id/reject', decideRequest);
router.post('/:id/decide', decideRequest);

export default router;
