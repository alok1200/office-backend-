import express from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { getMyNotifications, markNotificationAsRead } from '../controllers/notificationController.js';

const router = express.Router();

router.use(authenticateUser);

router.get('/', getMyNotifications);
router.patch('/:id/read', markNotificationAsRead);

export default router;
