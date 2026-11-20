import {importRecords,tables} from './importRecords.js';
// The caller owns the transaction. Never overwrite application data.
export async function importEmptyDatabase(client,data) {
  if(!Array.isArray(data.employees)||!data.employees.length)throw new Error('Import source has no employees.');
  let bootstrap=[];
  for(const table of tables){
    if(table==='admin_audit_log'){
      bootstrap=(await client.query('SELECT * FROM admin_audit_log')).rows;
      if(bootstrap.some(row=>row.actor_id!==null||row.action!=='MIGRATE_ACCURACY_75'||row.entity_type!=='office_location'||row.entity_id!==0))throw new Error('Destination admin_audit_log already contains records; refusing to overwrite data.');
    }else if((await client.query(`SELECT COUNT(*)::int AS count FROM "${table}"`)).rows[0].count)throw new Error(`Destination ${table} already contains records; refusing to overwrite data.`);
  }
  // Fresh schema creation records a migration event even before offices/accounts exist.
  await client.query('DELETE FROM admin_audit_log');
  const counts=await importRecords(client,data);
  for(const row of bootstrap){
    if((data.admin_audit_log||[]).some(source=>source.action===row.action))continue;
    await client.query('INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.actor_id,row.action,row.entity_type,row.entity_id,JSON.stringify(row.before_data),JSON.stringify(row.after_data),row.created_at]);
    counts.admin_audit_log++;
  }
  return counts;
}
