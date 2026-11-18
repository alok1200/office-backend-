import { query } from '../db/index.js';

export async function getHolidays(req, res) {
  try {
    const result = await query('SELECT * FROM holidays ORDER BY holiday_date ASC');
    return res.json({
      success: true,
      data: result.rows
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

// Create a new holiday (Super Admin only)
export async function createHoliday(req, res) {
  const { holiday_date, name, description, holiday_type } = req.body;
  if (!holiday_date || !name) {
    return res.status(400).json({ success: false, error: 'Holiday date and name are required.' });
  }
  try {
    const result = await query(
      'INSERT INTO holidays (holiday_date, name, description, holiday_type) VALUES ($1, $2, $3, $4) RETURNING *',
      [holiday_date, name.trim(), (description || '').trim(), holiday_type || 'OFFICIAL']
    );
    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        error: `A holiday is already marked for date ${holiday_date}. Please edit the existing holiday or choose a different date.`
      });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
}

// Update an existing holiday (Super Admin only)
export async function updateHoliday(req, res) {
  const { id } = req.params;
  const { holiday_date, name, description, holiday_type } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, error: 'Holiday ID is required.' });
  }
  if (!holiday_date || !name) {
    return res.status(400).json({ success: false, error: 'Holiday date and name are required.' });
  }
  try {
    const result = await query(
      'UPDATE holidays SET holiday_date = $1, name = $2, description = $3, holiday_type = $4 WHERE id = $5 RETURNING *',
      [holiday_date, name.trim(), (description || '').trim(), holiday_type || 'OFFICIAL', id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Holiday not found.' });
    }
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        error: `A holiday is already marked for date ${holiday_date}. Please choose a different date.`
      });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
}

// Delete a holiday (Super Admin only)
export async function deleteHoliday(req, res) {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ success: false, error: 'Holiday ID is required.' });
  }
  try {
    const result = await query('DELETE FROM holidays WHERE id = $1 RETURNING *', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Holiday not found.' });
    }
    return res.json({ success: true, message: 'Holiday deleted successfully.', data: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
