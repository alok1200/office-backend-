import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required. Configure PostgreSQL in backend/.env; no file-storage fallback is used.');
const schema = process.env.DB_SCHEMA || 'public';
if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('DB_SCHEMA must be a valid lowercase SQL identifier.');
// PostgreSQL DATE columns represent calendar days, not local-midnight timestamps.
pg.types.setTypeParser(1082, value => value);
pg.types.setTypeParser(1700, value => Number(value));
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema},public`,
  connectionTimeoutMillis: 5000,
  max: 10,
  // pg respects sslmode in DATABASE_URL for remote PostgreSQL deployments.
});
pool.on('error', error => console.error('[PostgreSQL] Connection error:', error.code || 'UNKNOWN'));
export const query = (text, params = []) => pool.query(text, params);
export async function transaction(work) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
