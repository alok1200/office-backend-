export const tables = ['departments','employees','office_locations','holidays','attendances','attendance_breaks','requests','notifications','application_audit_log','admin_audit_log','notification_reads','company_assets'];
const identifier = value => `"${value.replaceAll('"','""')}"`;
export async function importRecords(client, data) {
  const columns = (await client.query('SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema()')).rows;
  const counts = {};
  for (const table of tables) {
    const definition = new Map(columns.filter(c => c.table_name === table).map(c => [c.column_name,c.data_type]));
    let count=0;
    for (const source of data[table] || []) {
      const row = { ...source };
      // Offices reference their updater; employee office assignments are restored second.
      if (table === 'employees') { delete row.office_id; delete row.created_by; }
      const keys = Object.keys(row).filter(key => definition.has(key) && row[key] !== undefined);
      if (!keys.length) continue;
      const values = keys.map(key => definition.get(key) === 'jsonb' && row[key] !== null ? JSON.stringify(row[key]) : row[key]);
      await client.query(`INSERT INTO ${identifier(table)} (${keys.map(identifier).join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,values);
      count++;
    }
    counts[table]=count;
  }
  // Creators may appear later in the source array, so restore self-references after all accounts exist.
  for (const user of data.employees || []) if (user.created_by != null) await client.query('UPDATE employees SET created_by=$1 WHERE id=$2',[user.created_by,user.id]);
  for (const user of data.employees || []) if (user.office_id && (data.office_locations || []).some(o=>o.id===user.office_id)) await client.query('UPDATE employees SET office_id=$1 WHERE id=$2',[user.office_id,user.id]);
  for (const table of tables) {
    if (!columns.some(c=>c.table_name===table && c.column_name==='id')) continue;
    await client.query(`SELECT setval(pg_get_serial_sequence($1,'id'),GREATEST(COALESCE(MAX(id),0)+1,1),false) FROM ${identifier(table)}`,[table]);
  }
  await client.query('UPDATE office_locations SET is_primary=true WHERE id=(SELECT id FROM office_locations WHERE is_active=true ORDER BY id DESC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM office_locations WHERE is_primary=true AND is_active=true)');
  return counts;
}
