// End-to-End-Test: echtes schema.sql (PGlite) hinter nachgebildetem PostgREST/Realtime,
// App unter einem Unterpfad wie bei GitHub Pages. Start: npm run e2e (bzw. RT=0 für reinen Fallback)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { createDb, rpcAs } from './pg-harness.mjs';

import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const BASE_PATH = '/operation-lan-party/';
const SUPA = 'https://olp-test.supabase.co';
const OUT = fileURLToPath(new URL('./screenshots', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });
const FAKE_ANON = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role: 'anon', iss: 'test' })).toString('base64url') + '.c2ln';
const PASSWORD = 'Commander-Test-2026';
const RT = process.env.RT !== '0';   // RT=0 -> Realtime blockiert (reiner Fallback)
console.log('MODE:', RT ? 'realtime emulated' : 'realtime blocked (fallback polling)');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ', label); } else { fail++; console.log('  FAIL', label, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
};

// ---------- DB + mock PostgREST ----------
const db = await createDb();
await db.query(`select public.set_commander_password($1)`, [PASSWORD]);
// Change-Log für die Realtime-Emulation (wie WAL → Supabase Realtime)
await db.exec(`
  create table rt_events (id bigserial primary key, tbl text, type text, rec jsonb, old jsonb);
  create or replace function rt_log() returns trigger language plpgsql security definer set search_path = public as $$
  begin
    insert into public.rt_events (tbl, type, rec, old) values (TG_TABLE_NAME, TG_OP,
      case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end,
      case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end);
    return null;
  end $$;
  create trigger rt_games after insert or update or delete on public.games for each row execute function rt_log();
  create trigger rt_players after insert or update or delete on public.players for each row execute function rt_log();
`);
let rtCursor = 0;
const subs = []; // { ws, topic, bindings: [{id, event, table, filter}] }
let rtSent = 0;
async function flushRealtime() {
  const rows = (await db.query('select * from rt_events where id > $1 order by id', [rtCursor])).rows;
  if (!rows.length) return;
  rtCursor = rows[rows.length - 1].id;
  for (const ev of rows) {
    const rec = ev.rec || ev.old || {};
    for (const sub of subs) {
      const ids = sub.bindings.filter((b) => {
        if (b.table !== ev.tbl) return false;
        if (b.event !== '*' && b.event !== ev.type) return false;
        if (!b.filter) return true;
        const [col, val] = b.filter.split('=eq.');
        if (ev.type === 'DELETE') return false; // wie Supabase: DELETE wird nicht gefiltert geliefert
        return String(rec[col]) === val;
      }).map((b) => b.id);
      if (!ids.length) continue;
      try {
        sub.ws.send(JSON.stringify([null, null, sub.topic, 'postgres_changes', {
          ids, data: { schema: 'public', table: ev.tbl, commit_timestamp: new Date().toISOString(), type: ev.type,
            columns: [], record: ev.rec || {}, old_record: ev.old || {}, errors: null } }]));
        rtSent++;
      } catch { /* geschlossen */ }
    }
  }
}
let bindingId = 1000;
function handleWs(ws) {
  ws.onMessage((raw) => {
    const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw));
    const reply = (response = {}) => ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response }]));
    if (event === 'phx_join') {
      const pc = (payload.config && payload.config.postgres_changes) || [];
      const bindings = pc.map((f) => ({ ...f, id: bindingId++ }));
      subs.push({ ws, topic, bindings });
      reply({ postgres_changes: bindings });
    } else if (event === 'phx_leave') {
      for (let i = subs.length - 1; i >= 0; i--) if (subs[i].ws === ws && subs[i].topic === topic) subs.splice(i, 1);
      reply();
    } else if (event === 'heartbeat' || event === 'access_token') {
      reply();
    }
  });
  ws.onClose(() => { for (let i = subs.length - 1; i >= 0; i--) if (subs[i].ws === ws) subs.splice(i, 1); });
}
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));
const rpcCount = {};
const unexpectedRpcErrors = [];

