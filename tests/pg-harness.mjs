// Shared PGlite harness emulating the relevant Supabase setup.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';

export const SCHEMA = new URL('../supabase/schema.sql', import.meta.url);

export async function createDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create publication supabase_realtime;
  `);
  const sql = fs.readFileSync(SCHEMA, 'utf8');
  await db.exec(sql);
  await db.exec(sql); // idempotency: run twice
  return db;
}

// Call a function as the anon role, like PostgREST would.
export async function rpcAs(db, role, fn, args = {}) {
  const names = Object.keys(args);
  const params = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
  await db.exec(`set role ${role}`);
  try {
    const res = await db.query(`select to_jsonb(public.${fn}(${params})) as r`, names.map((n) => args[n]));
    return { data: res.rows[0].r, error: null };
  } catch (e) {
    return { data: null, error: { message: e.message, code: e.code } };
  } finally {
    await db.exec('reset role');
  }
}

export const anon = (db, fn, args) => rpcAs(db, 'anon', fn, args);
