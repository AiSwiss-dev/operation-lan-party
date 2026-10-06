// Gemeinsames Test-Backend: echtes schema.sql in PGlite hinter nachgebildetem
// PostgREST (RPC) + Supabase-Realtime, App unter /operation-lan-party/ wie bei GitHub Pages.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createDb, rpcAs } from './pg-harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const BASE_PATH = '/operation-lan-party/';
export const SUPA = 'https://olp-test.supabase.co';
export const PASSWORD = 'Commander-Test-2026';
export const OUT = fileURLToPath(new URL('./screenshots', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });
const FAKE_ANON = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'anon', iss: 'test' })).toString('base64url') + '.c2ln';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webm': 'audio/webm', '.m4a': 'audio/mp4' };
const RT_TABLES = ['games', 'players', 'counter_team', 'counter_matches', 'tournament'];

export async function startBackend({ port = 8770, realtime = true } = {}) {
  const db = await createDb();
  await db.query('select public.set_commander_password($1)', [PASSWORD]);
  await db.exec(`
    create table public.rt_events (id bigserial primary key, tbl text, type text, rec jsonb, old jsonb);
    create or replace function public.rt_log() returns trigger language plpgsql security definer set search_path = public as $$
    begin
      insert into public.rt_events (tbl, type, rec, old) values (TG_TABLE_NAME, TG_OP,
        case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end,
        case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end);
      return null;
    end $$;
    ${RT_TABLES.map((t) => `create trigger rt_${t} after insert or update or delete on public.${t} for each row execute function public.rt_log();`).join('\n')}
  `);

  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));
  const stats = { rpc: {}, unexpectedErrors: [], rtSent: 0 };
  const subs = [];
  let rtCursor = 0;
  let bindingId = 1000;

  async function flushRealtime() {
    const rows = (await db.query('select * from public.rt_events where id > $1 order by id', [rtCursor])).rows;
    if (!rows.length) return;
    rtCursor = rows[rows.length - 1].id;
    for (const ev of rows) {
      const rec = ev.rec || ev.old || {};
      for (const sub of subs) {
        const ids = sub.bindings.filter((b) => {
          if (b.table !== ev.tbl) return false;
          if (b.event !== '*' && b.event !== ev.type) return false;
          if (!b.filter) return true;
          if (ev.type === 'DELETE') return false;
          const [col, val] = b.filter.split('=eq.');
          return String(rec[col]) === val;
        }).map((b) => b.id);
        if (!ids.length) continue;
        try {
          sub.ws.send(JSON.stringify([null, null, sub.topic, 'postgres_changes', {
            ids, data: { schema: 'public', table: ev.tbl, commit_timestamp: new Date().toISOString(), type: ev.type, columns: [], record: ev.rec || {}, old_record: ev.old || {}, errors: null } }]));
          stats.rtSent++;
        } catch { /* geschlossen */ }
      }
    }
  }

  function handleWs(ws) {
    ws.onMessage((raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw));
      const reply = (response = {}) => ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response }]));
      if (event === 'phx_join') {
        const bindings = ((payload.config && payload.config.postgres_changes) || []).map((f) => ({ ...f, id: bindingId++ }));
        subs.push({ ws, topic, bindings });
        reply({ postgres_changes: bindings });
      } else if (event === 'phx_leave') {
        for (let i = subs.length - 1; i >= 0; i--) if (subs[i].ws === ws && subs[i].topic === topic) subs.splice(i, 1);
        reply();
      } else if (event === 'heartbeat' || event === 'access_token') reply();
    });
    ws.onClose(() => { for (let i = subs.length - 1; i >= 0; i--) if (subs[i].ws === ws) subs.splice(i, 1); });
  }

  async function handleRpc(route) {
    const req = route.request();
    const fn = new URL(req.url()).pathname.split('/').pop();
    stats.rpc[fn] = (stats.rpc[fn] || 0) + 1;
    let args = {};
    try { args = JSON.parse(req.postData() || '{}'); } catch { /* */ }
    const res = await serial(async () => {
      const r = await rpcAs(db, 'anon', fn, args);
      if (realtime) await flushRealtime();
      return r;
    });
    const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
    if (res.error) {
      if (!/^[A-Z][A-Z_]+$/.test(res.error.message)) stats.unexpectedErrors.push(`${fn}: ${res.error.message}`);
      const status = /permission denied/.test(res.error.message) ? 401 : 400;
      return route.fulfill({ status, headers, body: JSON.stringify({ code: res.error.code || 'P0001', message: res.error.message, details: null, hint: null }) });
    }
    return route.fulfill({ status: 200, headers, body: JSON.stringify(res.data) });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith(BASE_PATH)) { res.writeHead(404); return res.end('not found'); }
    const rel = decodeURIComponent(url.pathname.slice(BASE_PATH.length)) || 'index.html';
    if (rel === 'js/config.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      return res.end(`export const CONFIG = { SUPABASE_URL: "${SUPA}", SUPABASE_ANON_KEY: "${FAKE_ANON}" };`);
    }
    const file = path.join(ROOT, rel);
    if (!file.startsWith(path.normalize(ROOT)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const SITE = `http://127.0.0.1:${port}${BASE_PATH}`;

  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), args: ['--autoplay-policy=no-user-gesture-required'] });
  const consoleErrors = [];
  async function newPage(name, viewport = { width: 390, height: 844 }) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 800, hasTouch: viewport.width < 800 });
    await ctx.route(`${SUPA}/rest/v1/rpc/*`, handleRpc);
    if (realtime) await ctx.routeWebSocket(/realtime\/v1\/websocket/, handleWs);
    else await ctx.routeWebSocket(/realtime\/v1\/websocket/, (ws) => ws.close());
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' && !/WebSocket|olp-test\.supabase\.co\/realtime|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(m.text())) consoleErrors.push(`${name}: ${m.text()}`);
    });
    page.on('pageerror', (e) => consoleErrors.push(`${name} pageerror: ${e.message}`));
    return page;
  }
  const sqlRows = async (q, p) => (await serial(() => db.query(q, p))).rows;
  const close = async () => { await browser.close(); server.close(); };
  return { db, SITE, newPage, sqlRows, stats, consoleErrors, close };
}

export function reporter() {
  const r = { pass: 0, fail: 0 };
  r.ok = (cond, label, extra) => {
    if (cond) { r.pass++; console.log('  ok  ', label); } else { r.fail++; console.log('  FAIL', label, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
  };
  return r;
}

export const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
