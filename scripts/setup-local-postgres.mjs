import pg from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
const database='knooviq_attendance';
const user=process.env.USER;
const client=new pg.Client({host:'127.0.0.1',port:5432,database:'postgres',user,connectionTimeoutMillis:5000});
try {
  await client.connect();
  const exists=await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[database]);
  if(!exists.rows.length)await client.query(`CREATE DATABASE "${database}"`);
  const path=new URL('../.env',import.meta.url);
  let config=''; try { config=await readFile(path,'utf8'); } catch(error) {if(error.code!=='ENOENT')throw error;}
  const url=`postgresql://${encodeURIComponent(user)}@127.0.0.1:5432/${database}`;
  const settings={DATABASE_URL:url,PORT:'8086',SEED_DEMO_DATA:'false'};
  for(const [key,value]of Object.entries(settings))config=new RegExp(`^${key}=.*$`,'m').test(config)?config.replace(new RegExp(`^${key}=.*$`,'m'),`${key}=${value}`):config+`\n${key}=${value}`;
  await writeFile(path,config.trim()+'\n',{mode:0o600});
  console.log('Local PostgreSQL database ready; backend/.env configured. Existing database contents were not changed.');
} catch(error) {console.error('PostgreSQL setup failed:',error.code||error.message);process.exitCode=1;}
finally {await client.end();}
