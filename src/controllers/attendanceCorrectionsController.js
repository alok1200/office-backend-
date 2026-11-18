import { pool, query } from '../db/index.js';
import { CORRECTION_WORKFLOW, validateCorrectionTicket, attendanceFingerprint } from '../services/attendanceCorrections.js';
const respondError = (res,error) => res.status(error.status || 500).json({ success:false,error:error.status ? error.message : 'Could not complete the attendance ticket operation. Please retry.' });
const fail = (message,status=409) => {throw Object.assign(new Error(message),{status});};
export async function listAttendanceCorrections(req,res) {
  try {
    const params=[CORRECTION_WORKFLOW];
    let scope="r.metadata->>'workflow'=$1";
    if(req.user.role==='EMPLOYEE'){params.push(req.user.id);scope+=' AND r.employee_id=$2';}
    if(req.query.status && req.query.status!=='ALL'){
      if(!['PENDING','APPROVED','REJECTED'].includes(req.query.status))fail('Invalid ticket status.',400);
      params.push(req.query.status);scope+=` AND r.status=$${params.length}`;
    }
    const rows=(await query(`SELECT r.*, e.first_name, e.last_name, e.employee_id AS emp_code, e.department_name,
      hr.first_name AS raised_by_first_name, hr.last_name AS raised_by_last_name,
      reviewer.first_name AS reviewer_first_name, reviewer.last_name AS reviewer_last_name
      FROM requests r JOIN employees e ON e.id=r.employee_id
      LEFT JOIN employees hr ON hr.id=(r.metadata->>'raised_by')::int
      LEFT JOIN employees reviewer ON reviewer.id=r.decision_by
      WHERE ${scope} ORDER BY r.submission_date DESC,r.id DESC`,params)).rows;
    res.json({success:true,data:rows});
  }catch(error){respondError(res,error);}
}
export async function createAttendanceCorrection(req,res) {
  let client;
  try {
    const data=validateCorrectionTicket(req.body);
    client=await pool.connect();await client.query('BEGIN');
    const target=(await client.query('SELECT id,role,is_active,joining_date FROM employees WHERE id=$1 FOR UPDATE',[data.employee_id])).rows[0];
    if(!target || !target.is_active || !['EMPLOYEE','HR_ADMIN'].includes(target.role))fail('Choose an active employee or HR account.',400);
    if(target.joining_date && data.work_date<String(target.joining_date).slice(0,10))fail('Attendance date is before the employee joining date.',400);
    const duplicate=(await client.query("SELECT id FROM requests WHERE employee_id=$1 AND request_type='REGULARIZATION' AND status='PENDING' AND start_date <= $2 AND end_date >= $2",[data.employee_id,data.work_date])).rows[0];
    if(duplicate)fail('A correction for this employee and date is already awaiting review.');
    const attendance=(await client.query('SELECT * FROM attendances WHERE employee_id=$1 AND work_date=$2 FOR UPDATE',[data.employee_id,data.work_date])).rows[0] || null;
    const breaks=attendance ? (await client.query('SELECT * FROM attendance_breaks WHERE attendance_id=$1 ORDER BY id',[attendance.id])).rows : [];
    const metadata={workflow:CORRECTION_WORKFLOW,category:'REGULARIZATION',label:'HR attendance correction',raised_by:req.user.id,correction_type:data.correction_type,proposed_correction:data.proposed_correction,attendance_snapshot:attendance,breaks_snapshot:breaks,baseline:attendanceFingerprint(attendance,breaks)};
    const ticket=(await client.query("INSERT INTO requests (employee_id,request_type,start_date,end_date,reason,status,metadata) VALUES ($1,'REGULARIZATION',$2,$2,$3,'PENDING',$4) RETURNING *",[data.employee_id,data.work_date,data.reason,JSON.stringify(metadata)])).rows[0];
    await client.query("INSERT INTO application_audit_log (application_id,actor_id,action,old_status,new_status,remark) VALUES ($1,$2,'raise_correction',NULL,'PENDING',$3)",[ticket.id,req.user.id,JSON.stringify({note:data.reason,proposed_correction:data.proposed_correction})]);
    await client.query("INSERT INTO admin_audit_log (actor_id,action,entity_type,entity_id,before_data,after_data) VALUES ($1,'RAISE_ATTENDANCE_CORRECTION','attendance_ticket',$2,NULL,$3)",[req.user.id,ticket.id,JSON.stringify(ticket)]);
    const admins=(await client.query("SELECT id FROM employees WHERE role='SUPER_ADMIN' AND is_active=true")).rows;
    for(const admin of admins)await client.query("INSERT INTO notifications (recipient_id,title,message,category) VALUES ($1,$2,$3,'CORRECTION')",[admin.id,`HR attendance ticket #${ticket.id}`,`HR raised an attendance correction for ${data.work_date}. Review it in HR-Requests.`]);
    if(data.employee_id!==req.user.id)await client.query("INSERT INTO notifications (recipient_id,title,message,category) VALUES ($1,$2,$3,'CORRECTION')",[data.employee_id,`Attendance ticket #${ticket.id} raised`,`HR submitted a correction for your attendance on ${data.work_date}. Status: pending Super Admin review.`]);
    await client.query('COMMIT');res.status(201).json({success:true,data:ticket,message:'Correction ticket sent to Super Admin.'});
  }catch(error){if(client)await client.query('ROLLBACK');respondError(res,error);}finally{client?.release();}
}
export async function correctionAudit(req,res) {
  try{
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id) || id<=0)fail('Invalid ticket ID.',400);
    const ticket=(await query("SELECT employee_id FROM requests WHERE id=$1 AND metadata->>'workflow'=$2",[id,CORRECTION_WORKFLOW])).rows[0];
    if(!ticket || req.user.role==='EMPLOYEE' && ticket.employee_id!==req.user.id)fail('Ticket not found.',404);
    const events=(await query("SELECT a.id,a.action,a.old_status,a.new_status,a.remark,a.created_at,e.first_name,e.last_name FROM application_audit_log a LEFT JOIN employees e ON e.id=a.actor_id WHERE a.application_id=$1 ORDER BY a.created_at,a.id",[id])).rows;
    res.json({success:true,data:events});
  }catch(error){respondError(res,error);}
}
