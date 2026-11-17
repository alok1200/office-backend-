import { query } from '../db/index.js';
export async function getMyNotifications(req, res) {
  try {
    let list;
    list = (await query(`SELECT n.*, (n.is_read OR nr.employee_id IS NOT NULL) AS is_read
        FROM notifications n LEFT JOIN notification_reads nr ON nr.notification_id=n.id AND nr.employee_id=$1
        WHERE n.recipient_id=$1 OR n.recipient_id IS NULL ORDER BY n.created_at DESC`, [req.user.id])).rows;
    res.json({
      success: true,
      data: list
    });
  } catch {
    res.status(500).json({
      success: false,
      error: 'Could not load notifications. Please retry.'
    });
  }
}
export async function markNotificationAsRead(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({
      success: false,
      error: 'Invalid notification ID.'
    });
    const visible = await query('SELECT id FROM notifications WHERE id=$1 AND (recipient_id=$2 OR recipient_id IS NULL)', [id, req.user.id]);
    if (!visible.rows.length) return res.status(404).json({
      success: false,
      error: 'Notification not found.'
    });
    await query('INSERT INTO notification_reads (notification_id,employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, req.user.id]);
    res.json({
      success: true,
      message: 'Notification marked as read.'
    });
  } catch {
    res.status(500).json({
      success: false,
      error: 'Could not mark notification as read. Please retry.'
    });
  }
}
