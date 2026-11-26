import { query, transaction } from '../db/index.js';
import { reportPeriod, indiaDate } from '../services/superAdminAttendanceReport.js';
import { plannedRequestForDate, resolveAttendanceStatus } from '../services/plannedAttendance.js';
import { companyDate, companyAttendance } from '../services/companyAttendance.js';
import { configuredOffice } from '../services/officeConfiguration.js';
import { verifyPunchLocation } from '../services/punchGeofence.js';
const punchMessages = new Map([
  ['CHECK_IN', 'Checked in'],
  ['START_BREAK', 'Started break'],
  ['END_BREAK', 'Ended break'],
  ['CHECK_OUT', 'Checked out']
]);
function getTodayDateString() { return indiaDate(); }
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
    const result = await transaction(async client => {
      const query = client.query.bind(client);
      let status = 200;
      const response = { status(code) { status = code; return this; }, json(body) { return { status, body }; } };
      const employee = req.user;
      const account = (await query('SELECT is_active, office_id FROM employees WHERE id=$1 FOR UPDATE', [employee.id])).rows[0];
      if (!account?.is_active) return response.status(403).json({ success: false, error: 'Your account is inactive.' });

      // Check if attendance recording is enabled for account
      if (!employee.can_record_attendance || employee.role === 'SUPER_ADMIN') {
        return response.status(403).json({
          success: false,
          error: 'SUPER_ADMIN_NO_ATTENDANCE',
          message: 'Super Admin has no attendance. Attendance recording is disabled for this role.'
        });
      }
      const {
        action
      } = req.body;
      if (!punchMessages.has(action)) return response.status(400).json({
        success: false,
        error: 'INVALID_ACTION',
        message: 'Choose a valid attendance action.'
      });
      const office = await configuredOffice(account, query);
      let verificationMethod;
      try {
        verificationMethod = verifyPunchLocation(office, req);
      } catch (error) {
        if (!error.code) throw error;
        return response.status(error.status || 400).json({
          success: false,
          error: error.code,
          message: error.message,
          ...error.details
        });
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
              return response.status(400).json({
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
              return response.status(400).json({
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
              return response.status(400).json({
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
              return response.status(400).json({
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
      return response.json({
        success: true,
        message: verificationMethod === 'OFFICE_WIFI'
          ? `${punchMessages.get(action)} using office Wi-Fi.`
          : `Successfully executed '${action}'.`,
        verification_method: verificationMethod,
        data: {
          ...record,
          total_work_minutes: totalWorkMinutes,
          total_break_minutes: totalBreakMinutes,
          breaks
        }
      });
    });
    return res.status(result.status).json(result.body);
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
    let employeeId = req.user.id;
    if(req.query.employee_id!==undefined){
      if(req.user.role!=='SUPER_ADMIN')return res.status(403).json({success:false,error:'Only Super Admin can select another employee calendar.'});
      employeeId=Number(req.query.employee_id);
      if(!Number.isSafeInteger(employeeId)||employeeId<=0)return res.status(400).json({success:false,error:'Invalid employee ID.'});
      const target=(await query("SELECT id FROM employees WHERE id=$1 AND is_active=true AND role<>'SUPER_ADMIN'",[employeeId])).rows[0];
      if(!target)return res.status(404).json({success:false,error:'Employee calendar not found.'});
    }
    const today = indiaDate();
    const { year, month, first: startPattern, last: endPattern } = reportPeriod({ year: req.query.year ?? today.slice(0,4), month: req.query.month ?? today.slice(5,7) });
    const monthStr = String(month).padStart(2, '0');
    const lastDay = Number(endPattern.slice(-2));
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

    const requests = (await query("SELECT * FROM requests WHERE employee_id=$1 AND status IN ('APPROVED','REJECTED') AND start_date<=$3 AND end_date>=$2 ORDER BY decision_date DESC NULLS LAST, id DESC", [employeeId, startPattern, endPattern])).rows;
    // Build complete month day matrix
    const daysInMonth = [];
    for (let day = 1; day <= lastDay; day++) {
      const dayStr = `${year}-${monthStr}-${String(day).padStart(2, '0')}`;
      const dateObj = new Date(Date.UTC(year, month - 1, day));
      const dayOfWeek = dateObj.getUTCDay(); // 0 is Sunday, 6 is Saturday

      const existingAtt = attendances.find(a => a.work_date === dayStr);
      const holiday = holidays.find(h => h.holiday_date === dayStr);
      const planned=plannedRequestForDate(requests,employeeId,dayStr);
      const rejected=requests.find(r => r.status === 'REJECTED' && String(r.start_date).slice(0, 10) <= dayStr && String(r.end_date).slice(0, 10) >= dayStr) || null;
      let status=resolveAttendanceStatus({attendance:existingAtt,holiday,planned,workDate:dayStr,today});
      if(req.user.role==='SUPER_ADMIN'&&req.query.employee_id===undefined&&!holiday&&status!=='WEEKLY_OFF')status='NOT_APPLICABLE';
      const statusDetails=existingAtt?.notes||holiday?.name||planned?.metadata?.label||null;
      daysInMonth.push({
        date: dayStr,
        day,
        dayOfWeek,
        status,
        statusDetails,
        attendance: existingAtt || null,
        holiday: holiday || null,
        decision: planned
          ? { id: planned.id, status: 'APPROVED', request_type: planned.request_type, remarks: planned.decision_remarks || null }
          : rejected
            ? { id: rejected.id, status: 'REJECTED', request_type: rejected.request_type, remarks: rejected.decision_remarks || null }
            : null
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
    return res.status(err.status || 500).json({
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
    const data=await companyAttendance(companyDate(req.query.date), req.query);
    return res.json({success:true,data});
  } catch(error) { return res.status(error.status || 500).json({success:false,error:error.status ? error.message : 'Could not load company attendance. Please retry.'}); }
}

/** GET /api/attendance/summary — active company members, using the same attendance policy as reports. */
export async function getCompanySummary(req, res) {
  try {
    const date=indiaDate(), rows=await companyAttendance(date);
    return res.json({success:true,data:{
      totalEmployees:rows.length,
      presentToday:rows.filter(row=>['PRESENT','HALF_DAY'].includes(row.status)).length,
      onLeaveOrWfh:rows.filter(row=>['LEAVE','WFH'].includes(row.status)).length,
      absent:rows.filter(row=>['ABSENT','NOT_CHECKED_IN'].includes(row.status)).length,
      date
    }});
  } catch { return res.status(500).json({success:false,error:'Could not load company summary. Please retry.'}); }
}
