import { query } from '../db/index.js';
import { configuredOffice } from '../services/officeConfiguration.js';
import { verifyPunchGeofence } from '../services/punchGeofence.js';
function getTodayDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function calculateDurations(attendance, breaks) {
  let totalBreakMinutes = 0;
  const now = new Date();

  // Calculate completed and active breaks
  for (const b of breaks) {
    if (b.break_end) {
      const start = new Date(b.break_start);
      const end = new Date(b.break_end);
      const diffMins = Math.max(0, Math.floor((end - start) / (1000 * 60)));
      totalBreakMinutes += diffMins;
    } else if (attendance.current_state === 'ON_BREAK') {
      const start = new Date(b.break_start);
      const diffMins = Math.max(0, Math.floor((now - start) / (1000 * 60)));
      totalBreakMinutes += diffMins;
    }
  }
  let totalWorkMinutes = 0;
  if (attendance.check_in) {
    const checkIn = new Date(attendance.check_in);
    const endReference = attendance.check_out ? new Date(attendance.check_out) : now;
    const totalElapsedMins = Math.max(0, Math.floor((endReference - checkIn) / (1000 * 60)));
    totalWorkMinutes = Math.max(0, totalElapsedMins - totalBreakMinutes);
  }
  return {
    totalWorkMinutes,
    totalBreakMinutes
  };
}

/**
 * GET /api/attendance/today
 * Returns today's attendance record & punch state for current employee
 */