async function handleRpc(route) {
  const req = route.request();
  const fn = new URL(req.url()).pathname.split('/').pop();
  rpcCount[fn] = (rpcCount[fn] || 0) + 1;
  let args = {};
  try { args = JSON.parse(req.postData() || '{}'); } catch { /* */ }
  const res = await serial(async () => {
    const r = await rpcAs(db, 'anon', fn, args);
    if (RT) await flushRealtime();
    return r;
  });
  const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
  if (res.error) {
    if (!/^[A-Z][A-Z_]+$/.test(res.error.message)) unexpectedRpcErrors.push(`${fn}: ${res.error.message}`);
    const status = /permission denied/.test(res.error.message) ? 401 : 400;
    return route.fulfill({ status, headers, body: JSON.stringify({ code: res.error.code || 'P0001', message: res.error.message, details: null, hint: null }) });
  }
  return route.fulfill({ status: 200, headers, body: JSON.stringify(res.data) });
}

// ---------- static server (GitHub-Pages-like subpath) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webm': 'audio/webm', '.m4a': 'audio/mp4' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith(BASE_PATH)) { res.writeHead(404); return res.end('not found'); }
  let rel = decodeURIComponent(url.pathname.slice(BASE_PATH.length)) || 'index.html';
  if (rel === 'js/config.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'] });
    return res.end(`export const CONFIG = { SUPABASE_URL: "${SUPA}", SUPABASE_ANON_KEY: "${FAKE_ANON}" };`);
  }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(path.normalize(ROOT)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(8765, '127.0.0.1', r));
const SITE = `http://127.0.0.1:8765${BASE_PATH}`;

