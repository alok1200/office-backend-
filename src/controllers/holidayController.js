import { query } from '../db/index.js';
export async function getHolidays(req, res) {
  try {
    let list = [];
    const result = await query('SELECT * FROM holidays ORDER BY holiday_date ASC');
    list = result.rows;
    return res.json({
      success: true,
      data: list
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