export async function getTodayAttendance(req, res) {
  try {
    const employeeId = req.user.id;
    const today = getTodayDateString();
    let record = null;
    let breaks = [];
    const attRes = await query('SELECT * FROM attendances WHERE employee_id = $1 AND work_date = $2', [employeeId, today]);
    if (attRes.rows.length > 0) {
      record = attRes.rows[0];
      const breaksRes = await query('SELECT * FROM attendance_breaks WHERE attendance_id = $1 ORDER BY break_start ASC', [record.id]);
      breaks = breaksRes.rows;
    }
    if (!record) {
      return res.json({
        success: true,
        data: {
          work_date: today,
          current_state: 'NOT_CHECKED_IN',
          check_in: null,
          check_out: null,
          total_work_minutes: 0,
          total_break_minutes: 0,
          status: 'NOT_CHECKED_IN',
          breaks: [],
          can_record_attendance: req.user.can_record_attendance
        }
      });
    }
    const {
      totalWorkMinutes,
      totalBreakMinutes
    } = calculateDurations(record, breaks);
    return res.json({
      success: true,
      data: {
        ...record,
        total_work_minutes: totalWorkMinutes,
        total_break_minutes: totalBreakMinutes,
        breaks,
        can_record_attendance: req.user.can_record_attendance
      }
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

/**
 * POST /api/attendance/punch
 * State machine attendance punch: CHECK_IN, START_BREAK, END_BREAK, CHECK_OUT
 */
export async function recordPunch(req, res) {
  try {
    const employee = req.user;

    // Check if attendance recording is enabled for account
    if (!employee.can_record_attendance || employee.role === 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        error: 'SUPER_ADMIN_NO_ATTENDANCE',
        message: 'Super Admin has no attendance. Attendance recording is disabled for this role.'
      });
    }
    const {
      action
    } = req.body;
    const validActions = ['CHECK_IN', 'START_BREAK', 'END_BREAK', 'CHECK_OUT'];
    if (!validActions.includes(action)) return res.status(400).json({
      success: false,
      error: 'INVALID_ACTION',
      message: 'Choose a valid attendance action.'
    });
    { // Every attendance action requires current GPS inside the fixed 15 m boundary.
      try {
        verifyPunchGeofence(await configuredOffice(employee), req.body);
      } catch (error) {
        if (!error.code) throw error;
        return res.status(error.status || 400).json({
          success: false,
          error: error.code,
          message: error.message,
          ...error.details
        });
      }
    }
    const today = getTodayDateString();
    const nowIso = new Date().toISOString();
    let record = null;
    let breaks = [];
    const attRes = await query('SELECT * FROM attendances WHERE employee_id = $1 AND work_date = $2', [employee.id, today]);
    if (attRes.rows.length > 0) {
      record = attRes.rows[0];
      const breaksRes = await query('SELECT * FROM attendance_breaks WHERE attendance_id = $1 ORDER BY break_start ASC', [record.id]);
      breaks = breaksRes.rows;
    }
    const currentState = record ? record.current_state : 'NOT_CHECKED_IN';

    // State machine validation
    switch (action) {
      case 'CHECK_IN':
        {
          if (currentState !== 'NOT_CHECKED_IN') {
            return res.status(400).json({
              success: false,
              error: `Cannot Check In: Current attendance state is '${currentState}'. Duplicate check-ins are prevented.`
            });
          }
          const insertRes = await query(`INSERT INTO attendances (employee_id, work_date, current_state, check_in, status, updated_at)
             VALUES ($1, $2, 'CHECKED_IN', $3, 'PRESENT', $3)
             ON CONFLICT (employee_id, work_date)
             DO UPDATE SET current_state = 'CHECKED_IN', check_in = $3, status = 'PRESENT', updated_at = $3
             RETURNING *`, [employee.id, today, nowIso]);
          record = insertRes.rows[0];
          break;
        }
      case 'START_BREAK':
        {
          if (currentState !== 'CHECKED_IN') {
            return res.status(400).json({
              success: false,
              error: `Cannot Start Break: You must be actively checked in. Current state: '${currentState}'.`
            });
          }
          await query(`UPDATE attendances SET current_state = 'ON_BREAK', updated_at = $1 WHERE id = $2`, [nowIso, record.id]);
          const breakRes = await query(`INSERT INTO attendance_breaks (attendance_id, break_start) VALUES ($1, $2) RETURNING *`, [record.id, nowIso]);
          record.current_state = 'ON_BREAK';
          breaks.push(breakRes.rows[0]);
          break;
        }
      case 'END_BREAK':
        {
          if (currentState !== 'ON_BREAK') {
            return res.status(400).json({
              success: false,
              error: `Cannot End Break: You are not currently on break. Current state: '${currentState}'.`
            });
          }
          const activeBreak = breaks.find(b => !b.break_end);
          const breakStart = activeBreak ? new Date(activeBreak.break_start) : new Date();
          const durationMins = Math.max(0, Math.floor((new Date(nowIso) - breakStart) / (1000 * 60)));
          if (activeBreak) {
            await query(`UPDATE attendance_breaks SET break_end = $1, duration_minutes = $2 WHERE id = $3`, [nowIso, durationMins, activeBreak.id]);
          }
          await query(`UPDATE attendances SET current_state = 'CHECKED_IN', updated_at = $1 WHERE id = $2`, [nowIso, record.id]);
          record.current_state = 'CHECKED_IN';
          if (activeBreak) {
            activeBreak.break_end = nowIso;
            activeBreak.duration_minutes = durationMins;
          }
          break;
        }
      case 'CHECK_OUT':
        {
          if (currentState !== 'CHECKED_IN') {
            return res.status(400).json({
              success: false,
              error: `Cannot Check Out: Must be checked in and not on break. Current state: '${currentState}'.`
            });
          }
          const {
            totalWorkMinutes,
            totalBreakMinutes
          } = calculateDurations(record, breaks);
          // Half day threshold: less than 5 hours (300 mins) = HALF_DAY, else PRESENT
          const finalStatus = totalWorkMinutes < 300 ? 'HALF_DAY' : 'PRESENT';
          const updRes = await query(`UPDATE attendances
             SET current_state = 'CHECKED_OUT', check_out = $1, total_work_minutes = $2, total_break_minutes = $3, status = $4, updated_at = $1
             WHERE id = $5
             RETURNING *`, [nowIso, totalWorkMinutes, totalBreakMinutes, finalStatus, record.id]);
          record = updRes.rows[0];
          break;
        }
    }
    const {
      totalWorkMinutes,
      totalBreakMinutes
    } = calculateDurations(record, breaks);
    return res.json({
      success: true,
      message: `Successfully executed '${action}'.`,
      data: {
        ...record,
        total_work_minutes: totalWorkMinutes,
        total_break_minutes: totalBreakMinutes,
        breaks
      }
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

/**
 * GET /api/attendance/calendar
 * Monthly attendance calendar data for logged in employee
 */
export async function getMyCalendar(req, res) {
  try {
    const employeeId = req.user.id;
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;
    const monthStr = String(month).padStart(2, '0');
    const startPattern = `${year}-${monthStr}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endPattern = `${year}-${monthStr}-${String(lastDay).padStart(2, '0')}`;
    let attendances = [];
    let holidays = [];
    const attRes = await query(`SELECT a.*, 
          COALESCE(json_agg(b.*) FILTER (WHERE b.id IS NOT NULL), '[]') as breaks
         FROM attendances a
         LEFT JOIN attendance_breaks b ON a.id = b.attendance_id
         WHERE a.employee_id = $1 AND a.work_date >= $2 AND a.work_date <= $3
         GROUP BY a.id
         ORDER BY a.work_date ASC`, [employeeId, startPattern, endPattern]);
    attendances = attRes.rows;
    const holRes = await query(`SELECT * FROM holidays WHERE holiday_date >= $1 AND holiday_date <= $2`, [startPattern, endPattern]);
    holidays = holRes.rows;

    // Build complete month day matrix
    const daysInMonth = [];
    for (let day = 1; day <= lastDay; day++) {
      const dayStr = `${year}-${monthStr}-${String(day).padStart(2, '0')}`;
      const dateObj = new Date(year, month - 1, day);
      const dayOfWeek = dateObj.getDay(); // 0 is Sunday, 6 is Saturday

      const existingAtt = attendances.find(a => a.work_date === dayStr);
      const holiday = holidays.find(h => h.holiday_date === dayStr);
      let status = 'ABSENT';
      let statusDetails = null;
      if (holiday) {
        status = 'HOLIDAY';
        statusDetails = holiday.name;
      } else if (existingAtt) {
        status = existingAtt.status;
        statusDetails = existingAtt.notes;
      } else if (dayOfWeek === 0 || dayOfWeek === 6) {
        status = 'WEEKLY_OFF';
        statusDetails = dayOfWeek === 0 ? 'Sunday Weekly Off' : 'Saturday Weekly Off';
      }
      daysInMonth.push({
        date: dayStr,
        day,
        dayOfWeek,
        status,
        statusDetails,
        attendance: existingAtt || null,
        holiday: holiday || null
      });
    }
    return res.json({
      success: true,
      data: {
        year,
        month,
        days: daysInMonth
      }
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

/**
 * GET /api/attendance/company (HR Admin view-only)
 */
export async function getCompanyAttendance(req, res) {
  try {
    const {
      date,
      department,
      status,
      search
    } = req.query;
    const targetDate = date || getTodayDateString();
    let list = [];
    let sql = `
        SELECT a.*, e.employee_id as emp_code, e.first_name, e.last_name, e.department_name, e.designation,
          COALESCE(json_agg(b.*) FILTER (WHERE b.id IS NOT NULL), '[]') as breaks
        FROM employees e
        LEFT JOIN attendances a ON e.id = a.employee_id AND a.work_date = $1
        LEFT JOIN attendance_breaks b ON a.id = b.attendance_id
        WHERE e.is_active = true AND e.role != 'SUPER_ADMIN'
      `;
    const params = [targetDate];
    if (department && department !== 'ALL') {
      params.push(department);
      sql += ` AND e.department_name = $${params.length}`;
    }
    if (status && status !== 'ALL') {
      params.push(status);
      sql += ` AND a.status = $${params.length}`;
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      sql += ` AND (LOWER(e.first_name || ' ' || e.last_name) LIKE $${params.length} OR LOWER(e.employee_id) LIKE $${params.length})`;
    }
    sql += ` GROUP BY e.id, a.id ORDER BY e.id ASC`;
    const result = await query(sql, params);
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

/**
 * GET /api/attendance/summary (HR Admin Dashboard Summary Cards)
 */
export async function getCompanySummary(req, res) {
  try {
    const today = getTodayDateString();
    let totalEmployees = 0;
    let presentToday = 0;
    let onLeaveOrWfh = 0;
    let absent = 0;
    const empRes = await query("SELECT COUNT(*) FROM employees WHERE is_active = true AND role != 'SUPER_ADMIN'");
    totalEmployees = parseInt(empRes.rows[0].count, 10);
    const presentRes = await query("SELECT COUNT(*) FROM attendances WHERE work_date = $1 AND status IN ('PRESENT', 'HALF_DAY')", [today]);
    presentToday = parseInt(presentRes.rows[0].count, 10);
    const leaveRes = await query("SELECT COUNT(*) FROM attendances WHERE work_date = $1 AND status = 'LEAVE'", [today]);
    onLeaveOrWfh = parseInt(leaveRes.rows[0].count, 10);
    absent = Math.max(0, totalEmployees - presentToday - onLeaveOrWfh);
    return res.json({
      success: true,
      data: {
        totalEmployees,
        presentToday,
        onLeaveOrWfh,
        absent,
        date: today
      }
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}