// ---------- browser ----------
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), args: ['--autoplay-policy=no-user-gesture-required'] });
const consoleErrors = [];
async function newPage(name, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 800, hasTouch: viewport.width < 800 });
  await ctx.route(`${SUPA}/rest/v1/rpc/*`, handleRpc);
  if (RT) await ctx.routeWebSocket(/realtime\/v1\/websocket/, handleWs);
  else await ctx.routeWebSocket(/realtime\/v1\/websocket/, (ws) => ws.close());
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|olp-test\.supabase\.co\/realtime|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(m.text())) consoleErrors.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${name} pageerror: ${e.message}`));
  page.name = name;
  return page;
}
const h1 = (page) => page.locator('main h1').first().innerText();
const waitH1 = (page, text, timeout = 15000) => page.waitForFunction((t) => {
  const el = document.querySelector('main h1'); return el && el.textContent.includes(t);
}, text, { timeout });
async function noHScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
const sqlRows = async (q, p) => (await serial(() => db.query(q, p))).rows;

try {
  // ===== Host login =====
  console.log('HOST');
  const host = await newPage('host', { width: 1600, height: 900 });
  await host.goto(SITE + 'host.html');
  await waitH1(host, 'MISSION CONTROL');
  await host.fill('#password', 'falsch');
  await host.click('form button[type=submit]');
  await host.waitForSelector('#login-error:text("ZUGANG VERWEIGERT")');
  ok(true, 'wrong password rejected');
  await host.fill('#password', PASSWORD);
  await host.click('form button[type=submit]');
  await host.waitForSelector('button:text("NEUE MISSION")');
  ok(true, 'login ok');
  await host.screenshot({ path: `${OUT}/host-menu.png` });
  await host.click('button:text("NEUE MISSION")');
  await host.waitForSelector('.mission-code');
  const CODE = (await host.innerText('.mission-code')).replace(/\s/g, '');
  ok(/^\d{6}$/.test(CODE), 'mission code shown ' + CODE);
  const joinText = await host.innerText('.join-url');
  ok(joinText.endsWith(`/operation-lan-party/quiz.html?game=${CODE}`), 'join url has subpath', joinText);

  // QR decode
  const qrPng = PNG.sync.read(await host.locator('.qr').screenshot());
  const decoded = jsQR(new Uint8ClampedArray(qrPng.data), qrPng.width, qrPng.height);
  const JOIN_URL = decoded && decoded.data;
  ok(JOIN_URL === `${SITE}quiz.html?game=${CODE}`, 'QR decodes to player url', JOIN_URL);
  await host.screenshot({ path: `${OUT}/host-lobby-empty.png` });

  // ===== Players join =====
  console.log('PLAYERS');
  const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett'];
  const players = [];
  for (const n of NAMES) {
    const p = await newPage(n);
    await p.goto(JOIN_URL);
    await p.waitForSelector('#callsign');
    if (n === 'Alpha') {
      ok((await p.inputValue('#mission-code')) === CODE, 'code prefilled from ?game=');
      ok(await noHScroll(p), 'join screen no horizontal scroll (390)');
      await p.screenshot({ path: `${OUT}/player-join-390.png`, fullPage: true });
    }
    await p.fill('#callsign', n);
    await p.click('form button[type=submit]');
    await waitH1(p, 'WAITING FOR COMMANDER');
    players.push(p);
  }
  ok(true, '10 players in lobby');

  // edge cases on an extra page
  const extra = await newPage('extra', { width: 320, height: 640 });
  await extra.goto(JOIN_URL);
  await extra.fill('#callsign', 'alpha');
  await extra.click('form button[type=submit]');
  await extra.waitForSelector('#join-error:text("CALLSIGN BEREITS VERGEBEN")');
  ok(true, 'duplicate callsign (case-insensitive) rejected');
  await extra.fill('#callsign', '<b>x</b>');
  await extra.click('form button[type=submit]');
  ok((await extra.innerText('#join-error')).includes('UNGÜLTIGE ZEICHEN'), 'html callsign rejected');
  await extra.fill('#callsign', 'x');
  await extra.click('form button[type=submit]');
  ok((await extra.innerText('#join-error')).includes('2–24'), 'short callsign rejected');
  await extra.fill('#mission-code', '000001');
  await extra.fill('#callsign', 'Ghost');
  await extra.click('form button[type=submit]');
  await extra.waitForSelector('#join-error:text("MISSION CODE UNGÜLTIG")');
  ok(true, 'unknown mission rejected');
  ok(await noHScroll(extra), 'join screen no horizontal scroll (320)');
  await extra.screenshot({ path: `${OUT}/player-join-320-error.png`, fullPage: true });
  await extra.fill('#mission-code', CODE);
  await extra.fill('#callsign', `O'Neil "&" Ä`);
  await extra.click('form button[type=submit]');
  await waitH1(extra, 'WAITING FOR COMMANDER');
  ok((await extra.innerText('.callsign')) === `O'Neil "&" Ä`, 'special chars rendered as text');

  // host sees all (polling fallback)
  await host.waitForFunction(() => document.querySelectorAll('.chips--lobby .chip').length === 11, null, { timeout: 15000 });
  ok(true, 'host sees 11 players live');
  // host kicks the extra player
  await host.click('.chip:has-text("O\'Neil") .chip__remove');
  await host.click('dialog .btn--danger');
  await host.waitForFunction(() => document.querySelectorAll('.chips--lobby .chip').length === 10, null, { timeout: 10000 });
  ok(true, 'host removed player');
  await extra.waitForSelector('#join-error:text("OPERATOR NICHT GEFUNDEN")', { timeout: 15000 });
  ok(true, 'kicked player back at join with message');
  await players[0].waitForFunction(() => document.querySelectorAll('.roster__item').length === 10, null, { timeout: 15000 });
  ok(true, 'player lobby list updates');
  if (RT) {
    await Promise.all([host, ...players].map((p) => p.waitForSelector('#link-led[data-state="live"]', { timeout: 10000 })));
    ok(true, 'realtime: all 11 devices show LIVE');
    // a join must reach the others via realtime (fallback poll would be 8 s in live mode)
    const probe = await newPage('probe');
    await probe.goto(JOIN_URL);
    await probe.fill('#callsign', 'RealtimeProbe');
    const t0 = Date.now();
    await probe.click('form button[type=submit]');
    await players[0].waitForFunction(() => document.querySelectorAll('.roster__item').length === 11, null, { timeout: 7000 });
    const dt = Date.now() - t0;
    ok(dt < 2000, `realtime: join visible on other phone after ${dt} ms`);
    await probe.click('button:text("MISSION VERLASSEN")');
    await probe.click('dialog .btn--danger');
    await probe.waitForSelector('#callsign');
    await players[0].waitForFunction(() => document.querySelectorAll('.roster__item').length === 10, null, { timeout: 7000 });
    ok(true, 'realtime: leaving lobby propagates (DELETE event)');
    await probe.context().close();
  } else {
    ok((await players[0].getAttribute('#link-led', 'data-state')) === 'fallback', 'fallback: LED shows SYNC');
  }
  await players[0].screenshot({ path: `${OUT}/player-lobby-390.png`, fullPage: true });
  ok(await noHScroll(players[0]), 'lobby no horizontal scroll');
  await host.screenshot({ path: `${OUT}/host-lobby-full.png` });
  const sound = (p) => p.evaluate(() => window.__olpSound());
  await host.waitForFunction(() => window.__olpSound().music.playing, null, { timeout: 10000 });
  let snd = await sound(host);
  ok(snd.music.file === 'titelmusic.webm' && !snd.bomb.playing, 'sound: title music plays in host lobby', snd);
  await host.waitForTimeout(700);
  ok((await sound(host)).music.pos > snd.music.pos, 'sound: title music is advancing');
  await players[0].waitForFunction(() => window.__olpSound().music.playing, null, { timeout: 10000 });
  ok(true, 'sound: phone plays title music in lobby');
  const lobbyMusicPos = (await sound(host)).music.pos;

  // connection loss + reconnect
  await players[4].context().setOffline(true);
  await players[4].waitForSelector('#net-banner:not([hidden])', { timeout: 15000 });
  ok((await players[4].innerText('#net-banner')).includes('VERBINDUNG ZUM HQ VERLOREN'), 'offline: banner VERBINDUNG ZUM HQ VERLOREN');
  ok((await h1(players[4])) === 'WAITING FOR COMMANDER', 'offline: last state stays visible');
  await players[4].screenshot({ path: `${OUT}/player-offline.png` });
  await players[4].context().setOffline(false);
  await players[4].waitForSelector('#net-banner', { state: 'hidden', timeout: 20000 });
  ok(true, 'reconnect: banner disappears');

  // reload in lobby keeps identity
  await players[3].reload();
  await waitH1(players[3], 'WAITING FOR COMMANDER');
  ok((await sqlRows(`select count(*)::int c from players where callsign ilike 'delta'`))[0].c === 1, 'reload does not create second player');

  // ===== Start (double click) =====
  console.log('GAME');
  await host.locator('[data-ctrl=start]').dblclick();
  await host.waitForSelector('.host-question');
  let g = (await sqlRows(`select status, current_question from games where code = $1`, [CODE]))[0];
  ok(g.status === 'question' && g.current_question === 1, 'double-click start -> exactly question 1', g);

  // late join
  const late = await newPage('late');
  await late.goto(JOIN_URL);
  await late.fill('#callsign', 'LateGuy');
  await late.click('form button[type=submit]');
  await late.waitForSelector('#join-error:text("MISSION BEREITS GESTARTET")');
  ok(true, 'late join blocked');
  await late.context().close();
  await extra.context().close();

  const correctOf = Object.fromEntries((await sqlRows('select question_index, correct_option from questions')).map((r) => [r.question_index, r.correct_option]));
  const wrongOf = (q) => (correctOf[q] === 'A' ? 'B' : 'A');

  async function answer(p, opt) {
    await p.waitForSelector('.answer', { timeout: 20000 });
    await p.click(`.answer[data-option="${opt}"]`);
    await p.click('.btn--confirm');
    await waitH1(p, 'ANSWER LOCKED');
  }

  let screenshotsDone = false;
  for (let q = 1; q <= 20; q++) {
    // everyone sees the same question
    await Promise.all(players.map((p) => p.waitForSelector('.answer', { timeout: 20000 })));
    const texts = await Promise.all(players.map((p) => p.innerText('.question-text')));
    const hostText = await host.innerText('.host-question');
    if (q === 1 || q === 11 || q === 20) ok(texts.every((t) => t === hostText), `Q${q}: all players see same question`);
    if (q === 1 || q === 2) {
      await host.waitForFunction(() => window.__olpSound().bomb.playing, null, { timeout: 5000 });
      const s1 = await sound(host);
      const expected = await host.evaluate(() => {
        // erwartete Position = Explosion − verbleibende Zeit (Countdown-Anzeige als Referenz)
        const left = Number(document.querySelector('.countdown__value').textContent);
        return 20.95 - left;
      });
      ok(s1.bomb.playing && !s1.music.playing && Math.abs(s1.bomb.pos - expected) < 1.3, `sound Q${q}: bomb runs in sync (pos ${s1.bomb.pos}, ~${expected.toFixed(2)})`, s1);
      const p1 = await sound(players[0]);
      ok(p1.bomb.playing && !p1.music.playing && Math.abs(p1.bomb.pos - s1.bomb.pos) < 0.6, `sound Q${q}: phone bomb in sync with TV (${p1.bomb.pos} vs ${s1.bomb.pos})`, p1);
    }
    if (q === 1) {
      await players[0].screenshot({ path: `${OUT}/player-question-390.png`, fullPage: true });
      ok(await noHScroll(players[0]), 'question screen no horizontal scroll');
      const leak = await players[0].evaluate(() => document.documentElement.outerHTML.includes('correct'));
      ok(!leak, 'no correct-answer data in player DOM');
      await host.screenshot({ path: `${OUT}/host-question.png` });
      ok(await host.evaluate(() => { const s = document.getElementById('stage'); return s.scrollHeight <= s.clientHeight + 1; }), 'host question fits 1600x900 without scrolling');
    }

    if (q === 2) {
      // one player does not answer -> host closes answers manually
      for (let i = 0; i < 9; i++) await answer(players[i], correctOf[q]);
      await host.waitForSelector('[data-ctrl=close]:not([disabled])');
      await host.click('[data-ctrl=close]');
      await host.waitForFunction(() => { const b = window.__olpSound().bomb; return b.pos >= 20.8 || !b.wanted; }, null, { timeout: 3000 });
      ok(true, 'sound: ANTWORTEN SCHLIESSEN jumps the bomb to the explosion');
      await waitH1(players[9], 'TIME EXPIRED', 10000);
      ok(true, 'Q2: closing answers shows TIME EXPIRED to non-answerer');
      await players[9].screenshot({ path: `${OUT}/player-expired.png` });
    } else {
      // 8 correct, 2 wrong (Alpha always correct)
      await Promise.all(players.map((p, i) => answer(p, i < 8 ? correctOf[q] : wrongOf(q))));
    }

    if (q === 1) {
      // duplicate answer via second tab / direct API call
      const sess = await players[8].evaluate(() => JSON.parse(localStorage.getItem('olp.player.' + localStorage.getItem('olp.player.last').replace(/"/g, ''))));
      const dup = await serial(() => rpcAs(db, 'anon', 'submit_answer', { p_player_id: sess.playerId, p_token: sess.token, p_question_index: 1, p_option: correctOf[1] }));
      ok(dup.data && dup.data.status === 'ALREADY_LOCKED' && dup.data.selected_option === wrongOf(1), 'second submit refused, original answer kept', dup);
      // reload after answer
      await players[1].reload();
      await waitH1(players[1], 'ANSWER LOCKED');
      ok(true, 'reload after answer stays ANSWER LOCKED');
      // second tab of same player
      const tab2 = await players[2].context().newPage();
      await tab2.goto(JOIN_URL);
      await waitH1(tab2, 'ANSWER LOCKED');
      ok(true, 'second tab shows same locked state');
      await tab2.close();
      await players[0].screenshot({ path: `${OUT}/player-locked.png` });
    }

    // reveal
    await host.waitForSelector('[data-ctrl=reveal]:not([disabled])', { timeout: 15000 });
    if (q === 1) await host.screenshot({ path: `${OUT}/host-all-answered.png` });
    await host.click('[data-ctrl=reveal]');
    await host.waitForSelector('.solution-badge');
    if (q === 1) {
      await host.waitForFunction(() => !window.__olpSound().bomb.playing, null, { timeout: 3000 });
      ok(true, 'sound: early reveal fades the bomb out');
      await host.waitForFunction(() => window.__olpSound().music.playing, null, { timeout: 6000 });
      const r1 = await sound(host);
      ok(r1.music.pos >= lobbyMusicPos, `sound: title music back on result screen, resumed at ${r1.music.pos}s (lobby ended ~${lobbyMusicPos}s)`, r1);
    }
    if (q === 2) {
      await host.waitForFunction(() => window.__olpSound().music.playing && !window.__olpSound().bomb.playing, null, { timeout: 10000 });
      ok(true, 'sound: title music returns after the explosion has faded');
    }
    await Promise.all(players.map((p) => p.waitForSelector('.result-title', { timeout: 15000 })));
    const titles = await Promise.all(players.map((p) => p.innerText('.result-title')));
    if (q !== 2) {
      ok(titles.slice(0, 8).every((t) => t === 'TARGET ELIMINATED') && titles.slice(8).every((t) => t === 'TARGET MISSED'), `Q${q}: 8 hit / 2 miss feedback`, titles);
    } else {
      ok(titles[9] === 'TIME EXPIRED', 'Q2: no answer -> TIME EXPIRED 0 PTS', titles[9]);
    }
    // points shown == DB points
    const shown = await players[0].innerText('.result-points');
    const dbPts = (await sqlRows(`select a.points from answers a join players p on p.id = a.player_id join games g on g.id = a.game_id where g.code = $1 and p.callsign = 'Alpha' and a.question_index = $2`, [CODE, q]))[0].points;
    ok(shown === `+${dbPts} PTS` && dbPts >= 100 && dbPts <= 195, `Q${q}: Alpha shown ${shown} = db ${dbPts}`);
    if (q === 1) {
      await players[0].screenshot({ path: `${OUT}/player-hit.png`, fullPage: true });
      await players[9].screenshot({ path: `${OUT}/player-miss.png`, fullPage: true });
      await host.screenshot({ path: `${OUT}/host-results.png` });
      await host.setViewportSize({ width: 1280, height: 720 });
      await host.waitForTimeout(300);
      await host.screenshot({ path: `${OUT}/host-results-1280.png` });
      ok(await host.evaluate(() => { const s = document.getElementById('stage'); return s.scrollHeight <= s.clientHeight + 1; }), 'host results fits 1280x720');
      await host.setViewportSize({ width: 1600, height: 900 });
    }

    if (q === 3) {
      // host reload mid-game
      await host.reload();
      await host.waitForSelector('.solution-badge', { timeout: 15000 });
      ok(true, 'host reload restores results view');
    }

    if (q === 10) {
      ok(await host.isEnabled('[data-ctrl=phase_break]'), 'after Q10: ZWISCHENRANKING enabled');
      ok(await host.isDisabled('[data-ctrl=next]'), 'after Q10: NÄCHSTE FRAGE disabled');
      await host.click('[data-ctrl=phase_break]');
      await waitH1(host, 'PHASE I COMPLETE');
      await host.waitForFunction(() => window.__olpSound().music.playing, null, { timeout: 8000 });
      ok(true, 'sound: title music plays in ZWISCHENRANKING');
      await Promise.all(players.map((p) => waitH1(p, 'PHASE I COMPLETE')));
      ok(true, 'phase break on host and players');
      ok((await host.locator('.ranking tbody tr').count()) === 10, 'interim ranking has 10 rows');
      await host.screenshot({ path: `${OUT}/host-phase-break.png` });
      await players[0].screenshot({ path: `${OUT}/player-phase-break.png`, fullPage: true });
      await host.click('[data-ctrl=phase2]');
    } else if (q === 20) {
      ok(await host.isEnabled('[data-ctrl=final]'), 'after Q20: FINALE ANZEIGEN enabled');
      await host.click('[data-ctrl=final]');
      await waitH1(host, 'MISSION ACCOMPLISHED');
      await host.waitForFunction(() => window.__olpSound().music.playing, null, { timeout: 8000 });
      ok(true, 'sound: title music plays in the finale');
    } else {
      // double click NEXT must advance exactly one question
      await host.locator('[data-ctrl=next]').dblclick();
      await host.waitForFunction((n) => document.querySelector('.qnum b')?.textContent === String(n), q + 1, { timeout: 10000 });
      g = (await sqlRows(`select current_question from games where code = $1`, [CODE]))[0];
      if (q === 1) ok(g.current_question === 2, 'double-click next -> exactly +1', g);
    }
  }

  // ===== Final =====
  console.log('FINAL');
  await Promise.all(players.map((p) => waitH1(p, 'MISSION ACCOMPLISHED')));
  ok(true, 'all players see MISSION ACCOMPLISHED');
  ok((await host.locator('.podium__slot--1 .top-operator').innerText()) === 'TOP OPERATOR', 'podium TOP OPERATOR');
  const top = await host.innerText('.podium__slot--1 .podium__name');
  const dbTop = (await sqlRows(`select p.callsign, p.score from players p join games g on g.id = p.game_id where g.code = $1 order by score desc, correct_time_ms asc limit 3`, [CODE]));
  ok(top === dbTop[0].callsign, `winner on podium = ${top}`, dbTop);
  const winnerPage = players[NAMES.indexOf(dbTop[0].callsign)];
  ok((await winnerPage.locator('.top-operator').count()) === 1, `winner (${dbTop[0].callsign}) sees TOP OPERATOR on phone`);
  const secondPage = players[NAMES.indexOf(dbTop[1].callsign)];
  ok((await secondPage.locator('.top-operator').count()) === 0 && (await secondPage.innerText('.final-pos')) === '#2', 'runner-up sees #2 without TOP OPERATOR');
  const sums = await sqlRows(`select p.score, (select coalesce(sum(points),0)::int from answers a where a.player_id = p.id) s from players p join games g on g.id = p.game_id where g.code = $1`, [CODE]);
  ok(sums.every((r) => r.score === r.s), 'every score == sum of its answer points');
  await host.screenshot({ path: `${OUT}/host-final.png` });
  const podiumEl = await host.$('.podium');
  await players[2].reload();               // erzeugt Live-Updates (last_seen)
  await waitH1(players[2], 'MISSION ACCOMPLISHED');
  await host.waitForTimeout(3000);
  ok(await podiumEl.evaluate((n) => n.isConnected), 'host final: podium/leaderboard not rebuilt on live updates');
  ok(await host.evaluate(() => { const s = document.getElementById('stage'); return s.scrollHeight <= s.clientHeight + 1; }), 'host final fits without scrolling');
  const pos1 = await host.locator('.panel--final tbody tr.is-top-1').count();
  ok(pos1 === 1, 'tie-breaker gives exactly one #1', pos1);
  await host.setViewportSize({ width: 1280, height: 720 });
  await host.waitForTimeout(300);
  await host.screenshot({ path: `${OUT}/host-final-1280.png` });
  await host.setViewportSize({ width: 1920, height: 1080 });
  await host.waitForTimeout(300);
  await host.screenshot({ path: `${OUT}/host-final-1920.png` });
  await host.setViewportSize({ width: 1600, height: 900 });
  await players[0].screenshot({ path: `${OUT}/player-final-winner.png`, fullPage: true });
  await players[9].screenshot({ path: `${OUT}/player-final-last.png`, fullPage: true });

  // export
  const [download] = await Promise.all([host.waitForEvent('download'), host.click('[data-ctrl=export]')]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  ok(csv.startsWith('\uFEFFPlatz;Callsign;Punkte;Rang') && csv.split('\r\n').length === 11, 'CSV export', csv.slice(0, 120));

  // new mission
  await host.click('[data-ctrl=new]');
  await host.waitForFunction((c) => { const el = document.querySelector('.mission-code'); return el && el.textContent.replace(/\s/g, '') !== c; }, CODE, { timeout: 10000 });
  ok(true, 'NEUE MISSION after final creates new code');

  // reset with confirmation
  await host.click('[data-ctrl=reset]');
  await host.waitForSelector('dialog:has-text("MISSION WIRKLICH ZURÜCKSETZEN?")');
  await host.click('dialog .btn--danger');
  await waitH1(host, 'MISSION ABGEBROCHEN');
  ok(true, 'reset with confirmation');

  // ===== Responsive checks =====
  console.log('RESPONSIVE');
  for (const w of [320, 375, 390, 430, 768]) {
    const p = await newPage('resp' + w, { width: w, height: 760 });
    await p.goto(SITE + '?game=123456');
    await p.waitForSelector('#callsign');
    ok(await noHScroll(p), `join ${w}px no horizontal scroll`);
    await p.screenshot({ path: `${OUT}/resp-join-${w}.png`, fullPage: true });
    await p.context().close();
  }
  for (const vp of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 800, height: 1000 }]) {
    await host.setViewportSize(vp);
    await host.waitForTimeout(200);
    ok(await noHScroll(host), `host ${vp.width}x${vp.height} no horizontal scroll`);
  }
} catch (e) {
  fail++;
  console.log('EXCEPTION', e);
} finally {
  console.log('\nconsole errors:', consoleErrors.length ? consoleErrors : 'none');
  console.log('unexpected rpc errors:', unexpectedRpcErrors.length ? [...new Set(unexpectedRpcErrors)] : 'none');
  if (unexpectedRpcErrors.length) fail++;
  if (consoleErrors.length) fail++;
  console.log('rpc calls:', JSON.stringify(rpcCount), 'realtime messages sent:', rtSent);
  console.log(`\nE2E: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
}
