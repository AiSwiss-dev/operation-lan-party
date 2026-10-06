// Prüft die Fehlerseiten bei fehlender/falscher Konfiguration
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
let mode = 'missing';
const jwt = (role) => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.c2ln';
const configs = {
  placeholder: fs.readFileSync(ROOT + '/config.example.js', 'utf8'),
  secret: `export const CONFIG = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "${jwt('service_role')}" };`,
  sbsecret: `export const CONFIG = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "sb_secret_123" };`,
  badurl: `export const CONFIG = { SUPABASE_URL: "ftp://x", SUPABASE_ANON_KEY: "sb_publishable_1" };`,
  nodb: `export const CONFIG = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "sb_publishable_1" };`,
};
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/olp\//, '')) || 'index.html';
  if (rel === 'js/config.js') {
    if (!configs[mode]) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(configs[mode]);
  }
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(f)] });
  fs.createReadStream(f).pipe(res);
}).listen(8766);
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
let fail = 0;
const expect = { missing: 'KONFIGURATION FEHLT', placeholder: 'KONFIGURATION UNVOLLSTÄNDIG', secret: 'SICHERHEITSALARM', sbsecret: 'SICHERHEITSALARM', badurl: 'SUPABASE-URL UNGÜLTIG' };
for (const m of Object.keys(expect)) {
  mode = m;
  for (const page of ['quiz.html', 'host.html', 'counter.html', 'bracket.html', 'login.html', 'commander.html']) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto('http://127.0.0.1:8766/olp/' + page);
    try {
      await p.waitForFunction((t) => document.querySelector('main h1')?.textContent.includes(t), expect[m], { timeout: 5000 });
      console.log('  ok  ', m, page || 'index', errors.length ? errors : '');
    } catch { fail++; console.log('  FAIL', m, page, await p.innerText('main')); }
    await ctx.close();
  }
}
// schema not installed: supabase answers PGRST202
mode = 'nodb';
const ctx = await browser.newContext();
await ctx.route('https://x.supabase.co/rest/v1/rpc/*', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.host_login(p_password) in the schema cache' }) }));
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:8766/olp/host.html');
await p.fill('#password', 'x');
await p.click('form button[type=submit]');
try { await p.waitForSelector('#login-error:text("HQ NICHT EINGERICHTET")', { timeout: 5000 }); console.log('  ok   schema missing -> HQ NICHT EINGERICHTET'); }
catch { fail++; console.log('  FAIL schema missing', await p.innerText('#login-error')); }
await browser.close(); server.close();
console.log(fail ? `CONFIG TESTS: ${fail} failed` : 'CONFIG TESTS: all passed');
process.exit(fail ? 1 : 0);
