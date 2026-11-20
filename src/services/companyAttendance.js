import {query} from '../db/index.js';
import {buildMonthlyReport, reportPeriod, indiaDate} from './superAdminAttendanceReport.js';

export function companyDate(value) {
  const day=value === undefined ? indiaDate() : value;
  if(typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day+'T00:00:00Z')) || new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day || Number(day.slice(0,4))<2000 || Number(day.slice(0,4))>2100) {
    throw Object.assign(new Error('Choose a valid attendance date between 2000 and 2100.'),{status:400});
  }
  return day;
}
export async function companyAttendance(day, filters={}) {
  const period=reportPeriod({year:day.slice(0,4),month:day.slice(5,7)});
  const [employees,attendances,breaks,holidays,requests]=await Promise.all([
    query("SELECT id,employee_id,first_name,last_name,department_name,designation,joining_date,role,is_active FROM employees WHERE is_active=true AND role<>'SUPER_ADMIN' ORDER BY id"),
    query('SELECT * FROM attendances WHERE work_date=$1',[day]),
    query('SELECT b.* FROM attendance_breaks b JOIN attendances a ON a.id=b.attendance_id WHERE a.work_date=$1 ORDER BY b.id',[day]),
    query('SELECT * FROM holidays WHERE holiday_date=$1',[day]),
    query("SELECT * FROM requests WHERE status='APPROVED' AND request_type IN ('LEAVE','HOLIDAY','WFH','OTHER') AND start_date<=$1 AND end_date>=$1",[day])
  ]);
  const report=buildMonthlyReport({employees:employees.rows,attendances:attendances.rows,breaks:breaks.rows,holidays:holidays.rows,requests:requests.rows},period,null);
  const records=new Map(attendances.rows.map(row=>[row.employee_id,row]));
  const directory=new Map(employees.rows.map(row=>[row.id,row]));
  const search=typeof filters.search==='string'?filters.search.trim().toLowerCase():'';
  return report.rows.filter(row=>row.work_date===day).map(row=>{
    const employee=directory.get(row.employee_id),record=records.get(row.employee_id);
    return {...record,id:record?.id??null,employee_id:employee.id,emp_code:employee.employee_id,first_name:employee.first_name,last_name:employee.last_name,department_name:employee.department_name,designation:employee.designation,work_date:day,status:row.status,check_in:row.check_in,check_out:row.check_out,current_state:record?.current_state||'NOT_CHECKED_IN',total_work_minutes:row.total_work_minutes,total_break_minutes:row.total_break_minutes,notes:row.notes,breaks:breaks.rows.filter(b=>b.attendance_id===record?.id)};
  }).filter(row=>(!filters.department || filters.department==='ALL' || row.department_name===filters.department) && (!filters.status || filters.status==='ALL' || row.status===filters.status || filters.status==='ABSENT' && row.status==='NOT_CHECKED_IN') && (!search || `${row.first_name} ${row.last_name} ${row.emp_code}`.toLowerCase().includes(search))).sort((a,b)=>a.employee_id-b.employee_id);
}
