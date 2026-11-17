import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { getHolidays } from '../controllers/holidayController.js';

const router = express.Router();

router.use(authenticateUser);

router.get('/', getHolidays);

export default router;
