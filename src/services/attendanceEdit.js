import {indiaDate} from './superAdminAttendanceReport.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function planAttendanceEdit(body, existing=null, breaks=[], now=new Date()) {
  if(!body || typeof body!=='object' || Array.isArray(body))fail('Provide attendance details.');
  const employee_id=Number(body.employee_id), day=body.work_date;
  if(!Number.isSafeInteger(employee_id)||employee_id<=0)fail('Valid employee ID is required.');
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00Z'))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day||day<'2000-01-01'||day>'2100-12-31')fail('Choose a valid attendance date.');
  if(day>indiaDate(now))fail('Future attendance cannot be recorded. Use leave, WFH or holiday requests for planned dates.');
  const parse=value=>{
    if(value==null||value==='')return null;
    if(typeof value!=='string')fail('Punch times must be valid times or timezone-qualified timestamps.');
    const clock=/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
    if(!clock&&!/(?:Z|[+-]\d{2}:\d{2})$/.test(value))fail('Punch timestamps must include a timezone.');
    const time=new Date(clock?`${day}T${value.length===5?value+':00':value}+05:30`:value);
    if(!Number.isFinite(time.getTime())||indiaDate(time)!==day||time>now)fail('Punch times must be valid, on the selected date in IST, and not in the future.');
    return time;
  };
  const start=parse(body.check_in),end=parse(body.check_out);
  if(Boolean(start)!==Boolean(end))fail('Provide both check-in and check-out, or leave both empty for a status-only update.');
  if(start&&end<=start)fail('Check-out must be later than check-in.');
  if(existing&&['CHECKED_IN','ON_BREAK'].includes(existing.current_state)&&day===indiaDate(now))fail('The employee has an active workday. Complete it before editing attendance.',409);
  if(breaks.some(b=>!start||!b.break_end||new Date(b.break_start)<start||new Date(b.break_end)>end||new Date(b.break_end)<new Date(b.break_start)))fail('Existing breaks must be closed and fit within the reviewed punch times.',409);
  const sorted=[...breaks].sort((a,b)=>new Date(a.break_start)-new Date(b.break_start));
  if(sorted.some((b,i)=>i>0&&new Date(b.break_start)<new Date(sorted[i-1].break_end)))fail('Existing breaks overlap. Review the break history before editing.',409);
  const rest=breaks.reduce((sum,b)=>sum+Math.floor((new Date(b.break_end)-new Date(b.break_start))/60000),0);
  const work=start?Math.max(0,Math.floor((end-start)/60000)-rest):0;
  const status=body.status||'AUTO';
  if(!['AUTO','PRESENT','HALF_DAY','ABSENT','LEAVE','HOLIDAY','WEEKLY_OFF','WFH','OFFICIAL_WORK_OUTSIDE'].includes(status))fail('Choose a valid attendance status.');
  if(body.notes!=null&&typeof body.notes!=='string')fail('Notes must be text.');
  const notes=body.notes?.trim()||'Attendance edited by Super Admin';
  if(notes.length>2000)fail('Notes must be at most 2000 characters.');
  return {employee_id,work_date:day,check_in:start?.toISOString()||null,check_out:end?.toISOString()||null,current_state:start?'CHECKED_OUT':'NOT_CHECKED_IN',status:status==='AUTO'?(start?(work<300?'HALF_DAY':'PRESENT'):'ABSENT'):status,total_work_minutes:work,total_break_minutes:rest,notes,updated_at:now.toISOString()};
}
