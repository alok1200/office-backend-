import {query,transaction} from '../db/index.js';
import {companyDate} from '../services/companyAttendance.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const validId=id=>Number.isSafeInteger(Number(id))&&Number(id)>0;
function holidayData(body) {
  if(!body||typeof body!=='object'||Array.isArray(body))fail('Provide holiday details.');
  if(typeof body.holiday_date!=='string')fail('Holiday date is required.');
  const holiday_date=companyDate(body.holiday_date);
  if(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>150)fail('Provide a holiday name of 1–150 characters.');
  if(body.description!=null&&typeof body.description!=='string')fail('Description must be text.');
  if(body.holiday_type!=null&&(typeof body.holiday_type!=='string'||!body.holiday_type.trim()||body.holiday_type.length>50))fail('Provide a valid holiday type.');
  return {holiday_date,name:body.name.trim(),description:body.description?.trim()||'',holiday_type:body.holiday_type?.trim()||'OFFICIAL'};
}
const respondError=(res,error)=>res.status(error.code==='23505'?409:error.status||500).json({success:false,error:error.code==='23505'?'A holiday already exists on that date.':error.status?error.message:'Could not save the holiday change. Please retry.'});
export async function getHolidays(req,res) {
  try{res.json({success:true,data:(await query('SELECT * FROM holidays ORDER BY holiday_date ASC')).rows});}
  catch{res.status(500).json({success:false,error:'Could not load holidays. Please retry.'});}
}
async function mutate(req,res,action) {
  try{
    if(action!=='CREATE'&&!validId(req.params.id))fail('Invalid holiday ID.');
    const data=action==='DELETE'?null:holidayData(req.body);
    const saved=await transaction(async client=>{
      const before=action==='CREATE'?null:(await client.query('SELECT * FROM holidays WHERE id=$1 FOR UPDATE',[Number(req.params.id)])).rows[0];
      if(action!=='CREATE'&&!before)fail('Holiday not found.',404);
      const after=action==='CREATE'
        ? (await client.query('INSERT INTO holidays(holiday_date,name,description,holiday_type) VALUES($1,$2,$3,$4) RETURNING *',[data.holiday_date,data.name,data.description,data.holiday_type])).rows[0]
        : action==='UPDATE'
          ? (await client.query('UPDATE holidays SET holiday_date=$1,name=$2,description=$3,holiday_type=$4 WHERE id=$5 RETURNING *',[data.holiday_date,data.name,data.description,data.holiday_type,before.id])).rows[0]
          : (await client.query('DELETE FROM holidays WHERE id=$1 RETURNING *',[before.id])).rows[0];
      await client.query('INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,\'holiday\',$3,$4,$5)',[req.user.id,action+'_HOLIDAY',after.id,JSON.stringify(before),JSON.stringify(action==='DELETE'?null:after)]);
      const message=action==='DELETE'?`Company holiday removed: ${before.name} (${before.holiday_date}).`:action==='UPDATE'?`Company holiday updated: ${after.name} (${after.holiday_date}). Previously ${before.name} (${before.holiday_date}).`:`Company holiday added: ${after.name} (${after.holiday_date}).`;
      await client.query("INSERT INTO notifications(recipient_id,title,message,category) VALUES(NULL,$1,$2,'HOLIDAY')",['Company holiday '+({CREATE:'added',UPDATE:'updated',DELETE:'removed'}[action]),message]);
      return after;
    });
    res.status(action==='CREATE'?201:200).json({success:true,data:saved,message:'Holiday '+({CREATE:'added',UPDATE:'updated',DELETE:'removed'}[action])+'.'});
  }catch(error){respondError(res,error);}
}
export const createHoliday=(req,res)=>mutate(req,res,'CREATE');
export const updateHoliday=(req,res)=>mutate(req,res,'UPDATE');
export const deleteHoliday=(req,res)=>mutate(req,res,'DELETE');
