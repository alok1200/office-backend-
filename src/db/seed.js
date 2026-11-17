import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { query, transaction, pool } from './index.js';
import { buildDemoData } from './demoData.js';
import { importRecords } from './importRecords.js';
export async function migrateSchema() {
  const sql=await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8');
  await query(sql);
}
export async function runMigrationsAndSeed() {
  await migrateSchema();
  if (process.env.SEED_DEMO_DATA !== 'true') return;
  await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(784290)');
    const existing=await client.query('SELECT COUNT(*)::int AS count FROM employees');
    if (existing.rows[0].count) return;
    await importRecords(client,buildDemoData());
    console.log('[PostgreSQL] Initial demo data created.');
  });
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  runMigrationsAndSeed().then(()=>console.log('PostgreSQL schema ready.')).catch(error=>{console.error('Database initialization failed:',error.message);process.exitCode=1;}).finally(()=>pool.end());
}
