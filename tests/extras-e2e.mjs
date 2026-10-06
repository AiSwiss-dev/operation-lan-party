// Browser-Test: Startseite, Game Counter und Bracket (Commander + Live-Zuschauer)
import { startBackend, reporter, noHScroll, PASSWORD, OUT } from './backend.mjs';

const B = await startBackend({ port: 8771, realtime: process.env.RT !== '0' });
const R = reporter();
const check = R.ok;

async function login(page) {
  await page.click('#cmd-area button:text("COMMANDER LOGIN")');
  await page.fill('#cmd-password', PASSWORD);
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('#cmd-area button:text("LOGOUT")');
}
const text = (page, sel) => page.innerText(sel);

try {
  // ===== Startseite =====
  console.log('HUB');
  const hub = await B.newPage('hub', { width: 390, height: 844 });
  await hub.goto(B.SITE);
  await hub.waitForSelector('.hub-tile');
  const tiles = await hub.$$eval('.hub-tile__title', (els) => els.map((e) => e.textContent));
  check(tiles.join('|') === 'QUIZ|GAME COUNTER|BRACKET', 'hub shows 3 options', tiles);
  const links = await hub.$$eval('.hub-grid a', (els) => els.map((e) => e.getAttribute('href')));
  check(links.join('|') === './quiz.html|./host.html|./counter.html|./bracket.html', 'hub links', links);
  check(await noHScroll(hub), 'hub no horizontal scroll (390)');
  await hub.screenshot({ path: `${OUT}/hub-390.png`, fullPage: true });
  await hub.setViewportSize({ width: 1600, height: 900 });
  await hub.screenshot({ path: `${OUT}/hub-1600.png` });
  await hub.goto(B.SITE + '?game=123456');
  await hub.waitForURL(/quiz\.html\?game=123456$/);
  await hub.waitForSelector('#mission-code');
  check((await hub.inputValue('#mission-code')) === '123456', 'old QR link ?game= redirects to quiz with code');
  await hub.click('.topbar__back');
  await hub.waitForSelector('.hub-tile');
  check(true, 'MENÜ link returns to hub');

  // ===== Game Counter =====
  console.log('COUNTER');
  const cmd = await B.newPage('counter-cmd', { width: 1600, height: 900 });
  const view = await B.newPage('counter-view', { width: 390, height: 844 });
  await cmd.goto(B.SITE + 'counter.html');
  await view.goto(B.SITE + 'counter.html');
  await view.waitForFunction(() => document.querySelector('.cnt-team')?.textContent === 'NJORGIBICEPS SQUAD');
  check(await view.isHidden('.cnt-editor'), 'viewer: no editor');
  check((await view.$$('#cmd-area button:text("COMMANDER LOGIN")')).length === 1, 'viewer: login button');
  await login(cmd);
  check(await cmd.isVisible('.cnt-editor'), 'commander: editor visible after login');

  // Team
  await cmd.click('.cnt-team-edit summary');
  await cmd.fill('#cnt-team', 'Njorgi Squad');
  const roster = ['njorgiBiceps', 'HeadshotHans', 'RushB', 'AWP_Gott', 'FlashMeister'];
  const rosterInputs = await cmd.$$('.cnt-roster-inputs input');
  for (let i = 0; i < 5; i++) await rosterInputs[i].fill(roster[i]);
  await cmd.click('button:text("TEAM SPEICHERN")');
  await view.waitForFunction(() => document.querySelector('.cnt-team')?.textContent === 'Njorgi Squad', null, { timeout: 10000 });
  const viewRoster = await view.$$eval('.cnt-roster .chip__name', (els) => els.map((e) => e.textContent));
  check(viewRoster.join(',') === roster.join(','), 'viewer sees team + 5 operators live', viewRoster);

  // Matches
  await cmd.click('.cnt-add.is-win');
  await view.waitForFunction(() => document.querySelectorAll('.cnt-score__num')[0]?.textContent === '1', null, { timeout: 10000 });
  check(true, '+ SIEG without score counts');
  await cmd.fill('#cnt-map', 'Dust II');
  await cmd.fill('#cnt-us', '13');
  await cmd.fill('#cnt-them', '9');
  check(await cmd.isEnabled('.cnt-add.is-win') && await cmd.isDisabled('.cnt-add.is-loss') && await cmd.isDisabled('.cnt-add.is-tie'), 'score 13:9 → only SIEG enabled');
  check((await text(cmd, '.cnt-editor .field__hint')).includes('13:9 → SIEG'), 'score hint shows result');
  await cmd.click('.cnt-add.is-win');
  await cmd.waitForFunction(() => document.getElementById('cnt-us').value === '');
  await cmd.fill('#cnt-us', '9');
  await cmd.fill('#cnt-them', '13');
  await cmd.click('.cnt-add.is-loss');
  await cmd.waitForFunction(() => document.getElementById('cnt-us').value === '');
  await cmd.fill('#cnt-map', 'Mirage');
  await cmd.fill('#cnt-us', '12');
  await cmd.fill('#cnt-them', '12');
  await cmd.click('.cnt-add.is-tie');
  await view.waitForFunction(() => [...document.querySelectorAll('.cnt-score__num')].map((e) => e.textContent).join(',') === '2,1,1', null, { timeout: 10000 });
  check(true, 'viewer: W2 L1 T1 live');
  check((await view.innerText('.facts--triple')).includes('50 %'), 'winrate 50 %');
  check((await view.innerText('.facts--triple')).includes('1 REMIS'), 'streak shows latest result');
  const mapRows = await view.$$eval('.cnt-maptable tbody tr', (rows) => rows.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
  check(mapRows.some((r) => r.startsWith('Dust II 1 1 0 50 %')) && mapRows.some((r) => r.startsWith('Mirage 0 0 1 0 %')), 'map stats', mapRows);
  check((await view.$$('.cnt-log__item')).length === 4 && (await view.$$('.cnt-log .chip__remove')).length === 0, 'viewer: log without delete buttons');
  check(await noHScroll(view), 'counter viewer no horizontal scroll (390)');
  await view.screenshot({ path: `${OUT}/counter-view-390.png`, fullPage: true });
  await cmd.screenshot({ path: `${OUT}/counter-cmd-1600.png`, fullPage: true });

  // Undo + Reset
  await cmd.click('.cnt-log__item >> nth=0 >> .chip__remove');
  await cmd.click('dialog .btn--danger');
  await view.waitForFunction(() => document.querySelectorAll('.cnt-log__item').length === 3, null, { timeout: 10000 });
  check(true, 'delete last match propagates');
  await cmd.$eval('.cnt-team-edit', (d) => { d.open = true; });
  await cmd.click('button:text("BILANZ ZURÜCKSETZEN")');
  await cmd.waitForSelector('dialog:has-text("BILANZ WIRKLICH ZURÜCKSETZEN?")');
  await cmd.click('dialog .btn--danger');
  await view.waitForFunction(() => [...document.querySelectorAll('.cnt-score__num')].map((e) => e.textContent).join(',') === '0,0,0', null, { timeout: 10000 });
  check((await view.$eval('.cnt-team', (e) => e.textContent)) === 'Njorgi Squad', 'reset clears matches, keeps team');

  // ===== Bracket =====
  console.log('BRACKET');
  const bc = await B.newPage('bracket-cmd', { width: 1600, height: 900 });
  const bv = await B.newPage('bracket-view', { width: 1920, height: 1080 });
  const bm = await B.newPage('bracket-phone', { width: 390, height: 844 });
  await bc.goto(B.SITE + 'bracket.html');
  await bv.goto(B.SITE + 'bracket.html');
  await bm.goto(B.SITE + 'bracket.html');
  await bv.waitForSelector('#duel-d1');
  check((await bv.$$('.slot__input:visible')).length === 0, 'viewer: no inputs');
  check((await bv.$$('.br-line')).length === 4, 'viewer: 4 connector lines drawn');
  await bv.screenshot({ path: `${OUT}/bracket-empty-1920.png` });
  await login(bc);
  check(await bc.isVisible('.br-tools'), 'commander: bracket tools visible');
  const seeds = await bc.$$('.slot.is-seed .slot__input');
  check(seeds.length === 5, '5 seed inputs (Duel 01 ×2, Duel 02 Freilos, Duel 03 ×2)', seeds.length);
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
  for (let i = 0; i < 5; i++) await seeds[i].fill(names[i]);
  check(await bc.isDisabled('#duel-d4 .slot__score-input >> nth=0'), 'final score locked until both finalists known');
  const score = async (duel, a, b) => {
    await bc.fill(`#duel-${duel} .slot >> nth=0 >> .slot__score-input`, String(a));
    await bc.fill(`#duel-${duel} .slot >> nth=1 >> .slot__score-input`, String(b));
  };
  await score('d1', 13, 7);
  await bv.waitForFunction(() => document.querySelector('#duel-d2 .slot:nth-of-type(2) .slot__name')?.textContent === 'Alpha', null, { timeout: 10000 });
  check(true, 'winner Duel 01 advances to Duel 02 on viewer (live)');
  check(await bv.$eval('#duel-d1 .slot:nth-of-type(2)', (e) => e.classList.contains('is-loser')), 'loser marked');
  await score('d3', 14, 16);
  await score('d2', 13, 13);
  await bc.waitForTimeout(900);
  check((await text(bc, '#duel-d4 .slot >> nth=0 >> .slot__name')).includes('SIEGER DUEL 02'), 'tie 13:13 → no winner yet');
  await score('d2', 11, 13);
  await bv.waitForFunction(() => {
    const n = [...document.querySelectorAll('#duel-d4 .slot__name')].map((e) => e.textContent);
    return n[0] === 'Alpha' && n[1] === 'Echo';
  }, null, { timeout: 10000 });
  check(true, 'finalists Alpha (Duel 02) vs Echo (Duel 03)');
  await score('d4', 13, 10);
  await bv.waitForFunction(() => document.querySelector('.champ__name')?.textContent === 'Alpha', null, { timeout: 10000 });
  check(await bv.$eval('#champion', (e) => e.classList.contains('is-crowned')), 'CHAMPION Alpha crowned on viewer');
  check((await bv.$$('.br-line.is-active')).length === 4, 'all 4 lines active');
  check((await text(bv, '.br-status')).includes('CHAMPION // ALPHA'), 'status shows champion');
  await bm.waitForFunction(() => document.querySelector('.champ__name')?.textContent === 'Alpha', null, { timeout: 10000 });
  check(await noHScroll(bm), 'bracket phone no horizontal scroll (390)');
  await bv.screenshot({ path: `${OUT}/bracket-final-1920.png` });
  check(await bv.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 2), 'bracket fits 1920x1080 without scrolling (TV)');
  await bv.setViewportSize({ width: 1280, height: 720 });
  await bv.waitForTimeout(400);
  await bv.screenshot({ path: `${OUT}/bracket-final-1280.png` });
  check(await bv.$eval('#duel-d2 .duel__head', (e) => e.scrollHeight <= e.clientHeight + 1), 'duel headers stay on one line');
  await bv.setViewportSize({ width: 1920, height: 1080 });
  await bc.screenshot({ path: `${OUT}/bracket-edit-1600.png` });
  await bm.screenshot({ path: `${OUT}/bracket-phone-390.png`, fullPage: true });
  const dbState = (await B.sqlRows('select names, scores from public.bracket'))[0];
  check(dbState.names.join(',') === names.join(',') && dbState.scores.join(',') === '13,7,11,13,14,16,13,10', 'saved in database', dbState);

  // reload commander → state restored
  await bc.reload();
  await bc.waitForFunction(() => document.querySelector('.champ__name')?.textContent === 'Alpha');
  check(await bc.isVisible('.br-tools'), 'commander reload: still logged in + state restored');

  // Auslosen
  await bc.click('button:text("AUSLOSEN")');
  await bc.click('dialog .btn--danger');
  await bv.waitForFunction(() => document.querySelector('.champ__name')?.textContent === '—', null, { timeout: 10000 });
  await bc.waitForTimeout(1200);
  const drawn = (await B.sqlRows('select names, scores from public.bracket'))[0];
  check([...drawn.names].sort().join(',') === [...names].sort().join(',') && drawn.scores.every((s) => s === null), 'AUSLOSEN shuffles the 5 names and clears scores', drawn);

  // Alles leeren
  await bc.click('button:text("ALLES LEEREN")');
  await bc.click('dialog .btn--danger');
  await bv.waitForFunction(() => [...document.querySelectorAll('#duel-d1 .slot__name')].every((e) => e.classList.contains('is-empty')), null, { timeout: 10000 });
  check(true, 'ALLES LEEREN clears names on viewer');
} catch (e) {
  R.fail++;
  console.log('EXCEPTION', e);
} finally {
  console.log('\nconsole errors:', B.consoleErrors.length ? B.consoleErrors : 'none');
  console.log('unexpected rpc errors:', B.stats.unexpectedErrors.length ? B.stats.unexpectedErrors : 'none');
  if (B.consoleErrors.length || B.stats.unexpectedErrors.length) R.fail++;
  console.log(`\nEXTRAS E2E: ${R.pass} passed, ${R.fail} failed`);
  await B.close();
  process.exit(R.fail ? 1 : 0);
}
