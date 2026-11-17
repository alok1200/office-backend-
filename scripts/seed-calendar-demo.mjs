import { pool, transaction } from '../src/db/index.js';
if(process.env.NODE_ENV==='production')throw new Error('Calendar samples are development-only.');
const today=new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'Asia/Kolkata'}).format(new Date());
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:Number(process.argv[i+1]);};
const year=option('--year',Number(today.slice(0,4))),month=option('--month',Number(today.slice(5,7)));
try {
  if(!Number.isInteger(year)||year<2000||year>2100||!Number.isInteger(month)||month<1||month>12)throw new Error('Choose a valid year and month.');
  const result=await transaction(async client=>{
    const holidays=new Set((await client.query('SELECT holiday_date FROM holidays')).rows.map(h=>h.holiday_date));
    const dates=[];
    for(let day=1;day<=new Date(Date.UTC(year,month,0)).getUTCDate()&&dates.length<3;day++){
      const date=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,weekday=new Date(`${date}T12:00:00Z`).getUTCDay();
      if(date<today&&weekday>0&&weekday<6&&!holidays.has(date))dates.push(date);
    }
    const codes=['KNV-1001','KNV-1002','KNV-1003','KNV-1004','KNV-1005','KNV-9001'];
    const employees=(await client.query('SELECT id FROM employees WHERE is_active=true AND employee_id=ANY($1::text[]) ORDER BY id FOR UPDATE',[codes])).rows;
    let count=0;
    for(const employee of employees)for(const date of dates){
      const overlap=await client.query("SELECT id FROM requests WHERE employee_id=$1 AND status IN ('PENDING','APPROVED') AND start_date<=$2 AND end_date>=$2",[employee.id,date]);
      if(overlap.rows.length)continue;
      const inserted=await client.query("INSERT INTO attendances (employee_id,work_date,current_state,check_in,check_out,total_work_minutes,total_break_minutes,status,mode,notes) VALUES ($1,$2,'CHECKED_OUT',$3,$4,480,60,'PRESENT','Demo','Demo sample — Present day for calendar preview') ON CONFLICT (employee_id,work_date) DO NOTHING RETURNING id",[employee.id,date,`${date}T03:30:00Z`,`${date}T12:30:00Z`]);
      if(!inserted.rows.length)continue;
      await client.query('INSERT INTO attendance_breaks (attendance_id,break_start,break_end,duration_minutes) VALUES ($1,$2,$3,60)',[inserted.rows[0].id,`${date}T07:30:00Z`,`${date}T08:30:00Z`]);count++;
    }
    return {count,dates};
  });
  console.log(`Added ${result.count} labelled PostgreSQL calendar samples on ${result.dates.join(', ')}; existing records preserved.`);
}catch(error){console.error(error.message);process.exitCode=1;}
finally{await pool.end();}
