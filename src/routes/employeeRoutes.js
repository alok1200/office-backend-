import express from 'express';
import { authenticateUser, requireRoles } from '../middleware/auth.js';
import {
  getMyProfile,
  getMyAssets,
  getCompanyEmployees,
  getEmployeeAttendanceHistory,
  getEmployeeDetails,
  createEmployee,
  addEmployeeAsset,
  returnEmployeeAsset,
  forbidEmployeeEdit
} from '../controllers/employeeController.js';

const router = express.Router();

router.use(authenticateUser);

// Own profile and assets (declared before '/:id' routes)
router.get('/me', getMyProfile);
router.get('/me/assets', requireRoles('HR_ADMIN'), getMyAssets);

// Company directory: HR Admin and Super Admin can view
router.get('/company', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), getCompanyEmployees);
router.get('/:id/attendance-history', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), getEmployeeAttendanceHistory);

// Employee onboarding and company assets: HR Admin ONLY (not Super Admin, not Employee)
router.post('/company', requireRoles('HR_ADMIN'), createEmployee);
router.get('/:id/details', requireRoles('HR_ADMIN'), getEmployeeDetails);
router.post('/:id/assets', requireRoles('HR_ADMIN'), addEmployeeAsset);
router.patch('/assets/:assetId/return', requireRoles('HR_ADMIN'), returnEmployeeAsset);

// Editing or deleting existing employees is still not allowed
router.put('/:id', forbidEmployeeEdit);
router.delete('/:id', forbidEmployeeEdit);

export default router;
