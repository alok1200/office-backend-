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
  resetEmployeePassword,
  updateEmployee,
  deleteEmployee,
  forbidEmployeeEdit
} from '../controllers/employeeController.js';

const router = express.Router();

router.use(authenticateUser);

// Own profile and assets (declared before '/:id' routes)
router.get('/me', getMyProfile);
router.get('/me/assets', requireRoles('EMPLOYEE', 'HR_ADMIN'), getMyAssets);

// Company directory: HR Admin and Super Admin can view
router.get('/company', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), getCompanyEmployees);
router.get('/:id/attendance-history', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), getEmployeeAttendanceHistory);

router.post('/company', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), createEmployee);
// Employee details and ongoing asset management are restricted to HR Admin.
router.get('/:id/details', requireRoles('HR_ADMIN'), getEmployeeDetails);
router.post('/:id/assets', requireRoles('HR_ADMIN'), addEmployeeAsset);
router.patch('/assets/:assetId/return', requireRoles('HR_ADMIN'), returnEmployeeAsset);
router.patch('/:id/password', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), resetEmployeePassword);

// HR Admin can edit Employee accounts; HR Admin can delete Employees, Super Admin can delete HR Admins
router.put('/:id', requireRoles('HR_ADMIN'), updateEmployee);
router.delete('/:id', requireRoles('HR_ADMIN', 'SUPER_ADMIN'), deleteEmployee);

export default router;
