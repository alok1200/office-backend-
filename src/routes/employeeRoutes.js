import express from 'express';
import { authenticateUser, requireRoles } from '../middleware/auth.js';
import {
  getMyProfile,
  getCompanyEmployees,
  getEmployeeAttendanceHistory,
  forbidEmployeeEdit
} from '../controllers/employeeController.js';

const router = express.Router();

router.use(authenticateUser);

// Own profile
router.get('/me', getMyProfile);

// HR Admin company directory (view-only)
router.get('/company', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), getCompanyEmployees);
router.get('/:id/attendance-history', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), getEmployeeAttendanceHistory);

// Forbidden write actions for HR Admin
router.post('/company', forbidEmployeeEdit);
router.put('/:id', forbidEmployeeEdit);
router.delete('/:id', forbidEmployeeEdit);

export default router;
