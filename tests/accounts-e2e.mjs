// Browser-Test: Login/Profil, Mission Ops (Check-in nur Commander), Hold-Screen,
// Quiz-Beitritt mit Login, CS-Stats durch die Spieler, Bracket-Übernahme
import { startBackend, reporter, noHScroll, PASSWORD, OUT } from './backend.mjs';

const B = await startBackend({ port: 8772, realtime: process.env.RT !== '0' });
const R = reporter();
const check = R.ok;
const text = (page, sel) => page.innerText(sel);

async function register(page, user, pw) {
  await page.goto(B.SITE + 'login.html');
  await page.click('button:text("NEU HIER? ACCOUNT ERSTELLEN")');
  await page.fill('#acc-user', user);
  await page.fill('#acc-pass', pw);
  await page.fill('#acc-pass2', pw);
  await page.click('form button[type=submit]');
  await page.waitForSelector('.hub-tile');
  await page.goto(B.SITE + 'login.html');
  await page.waitForSelector('.profile__name');
}
async function login(page, user, pw, ret = '') {
  await page.goto(B.SITE + 'login.html' + (ret ? `?return=${encodeURIComponent(ret)}` : ''));
  await page.fill('#acc-user', user);
  await page.fill('#acc-pass', pw);
  await page.click('form button[type=submit]');
}

