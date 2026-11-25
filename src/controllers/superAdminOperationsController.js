import { pool, query } from '../db/index.js';
import { calculateRequest, dateKey } from '../services/superAdminRequestPolicy.js';
import { buildMonthlyReport, reportPeriod, indiaDate } from '../services/superAdminAttendanceReport.js';
import { CORRECTION_WORKFLOW } from '../services/attendanceCorrections.js';
import { planDecision } from '../services/superAdminDecision.js';
import { csvExport, xlsxExport } from '../utils/reportExport.js';
import {planAttendanceEdit} from '../services/attendanceEdit.js';
const errorResponse = (res, error) => res.status(error.status || 500).json({
  success: false,
  error: error.status ? error.message : 'Could not complete the operation. Please retry.',
  ...(error.attendanceConflicts ? { attendance_conflicts: error.attendanceConflicts } : {})
});
const blocksTimeOff = (row, halfDay) => ['CHECKED_IN', 'ON_BREAK'].includes(row.current_state)
  || (!halfDay && Boolean(row.check_in || row.check_out));

export async function pendingApprovals(req, res) {
  try {
    const [{ rows }, { rows: holidays }, { rows: attendance }] = await Promise.all([
      query("SELECT r.*, e.first_name, e.last_name, e.employee_id AS emp_code, e.department_name FROM requests r JOIN employees e ON e.id = r.employee_id WHERE r.status = 'PENDING' ORDER BY r.submission_date, r.id"),
      query('SELECT holiday_date FROM holidays'),
      query(`SELECT r.id AS request_id, a.work_date, a.current_state, a.check_in, a.check_out
        FROM requests r JOIN attendances a ON a.employee_id = r.employee_id AND a.work_date BETWEEN r.start_date AND r.end_date
        WHERE r.status = 'PENDING' AND r.request_type IN ('LEAVE', 'HOLIDAY')
          AND (a.current_state IN ('CHECKED_IN', 'ON_BREAK') OR a.check_in IS NOT NULL OR a.check_out IS NOT NULL)
        ORDER BY r.id, a.work_date`)
    ]);
    const attendanceByRequest = new Map();
    for (const { request_id, ...record } of attendance) {
      if (!attendanceByRequest.has(request_id)) attendanceByRequest.set(request_id, []);
      attendanceByRequest.get(request_id).push(record);
    }
    const data = rows.map(row => {
      let reviewDays = null;
      let conflicts = [];
      try {
        const halfDay = row.request_type !== 'HOLIDAY' && row.metadata?.half_day === true;
        const calculation = calculateRequest({
          category: row.request_type === 'HOLIDAY' ? 'HOLIDAY' : row.metadata?.category || 'OFFICIAL',
          start_date: dateKey(row.start_date),
          end_date: dateKey(row.end_date),
          half_day: halfDay
        }, holidays);
        reviewDays = calculation.days;
        const dates = new Set(calculation.dates);
        conflicts = (attendanceByRequest.get(row.id) || []).filter(record => dates.has(dateKey(record.work_date)) && blocksTimeOff(record, halfDay));
      } catch {/* Invalid legacy dates require review; never invent a duration. */}
      return {
        ...row,
        review_days: reviewDays,
        attendance_conflicts: conflicts
      };
    });
    res.json({
      success: true,
      data
    });
  } catch (error) {
    errorResponse(res, error);
  }
}
export async function getHRRequests(req, res) {
  try {
    const { status, type } = req.query;
    let queryText = `
      SELECT r.*, e.first_name, e.last_name, e.employee_id AS emp_code, e.department_name, e.designation, e.avatar_url, e.role as employee_role
      FROM requests r
      JOIN employees e ON e.id = r.employee_id
      WHERE e.role = 'HR_ADMIN'
    `;
    const params = [];
    if (status && status !== 'ALL') {
      params.push(status);
      queryText += ` AND r.status = $${params.length}`;
    }
    if (type && type !== 'ALL') {
      params.push(type);
      queryText += ` AND r.request_type = $${params.length}`;
    }
    queryText += ` ORDER BY r.submission_date DESC, r.id DESC`;

    const rows = (await query(queryText, params)).rows;
    const holidays = (await query('SELECT holiday_date FROM holidays')).rows;
    const data = rows.map(row => {
      let reviewDays = null;
      try {
        reviewDays = calculateRequest({
          category: row.metadata?.category || 'OFFICIAL',
          start_date: dateKey(row.start_date),
          end_date: dateKey(row.end_date),
          half_day: row.metadata?.half_day === true
        }, holidays).days;
      } catch {
        /* Invalid legacy dates require review */
      }
      return {
        ...row,
        review_days: reviewDays
      };
    });
    res.json({
      success: true,
      data
    });
  } catch (error) {
    errorResponse(res, error);
  }
}
export async function getAllRequests(req, res) {
  try {
    const { status, type, role, search } = req.query;
    let queryText = `
      SELECT r.*,
             e.first_name,
             e.last_name,
             e.employee_id AS emp_code,
             e.department_name,
             e.designation,
             e.avatar_url,
             e.role AS employee_role,
             a.id AS attendance_record_id,
             a.check_in AS recorded_check_in,
             a.check_out AS recorded_check_out,
             a.status AS recorded_status,
             a.total_work_minutes AS recorded_work_minutes,
             a.current_state AS recorded_current_state
      FROM requests r
      JOIN employees e ON e.id = r.employee_id
      LEFT JOIN attendances a ON a.employee_id = r.employee_id AND a.work_date = r.start_date
      WHERE 1=1
    `;
    const params = [];
    if (status && status !== 'ALL') {
      params.push(status);
      queryText += ` AND r.status = $${params.length}`;
    }
    if (type && type !== 'ALL') {
      params.push(type);
      queryText += ` AND r.request_type = $${params.length}`;
    }
    if (role && role !== 'ALL') {
      params.push(role);
      queryText += ` AND e.role = $${params.length}`;
    }
    if (search && search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      queryText += ` AND (LOWER(e.first_name || ' ' || e.last_name) LIKE $${params.length} OR LOWER(e.employee_id) LIKE $${params.length} OR LOWER(r.reason) LIKE $${params.length})`;
    }
    queryText += ` ORDER BY r.submission_date DESC, r.id DESC`;

    const rows = (await query(queryText, params)).rows;
    const holidays = (await query('SELECT holiday_date FROM holidays')).rows;
    const data = rows.map(row => {
      let reviewDays = null;
      try {
        reviewDays = calculateRequest({
          category: row.metadata?.category || 'OFFICIAL',
          start_date: dateKey(row.start_date),
          end_date: dateKey(row.end_date),
          half_day: row.metadata?.half_day === true
        }, holidays).days;
      } catch {
        /* Fallback for legacy requests */
      }
      return {
        ...row,
        review_days: reviewDays
      };
    });
    res.json({
      success: true,
      data
    });
  } catch (error) {
    errorResponse(res, error);
  }
}

