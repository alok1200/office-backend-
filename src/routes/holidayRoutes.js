import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { getHolidays, createHoliday, updateHoliday, deleteHoliday } from '../controllers/holidayController.js';
import { requireSuperAdmin } from '../middleware/superAdmin.js';

const router = express.Router();

router.use(authenticateUser);

// All authenticated roles (Employee, HR Admin, Super Admin) can read holidays
router.get('/', getHolidays);

// Super Admin only write operations
router.post('/', requireSuperAdmin, createHoliday);
router.put('/:id', requireSuperAdmin, updateHoliday);
router.delete('/:id', requireSuperAdmin, deleteHoliday);

export default router;