try {
  // ===== Registrierung + Profil =====
  console.log('ACCOUNTS');
  const p1 = await B.newPage('hans', { width: 390, height: 844 });
  const p2 = await B.newPage('rushb', { width: 390, height: 844 });
  await register(p1, 'HeadshotHans', 'hans1234');
  check((await p1.$eval('.profile__name', (e) => e.textContent)) === 'HeadshotHans', 'register → profile');
  check((await text(p1, '.profile__status')).includes('NOCH NICHT EINGECHECKT'), 'profile: not checked in, commander does it');
  check((await p1.$$('button:text("EINCHECKEN")')).length === 0, 'no self check-in button');
  check((await text(p1, '#account-link')).includes('HeadshotHans'), 'topbar shows account');
  await p1.screenshot({ path: `${OUT}/profile-390.png`, fullPage: true });
  await register(p2, 'RushB', 'rushb!!');
  const dup = await B.newPage('dup');
  await dup.goto(B.SITE + 'login.html');
  await dup.click('button:text("NEU HIER? ACCOUNT ERSTELLEN")');
  await dup.fill('#acc-user', 'rushb');
  await dup.fill('#acc-pass', 'abcd');
  await dup.fill('#acc-pass2', 'abcd');
  await dup.click('form button[type=submit]');
  await dup.waitForSelector('#acc-error:text("NAME DOPPELT")');
  check(true, 'duplicate username rejected');
  await login(dup, 'RushB', 'falsch');
  await dup.waitForSelector('#acc-error:text("LOGIN FEHLGESCHLAGEN")');
  check(true, 'wrong password rejected');
  await dup.context().close();

  // ===== Mission Ops (Commander) =====
  console.log('OPS');
  const cmd = await B.newPage('commander', { width: 1600, height: 900 });
  await cmd.goto(B.SITE + 'commander.html');
  await cmd.click('main button:text("COMMANDER LOGIN")');
  await cmd.fill('#cmd-password', PASSWORD);
  await cmd.click('dialog button[type=submit]');
  await cmd.waitForFunction(() => document.querySelectorAll('.ops-row').length === 3, null, { timeout: 10000 });
  check(true, 'ops: 2 operators + commander havoc listed');
  check((await cmd.innerText('.ops-row:has(.ops-row__name:text-is("havoc"))')).includes('COMMANDER'), 'ops: havoc shown as COMMANDER (no check-in button)');
  await cmd.fill('#ops-user', 'AWP_Gott');
  await cmd.fill('#ops-pass', 'awp123');
  await cmd.click('.ops-create button[type=submit]');
  await cmd.waitForFunction(() => document.querySelectorAll('.ops-row').length === 4, null, { timeout: 10000 });
  check(true, 'ops: commander creates account in advance');

  // ===== Hold-Screen =====
  console.log('HOLD');
  const tv = await B.newPage('tv', { width: 1920, height: 1080 });
  await login(tv, 'AWP_Gott', 'awp123');   // Start = Login, danach Startseite
  await tv.waitForSelector('.hub-tile');
  check(await tv.isHidden('#hold'), 'site open while hold is off');
  await cmd.click('button:text("HOLD-SCREEN AKTIVIEREN")');
  await tv.waitForSelector('#hold:not([hidden])', { timeout: 10000 });
  check((await text(tv, '.hold__count')).includes('0 / 3'), 'hold screen: 0 / 3 on site');
  await tv.screenshot({ path: `${OUT}/hold-1920.png` });
  const phone = await B.newPage('phone-hold', { width: 390, height: 844 });
  await phone.goto(B.SITE + 'counter.html');
  await phone.waitForSelector('#hold:not([hidden])', { timeout: 10000 });
  check(await noHScroll(phone), 'hold screen phone: no horizontal scroll');
  await phone.screenshot({ path: `${OUT}/hold-390.png` });
  // Start der Seite = Login; Login geht auch während des Holds, danach Hold-Screen
  const outsider = await B.newPage('outsider');
  await outsider.goto(B.SITE);
  await outsider.waitForURL(/login\.html$/, { timeout: 10000 });
  await outsider.waitForSelector('#acc-user');
  check(await outsider.isHidden('#hold'), 'start screen = login form, usable during hold');
  await outsider.fill('#acc-user', 'RushB');
  await outsider.fill('#acc-pass', 'rushb!!');
  await outsider.click('form button[type=submit]');
  await outsider.waitForURL(/index\.html$/, { timeout: 10000 });
  await outsider.waitForSelector('#hold:not([hidden])', { timeout: 10000 });
  check(true, 'after login a player sees the hold screen');
  const blocked = await outsider.evaluate(async () => {
    const m = await import('./js/supabase-client.js');
    const acc = JSON.parse(localStorage.getItem('olp.account'));
    try { return await m.rpc('join_game_account', { p_token: acc.token }); } catch (e) { return { error: e.code }; }
  });
  check(blocked.error === 'SITE_ON_HOLD', 'server blocks quiz join during hold', blocked);
  await outsider.context().close();
  // Commander loggt sich über den Start-Bildschirm ein und hat keinen Hold
  const cmdPhone = await B.newPage('havoc-phone', { width: 390, height: 844 });
  await cmdPhone.goto(B.SITE);
  await cmdPhone.waitForSelector('#acc-user');
  await cmdPhone.fill('#acc-user', 'havoc');
  await cmdPhone.fill('#acc-pass', PASSWORD);
  await cmdPhone.click('form button[type=submit]');
  await cmdPhone.waitForSelector('.hub-tile', { state: 'visible', timeout: 10000 });
  check(await cmdPhone.isHidden('#hold'), 'commander havoc has no hold (normal site)');
  await cmdPhone.goto(B.SITE + 'counter.html');
  await cmdPhone.waitForSelector('.cnt-team');
  await cmdPhone.waitForTimeout(800);
  check(await cmdPhone.isHidden('#hold'), 'commander: no hold on other pages either');
  await cmdPhone.goto(B.SITE + 'quiz.html');
  await cmdPhone.waitForSelector('#to-mission-control');
  check((await cmdPhone.$$('#join-account, #callsign')).length === 0, 'commander on quiz page: MISSION CONTROL instead of joining');
  await cmdPhone.goto(B.SITE);
  await cmdPhone.waitForSelector('.hub-tile');
  check((await cmdPhone.getAttribute('.hub-tile__main >> nth=0', 'href')) === './host.html', 'commander: quiz tile leads to MISSION CONTROL');
  await cmdPhone.screenshot({ path: `${OUT}/quiz-commander-390.png` });
  await cmdPhone.screenshot({ path: `${OUT}/hold-commander-390.png` });
  await cmdPhone.context().close();

  const checkIn = async (name) => cmd.click(`.ops-row:has(.ops-row__name:text-is("${name}")) .ops-check`);
  await checkIn('HeadshotHans');
  await checkIn('RushB');
  await tv.waitForFunction(() => document.querySelector('.hold__count')?.textContent.includes('2 / 3'), null, { timeout: 10000 });
  check(await tv.isVisible('#hold'), '2/3 checked in → still on hold');
  await cmd.screenshot({ path: `${OUT}/ops-1600.png`, fullPage: true });
  await checkIn('AWP_Gott');
  await tv.waitForSelector('#hold', { state: 'hidden', timeout: 10000 });
  await phone.waitForSelector('#hold', { state: 'hidden', timeout: 10000 });
  check(true, 'all checked in → site unlocks live on all devices');
  check((await text(cmd, '.ops-tiles')).includes('3 / 3'), 'ops tile: 3 / 3 on site');
  await p1.goto(B.SITE + 'login.html');
  await p1.waitForSelector('.profile__status.is-in', { timeout: 15000 });
  check(true, 'profile shows EINGECHECKT after commander check-in');

  // ===== Quiz mit Login =====
  console.log('QUIZ');
  const host = await B.newPage('host', { width: 1600, height: 900 });
  // gleiche Commander-Sitzung wie MISSION OPS
  await host.context().addInitScript((tok) => localStorage.setItem('olp.host', tok), await cmd.evaluate(() => localStorage.getItem('olp.host')));
  await host.goto(B.SITE + 'host.html');
  await host.click('button:text("NEUE MISSION")');
  await host.waitForSelector('.mission-code');
  await p1.goto(B.SITE + 'quiz.html');
  await p1.waitForSelector('#join-account');
  check((await p1.$eval('#join-account', (e) => e.textContent)) === 'ALS HeadshotHans BEITRETEN', 'quiz: join button with username');
  await p1.screenshot({ path: `${OUT}/quiz-account-390.png`, fullPage: true });
  await p1.click('#join-account');
  await p1.waitForFunction(() => document.querySelector('main h1')?.textContent.includes('WAITING FOR COMMANDER'), null, { timeout: 10000 });
  check((await text(p1, '.callsign')) === 'HeadshotHans', 'joined without code, callsign = username');
  await host.waitForFunction(() => [...document.querySelectorAll('.chips--lobby .chip__name')].some((e) => e.textContent === 'HeadshotHans'), null, { timeout: 10000 });
  check(true, 'host sees account player');
  const p1b = await B.newPage('hans-laptop', { width: 1280, height: 800 });
  await login(p1b, 'HeadshotHans', 'hans1234', 'quiz.html');
  await p1b.waitForSelector('#join-account');
  await p1b.click('#join-account');
  await p1b.waitForFunction(() => document.querySelector('main h1')?.textContent.includes('WAITING FOR COMMANDER'), null, { timeout: 10000 });
  await host.waitForTimeout(1500);
  check((await host.$$('.chips--lobby .chip')).length === 1, 'second device: same player, no duplicate');
  await p1b.context().close();

  // ===== CS-Stats =====
  console.log('STATS');
  await cmd.goto(B.SITE + 'counter.html');
  await cmd.waitForSelector('.cnt-editor:not([hidden])');
  await cmd.$eval('.cnt-team-edit', (d) => { d.open = true; });
  const roster = await cmd.$$('.cnt-roster-inputs input');
  await roster[0].fill('HeadshotHans');
  await roster[1].fill('RushB');
  await roster[2].fill('Ghost');
  await cmd.click('button:text("TEAM SPEICHERN")');
  await cmd.waitForFunction(() => document.querySelector('.cnt-team-edit .field__hint:last-of-type, .cnt-team-edit p.field__hint')?.textContent.length > 0);
  check((await cmd.innerText('.cnt-team-edit')).includes('Ohne Account (können keine Stats eintragen): Ghost'), 'editor warns about roster name without account');
  await cmd.fill('#cnt-map', 'Mirage');
  await cmd.fill('#cnt-us', '13');
  await cmd.fill('#cnt-them', '9');
  await cmd.click('.cnt-add.is-win');
  await cmd.waitForFunction(() => document.querySelectorAll('.cnt-log__item').length === 1);

  await p1.goto(B.SITE + 'counter.html');
  await p1.waitForSelector('.cnt-mine__todo', { timeout: 10000 });
  check((await text(p1, '.cnt-mine__todo')).includes('1 MATCH OHNE DEINE STATS'), 'player sees pending stats banner');
  await p1.click('.cnt-mine__todo button');
  await p1.waitForSelector('dialog .stats-form');
  for (const [id, v] of [['kills', 24], ['assists', 5], ['deaths', 14], ['hs', 54], ['adr', 102], ['mvps', 4]]) await p1.fill(`#st-${id}`, String(v));
  await p1.screenshot({ path: `${OUT}/stats-dialog-390.png` });
  await p1.click('dialog button[type=submit]');
  await p1.waitForSelector('.cnt-mine__hint.is-ok', { timeout: 10000 });
  check(true, 'player submits own stats');

  await p2.goto(B.SITE + 'counter.html'); // seit der Registrierung eingeloggt
  await p2.waitForSelector('.cnt-log__stats', { timeout: 10000 });
  await p2.click('.cnt-log__stats');
  await p2.click('button:text("MEINE STATS EINTRAGEN")');
  for (const [id, v] of [['kills', 18], ['assists', 7], ['deaths', 16], ['hs', 41], ['adr', 88], ['mvps', 2]]) await p2.fill(`#st-${id}`, String(v));
  await p2.click('dialog button[type=submit]');
  await cmd.waitForFunction(() => document.querySelector('.cnt-log__stats')?.textContent.includes('2/3'), null, { timeout: 10000 });
  check(true, 'commander sees 2/3 stats live');
  const lb = await cmd.$$eval('.stats-table tbody tr', (rows) => rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent)));
  check(lb[0][1] === 'HeadshotHans' && lb[0][2] === '1' && lb[0][3] === '24' && lb[0][6] === '1.71' && lb[0][9] === '102', 'leaderboard: Hans 1st by K/D (24/14 = 1.71), ADR 102', lb);
  check(lb[2][1] === 'Ghost' && lb[2][2] === '–', 'roster member without stats shows –', lb[2]);
  await cmd.click('.stats-sort:text("ADR")');
  check((await cmd.$eval('.stats-sort.is-active', (e) => e.textContent)) === 'ADR', 'leaderboard sortable');
  await cmd.click('.cnt-log__stats');
  await cmd.waitForSelector('.stats-board');
  const board = await cmd.$$eval('.stats-board tbody tr', (rows) => rows.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
  check(board[0].startsWith('HeadshotHans 24 5 14 +10 54 % 102 4') && board[2].includes('OFFEN'), 'match scoreboard sorted by kills, missing = OFFEN', board);
  await cmd.screenshot({ path: `${OUT}/counter-stats-1600.png`, fullPage: true });
  const awp = await B.newPage('awp', { width: 390, height: 844 });
  await login(awp, 'AWP_Gott', 'awp123', 'counter.html');
  await awp.waitForSelector('.cnt-mine__hint');
  check((await text(awp, '.cnt-mine__hint')).includes('nicht im 5er-Team') && (await awp.$$('button:text("MEINE STATS")')).length === 0, 'non-team player cannot enter stats');
  check(await noHScroll(awp), 'counter with stats: phone no horizontal scroll');
  await p1.goto(B.SITE + 'login.html');
  await p1.waitForSelector('.facts--stats');
  check((await text(p1, '.facts--stats')).includes('1.71'), 'profile shows own K/D');

  // ===== Bracket: Eingecheckte übernehmen =====
  console.log('BRACKET');
  await cmd.goto(B.SITE + 'bracket.html');
  await cmd.waitForSelector('.tn-setup:not([hidden])');
  await cmd.waitForFunction(() => document.querySelectorAll('.tn-acc__chip').length === 4, null, { timeout: 10000 });
  await cmd.click('button:text("EINGECHECKTE ÜBERNEHMEN")');
  const setupNames = await cmd.$$eval('.tn-setup__grid input', (els) => els.map((e) => e.value).filter(Boolean));
  check(setupNames.sort().join(',') === 'AWP_Gott,HeadshotHans,RushB,havoc', 'bracket: takes the checked-in operators incl. commander havoc', setupNames);
  await cmd.click('.tn-acc__chip:not([disabled])').catch(() => {});

  // ===== Ops: Badges =====
  await cmd.goto(B.SITE + 'commander.html');
  await cmd.waitForSelector('.ops-row');
  const hansRow = await cmd.innerText('.ops-row:has(.ops-row__name:text-is("HeadshotHans"))');
  check(hansRow.includes('TEAM') && hansRow.includes('QUIZ') && hansRow.includes('ONLINE') && hansRow.includes('ON SITE'), 'ops row: badges TEAM/QUIZ, ONLINE, ON SITE', hansRow);
  check(!hansRow.includes('STATS OFFEN'), 'ops row: no open stats after submit');
} catch (e) {
  R.fail++;
  console.log('EXCEPTION', e);
} finally {
  console.log('\nconsole errors:', B.consoleErrors.length ? B.consoleErrors : 'none');
  console.log('unexpected rpc errors:', B.stats.unexpectedErrors.length ? B.stats.unexpectedErrors : 'none');
  if (B.consoleErrors.length || B.stats.unexpectedErrors.length) R.fail++;
  console.log(`\nACCOUNTS E2E: ${R.pass} passed, ${R.fail} failed`);
  await B.close();
  process.exit(R.fail ? 1 : 0);
}
