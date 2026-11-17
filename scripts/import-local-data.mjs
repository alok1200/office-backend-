import { readFile } from 'node:fs/promises';
import { pool, transaction } from '../src/db/index.js';
import { migrateSchema } from '../src/db/seed.js';
import { importRecords, tables } from '../src/db/importRecords.js';
try {
  const source=process.argv[2] || new URL('../src/db/local_store.json',import.meta.url);
  const data=JSON.parse(await readFile(source,'utf8'));
  if (!Array.isArray(data.employees) || !data.employees.length) throw new Error('Import source has no employees.');
  await migrateSchema();
  const counts=await transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(784290)');
    for (const table of tables) {
      const result=await client.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
      if (result.rows[0].count) throw new Error(`Destination ${table} already contains records; refusing to overwrite data.`);
    }
    const counts=await importRecords(client,data);
    for(const [table,count]of Object.entries(counts)) {
      const actual=await client.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
      if(actual.rows[0].count!==count)throw new Error(`Import count mismatch for ${table}.`);
    }
    return counts;
  });
  console.log('PostgreSQL import committed; source retained unchanged. Counts:',JSON.stringify(counts));
} catch(error) { console.error('Import failed:',error.message); process.exitCode=1; }
finally { await pool.end(); }
