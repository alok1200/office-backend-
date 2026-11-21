import {importRecords,tables} from './importRecords.js';
// The caller owns the transaction. Never overwrite application data.
export async function importEmptyDatabase(client,data) {
  if(!Array.isArray(data.employees)||!data.employees.length)throw new Error('Import source has no employees.');
  let bootstrap=[];
  let bootstrapProviders=[];
  for(const table of tables){
    if(table==='admin_audit_log'){
      bootstrap=(await client.query('SELECT * FROM admin_audit_log')).rows;
      if(bootstrap.some(row=>row.actor_id!==null||row.action!=='MIGRATE_ACCURACY_75'||row.entity_type!=='office_location'||row.entity_id!==0))throw new Error('Destination admin_audit_log already contains records; refusing to overwrite data.');
    }else if(table==='payment_provider_settings'){
      bootstrapProviders=(await client.query('SELECT * FROM payment_provider_settings')).rows;
      if(bootstrapProviders.some(row=>row.updated_by!==null||row.account_identifier!==null||row.webhook_url!==null))throw new Error('Destination payment_provider_settings already contains records; refusing to overwrite data.');
    }else if((await client.query(`SELECT COUNT(*)::int AS count FROM "${table}"`)).rows[0].count)throw new Error(`Destination ${table} already contains records; refusing to overwrite data.`);
  }
  // Fresh schema creation records a migration event and default payment provider rows even before accounts exist.
  await client.query('DELETE FROM admin_audit_log');
  await client.query('DELETE FROM payment_provider_settings');
  const counts=await importRecords(client,data);
  for(const row of bootstrap){
    if((data.admin_audit_log||[]).some(source=>source.action===row.action))continue;
    await client.query('INSERT INTO admin_audit_log(actor_id,action,entity_type,entity_id,before_data,after_data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.actor_id,row.action,row.entity_type,row.entity_id,JSON.stringify(row.before_data),JSON.stringify(row.after_data),row.created_at]);
    counts.admin_audit_log++;
  }
  for(const row of bootstrapProviders){
    if((data.payment_provider_settings||[]).some(source=>source.provider===row.provider))continue;
    await client.query('INSERT INTO payment_provider_settings(provider,is_active,mode,account_identifier,webhook_url,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (provider) DO NOTHING',[row.provider,row.is_active,row.mode,row.account_identifier,row.webhook_url,row.updated_by,row.updated_at]);
    counts.payment_provider_settings++;
  }
  return counts;
}