/**
 * Super Admin write authority: Edit any employee attendance record
 * Can be called standalone or to resolve an attendance correction ticket.
 */
export async function editAttendance(req, res) {
  let client;
  try {
    if(req.body?.request_id!=null && req.body.request_id!=='')throw Object.assign(new Error('Review linked requests through Approve or Reject; direct editing cannot resolve a request.'),{status:409});
    const preliminary=planAttendanceEdit(req.body);
    client=await pool.connect();await client.query('BEGIN');
    const target=(await client.query('SELECT id,role,is_active,joining_date FROM employees WHERE id=$1 FOR UPDATE',[preliminary.employee_id])).rows[0];
    if(!target||!target.is_active)throw Object.assign(new Error('Employee not found.'),{status:404});
    if(target.role==='SUPER_ADMIN')throw Object.assign(new Error('Super Admin accounts do not record attendance.'),{status:400});
    if(target.joining_date&&preliminary.work_date<dateKey(target.joining_date))throw Object.assign(new Error('Attendance date is before the employee joining date.'),{status:400});
    const before=(await client.query('SELECT * FROM attendances WHERE employee_id=$1 AND work_date=$2 FOR UPDATE',[target.id,preliminary.work_date])).rows[0]||null;
    const breaks=before?(await client.query('SELECT * FROM attendance_breaks WHERE attendance_id=$1 ORDER BY id',[before.id])).rows:[];
    const entry=planAttendanceEdit(req.body,before,breaks);
    const updated=(await client.query(`INSERT INTO attendances (employee_id,work_date,check_in,check_out,current_state,status,total_work_minutes,total_break_minutes,notes,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(employee_id,work_date) DO UPDATE SET check_in=EXCLUDED.check_in,check_out=EXCLUDED.check_out,current_state=EXCLUDED.current_state,status=EXCLUDED.status,total_work_minutes=EXCLUDED.total_work_minutes,total_break_minutes=EXCLUDED.total_break_minutes,notes=EXCLUDED.notes,updated_at=EXCLUDED.updated_at RETURNING *`,[entry.employee_id,entry.work_date,entry.check_in,entry.check_out,entry.current_state,entry.status,entry.total_work_minutes,entry.total_break_minutes,entry.notes,entry.updated_at])).rows[0];
    await client.query("INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data) VALUES ($1,'EDIT_ATTENDANCE','attendance',$2,$3,$4)",[req.user.id,updated.id,JSON.stringify(before),JSON.stringify(updated)]);
    await client.query("INSERT INTO notifications(recipient_id,title,message,category) VALUES ($1,$2,$3,'ATTENDANCE')",[target.id,'Attendance updated for '+entry.work_date,'Your attendance was updated by Super Admin ('+entry.status+'). Notes: '+entry.notes]);
    await client.query('COMMIT');res.json({success:true,message:'Attendance updated and recorded in the audit log.',data:updated});
  }catch(error){if(client)await client.query('ROLLBACK');errorResponse(res,error);}finally{client?.release();}
}
export async function reviewRequest(req, res) {
  let client;
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('Invalid request ID.'), {
      status: 400
    });
    let reviewed;
    const now = new Date();
    client = await pool.connect();
    await client.query('BEGIN');
    const identity = (await client.query('SELECT employee_id FROM requests WHERE id = $1', [id])).rows[0];
    if (!identity) throw Object.assign(new Error('Request not found.'), {
      status: 404
    });
    // Same employee-first lock order as request submission and allowance checks.
    await client.query('SELECT id FROM employees WHERE id = $1 FOR UPDATE', [identity.employee_id]);
    const request = (await client.query('SELECT * FROM requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
    const requests = (await client.query('SELECT * FROM requests WHERE employee_id = $1', [identity.employee_id])).rows;
    const holidays = (await client.query('SELECT holiday_date FROM holidays')).rows;
    const attendance = (await client.query('SELECT * FROM attendances WHERE employee_id = $1 AND work_date = $2 FOR UPDATE', [identity.employee_id, dateKey(request.start_date)])).rows[0];
    const breaks = attendance ? (await client.query('SELECT * FROM attendance_breaks WHERE attendance_id = $1', [attendance.id])).rows : [];
    const plan = planDecision(request, req.body, {
      requests,
      holidays,
      attendance,
      breaks
    }, now);
    const hrTicket = request.metadata?.workflow === CORRECTION_WORKFLOW;
    let correctedAttendanceId = null;
    if (plan.attendance) {
      const a = plan.attendance;
      const corrected = await client.query(`INSERT INTO attendances (employee_id, work_date, check_in, check_out, current_state, status, total_work_minutes, total_break_minutes, notes, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (employee_id, work_date) DO UPDATE SET check_in=EXCLUDED.check_in, check_out=EXCLUDED.check_out, current_state=EXCLUDED.current_state, status=EXCLUDED.status, total_work_minutes=EXCLUDED.total_work_minutes, total_break_minutes=EXCLUDED.total_break_minutes, notes=EXCLUDED.notes, updated_at=EXCLUDED.updated_at WHERE (attendances.current_state NOT IN ('CHECKED_IN','ON_BREAK') OR $11::boolean) RETURNING id`, [a.employee_id, a.work_date, a.check_in, a.check_out, a.current_state, a.status, a.total_work_minutes, a.total_break_minutes, a.notes, a.updated_at, (hrTicket && Boolean(request.metadata?.requested_status)) || (dateKey(request.start_date) < indiaDate(now) && (hrTicket || attendance?.current_state === 'CHECKED_IN'))]);
      correctedAttendanceId = corrected.rows[0]?.id;
      if (!corrected.rowCount) throw Object.assign(new Error('The employee has an active workday. Refresh before regularizing.'), {
        status: 409
      });
    }
    if (plan.attendanceDates?.length) {
      const plannedStatuses = new Map(plan.attendanceDates.map(entry => [entry.work_date, entry.status]));
      const { rows: existingAttendance } = await client.query(
        'SELECT work_date, current_state, check_in, check_out FROM attendances WHERE employee_id = $1 AND work_date = ANY($2::date[]) ORDER BY work_date FOR UPDATE',
        [identity.employee_id, [...plannedStatuses.keys()]]
      );
      const conflicts = existingAttendance.filter(row => blocksTimeOff(row, plannedStatuses.get(dateKey(row.work_date)) === 'HALF_DAY'));
      if (conflicts.length) {
        throw Object.assign(new Error('This request is still pending because it overlaps recorded attendance.'), {
          status: 409,
          attendanceConflicts: conflicts
        });
      }
      for (const entry of plan.attendanceDates) {
        await client.query(
          `INSERT INTO attendances (employee_id, work_date, current_state, status, total_work_minutes, total_break_minutes, notes, updated_at)
           VALUES ($1, $2, 'NOT_CHECKED_IN', $3, 0, 0, $4, $5)
           ON CONFLICT (employee_id, work_date)
           DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes, updated_at = EXCLUDED.updated_at`,
          [entry.employee_id, entry.work_date, entry.status, entry.notes, entry.updated_at]
        );
      }
    }
    reviewed = (await client.query('UPDATE requests SET status=$1, decision_by=$2, decision_date=$3, decision_remarks=$4, metadata=$5 WHERE id=$6 RETURNING *', [plan.status, req.user.id, now.toISOString(), plan.note, JSON.stringify(plan.metadata), id])).rows[0];
    await client.query('INSERT INTO application_audit_log (application_id, actor_id, action, old_status, new_status, remark) VALUES ($1,$2,$3,$4,$5,$6)', [id, req.user.id, plan.status === 'APPROVED' ? 'approve' : 'reject', 'PENDING', plan.status, JSON.stringify({
      note: plan.note,
      correction: plan.metadata.correction || null
    })]);
    if (hrTicket) {
      await client.query('INSERT INTO admin_audit_log (actor_id,action,entity_type,entity_id,before_data,after_data) VALUES ($1,$2,$3,$4,$5,$6)', [req.user.id, plan.status === 'APPROVED' ? 'APPROVE_ATTENDANCE_CORRECTION' : 'REJECT_ATTENDANCE_CORRECTION', 'attendance_ticket', id, JSON.stringify(request), JSON.stringify(reviewed)]);
      if (correctedAttendanceId) await client.query("INSERT INTO admin_audit_log (actor_id,action,entity_type,entity_id,before_data,after_data) VALUES ($1,'CORRECT_ATTENDANCE','attendance',$2,$3,$4)",[req.user.id,correctedAttendanceId,JSON.stringify(plan.metadata.correction.before),JSON.stringify(plan.metadata.correction.after)]);
      const hrId = Number(request.metadata.raised_by);
      if (Number.isSafeInteger(hrId) && hrId !== identity.employee_id) await client.query("INSERT INTO notifications (recipient_id,title,message,category,is_read,created_at) VALUES ($1,$2,$3,'CORRECTION',false,$4)",[hrId,`Attendance ticket #${id} ${plan.status.toLowerCase()}`,`Your correction ticket for ${dateKey(request.start_date)} was ${plan.status.toLowerCase()}. Response: ${plan.note}`,now.toISOString()]);
    }
    // The response and its private notification commit together, exactly once per decision.
    const title = `Request #${id} ${plan.status.toLowerCase()}`;
    const message = `Your ${request.request_type.replaceAll('_', ' ').toLowerCase()} request for ${dateKey(request.start_date)} to ${dateKey(request.end_date)} was ${plan.status.toLowerCase()}.${plan.note ? ' Response: ' + plan.note : ''}`;
    await client.query("INSERT INTO notifications (recipient_id, title, message, category, is_read, created_at) VALUES ($1,$2,$3,$4,false,$5)", [identity.employee_id, title, message, hrTicket ? 'CORRECTION' : 'REQUEST', now.toISOString()]);
    await client.query('COMMIT');
    res.json({
      success: true,
      data: reviewed,
      message: `Request ${reviewed.status.toLowerCase()}.`
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    errorResponse(res, error);
  } finally {
    client?.release();
  }
}
async function loadReport(req) {
  const period = reportPeriod(req.query);
  const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
  if (req.query.employee_id && (!Number.isSafeInteger(employeeId) || employeeId <= 0)) throw Object.assign(new Error('Choose a valid employee.'), {
    status: 400
  });
  let data;
  const results = await Promise.all([query("SELECT id, employee_id, first_name, last_name, department_name, joining_date, role, is_active FROM employees WHERE is_active = true AND role <> 'SUPER_ADMIN' ORDER BY first_name, id"), query('SELECT * FROM attendances WHERE work_date >= $1 AND work_date <= $2', [period.first, period.last]), query('SELECT b.* FROM attendance_breaks b JOIN attendances a ON a.id=b.attendance_id WHERE a.work_date >= $1 AND a.work_date <= $2', [period.first, period.last]), query('SELECT * FROM holidays WHERE holiday_date >= $1 AND holiday_date <= $2', [period.first, period.last]), query("SELECT * FROM requests WHERE status = 'APPROVED' AND request_type IN ('LEAVE','WFH','OTHER','HOLIDAY') AND start_date <= $2 AND end_date >= $1", [period.first, period.last])]);
  data = {
    employees: results[0].rows,
    attendances: results[1].rows,
    breaks: results[2].rows,
    holidays: results[3].rows,
    requests: results[4].rows
  };
  return buildMonthlyReport(data, period, employeeId);
}
export async function monthlyAttendance(req, res) {
  try {
    res.json({
      success: true,
      data: await loadReport(req)
    });
  } catch (error) {
    errorResponse(res, error);
  }
}
export async function exportMonthlyAttendance(req, res) {
  try {
    if (!['csv', 'xlsx'].includes(req.query.format)) throw Object.assign(new Error('Choose CSV or XLSX.'), {
      status: 400
    });
    const report = await loadReport(req);
    const clock = value => value ? new Date(value).toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit'
    }) : '';
    const text = status => status === 'FUTURE' ? '' : status.replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
    const matrix = [['Date', 'Employee', 'Employee code', 'Department', 'Status', 'In (IST)', 'Out (IST)', 'Work (minutes)', 'Break (minutes)', 'Mode', 'Notes'], ...report.rows.map(r => [r.work_date, r.employee_name, r.employee_code, r.department, text(r.status), clock(r.check_in), clock(r.check_out), r.total_work_minutes, r.total_break_minutes, r.mode, r.notes])];
    const format = req.query.format;
    res.set('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="attendance-${report.year}-${String(report.month).padStart(2, '0')}.${format}"`);
    res.send(format === 'csv' ? csvExport(matrix) : xlsxExport(matrix));
  } catch (error) {
    errorResponse(res, error);
  }
}
