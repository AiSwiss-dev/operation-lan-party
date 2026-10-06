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

  // ===== Bracket / Turnier =====
  console.log('BRACKET');
  const bc = await B.newPage('bracket-cmd', { width: 1600, height: 900 });
  const bv = await B.newPage('bracket-view', { width: 1920, height: 1080 });
  const bm = await B.newPage('bracket-phone', { width: 390, height: 844 });
  await bc.goto(B.SITE + 'bracket.html');
  await bv.goto(B.SITE + 'bracket.html');
  await bm.goto(B.SITE + 'bracket.html');
  await bv.waitForSelector('.tn-wait:not([hidden])');
  check((await text(bv, '.tn-wait__text')).includes('WARTE AUF OPERATOREN'), 'viewer: setup phase waiting');

  // Schritt 1: Spieler vorab eintragen
  await login(bc);
  await bc.waitForSelector('.tn-setup:not([hidden])');
  const setupInputs = await bc.$$('.tn-setup__grid input');
  check(setupInputs.length === 8, 'setup: 8 player slots', setupInputs.length);
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
  for (let i = 0; i < names.length; i++) await setupInputs[i].fill(names[i]);
  check((await text(bc, '.tn-setup .br-save')).includes('5 OPERATOREN // 5 QUALI-DUELLE'), 'setup counter shows 5 duels');
  await bc.click('button:text("SPIELER SPEICHERN")');
  await bv.waitForFunction(() => document.querySelectorAll('.tn-wait__list .chip').length === 5, null, { timeout: 10000 });
  check((await text(bv, '.tn-wait__text')).includes('WARTE AUF AUSLOSUNG'), 'viewer sees 5 registered operators');
  await bv.screenshot({ path: `${OUT}/bracket-setup-1920.png` });

  // Schritt 2: Auslosen
  await bc.click('button:text("AUSLOSEN & STARTEN")');
  await bv.waitForSelector('.tn-board:not([hidden])', { timeout: 10000 });
  await bv.waitForFunction(() => document.querySelectorAll('.qrow').length === 5, null, { timeout: 10000 });
  const pairing = await bv.$$eval('.qrow', (rows) => rows.map((r) => [r.querySelector('.qrow__name--a').textContent, r.querySelector('.qrow__name--b').textContent]));
  const appearances = Object.fromEntries(names.map((n) => [n, 0]));
  for (const [a, b] of pairing) { appearances[a]++; appearances[b]++; }
  check(Object.values(appearances).every((c) => c === 2), 'draw: everyone plays exactly 2 quali duels', pairing);
  let consecutive = 0;
  for (let i = 1; i < pairing.length; i++) if (pairing[i].some((p) => pairing[i - 1].includes(p))) consecutive++;
  check(consecutive === 0, 'draw: nobody plays twice in a row', pairing);
  check(await bc.isDisabled('#ko-sf1 .slot__score-input >> nth=0'), 'playoffs locked during quali');
  check((await text(bv, '#ko-sf1 .slot__name >> nth=0')) === 'PLATZ 1 QUALI', 'semifinal placeholder before quali complete');

  // Schritt 3: Quali spielen – wer früher in der Liste steht, gewinnt (Alpha 2 Siege, Echo 0)
  const qrows = await bc.$$('.qrow');
  for (let k = 0; k < qrows.length; k++) {
    const [a, b] = pairing[k];
    const aWins = names.indexOf(a) < names.indexOf(b);
    await qrows[k].$$('.score-input').then(async ([ia, ib]) => {
      await ia.fill(String(aWins ? 13 : 5 + k));
      await ib.fill(String(aWins ? 5 + k : 13));
    });
  }
  await bv.waitForFunction(() => document.querySelector('.tn-progress')?.textContent === '5/5', null, { timeout: 10000 });
  const table = await bv.$$eval('.tn-ranking tbody tr', (rows) => rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent.trim())));
  const sortedOk = table.every((r, i) => i === 0 || Number(table[i - 1][5]) > Number(r[5]) || (Number(table[i - 1][5]) === Number(r[5]) && Number(table[i - 1][4]) >= Number(r[4])));
  check(table.length === 5 && table.every((r) => r[2] === '2') && sortedOk && table.slice(0, 2).some((r) => r[1] === 'Alpha') && table[0][5] === '6', 'quali table sorted by points, then round difference; all played 2', table);
  check(table[4][1].endsWith('OUT') && table.slice(0, 4).every((r) => !r[1].includes('OUT')) && Number(table[4][5]) === Math.min(...table.map((r) => Number(r[5]))), '5th place eliminated (OUT)', table[4]);
  const seeds = table.map((r) => r[1].replace(/\s*OUT$/, ''));
  const sfNames = await bv.$$eval('#ko-sf1 .slot__name, #ko-sf2 .slot__name', (els) => els.map((e) => e.textContent));
  check(sfNames.join(',') === [seeds[0], seeds[3], seeds[1], seeds[2]].join(','), 'semifinals: 1st vs 4th, 2nd vs 3rd', { sfNames, seeds });

  // Schritt 4: Playoffs
  const ko = async (id, a, b) => {
    await bc.fill(`#ko-${id} .slot >> nth=0 >> .slot__score-input`, String(a));
    await bc.fill(`#ko-${id} .slot >> nth=1 >> .slot__score-input`, String(b));
  };
  await ko('sf1', 13, 10);
  await ko('sf2', 9, 13);
  await bv.waitForFunction((exp) => [...document.querySelectorAll('#ko-final .slot__name, #ko-third .slot__name')].map((e) => e.textContent).join(',') === exp,
    [seeds[0], seeds[2], seeds[3], seeds[1]].join(','), { timeout: 10000 });
  check(true, 'final = SF winners, 3rd place match = SF losers (lower bracket)');
  await ko('third', 13, 11);
  await ko('final', 13, 7);
  await bv.waitForFunction((c) => document.querySelector('.champ__name')?.textContent === c, seeds[0], { timeout: 10000 });
  const standings = await bv.$$eval('.tn-standings__name', (els) => els.map((e) => e.textContent));
  check(standings.join(',') === [seeds[0], seeds[2], seeds[3], seeds[1], seeds[4]].join(','), 'final standings 1–5', standings);
  check((await text(bv, '.br-status')).includes('TOURNAMENT COMPLETE'), 'status: tournament complete');

  // Abschluss-Seite mit Leaderboard
  await bv.waitForSelector('.tn-finish:not([hidden])', { timeout: 10000 });
  check(await bv.isHidden('.tn-board'), 'finish page replaces the bracket automatically');
  check((await text(bv, '.tn-finish .podium__slot--1 .podium__name')) === seeds[0] && (await bv.$$('.tn-finish .top-operator')).length === 1, 'finish page: podium with TOP OPERATOR');
  const lb = await bv.$$eval('.tn-leaderboard tbody tr', (rows) => rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent)));
  check(lb.length === 5 && lb.map((r) => r[1]).join(',') === [seeds[0], seeds[2], seeds[3], seeds[1], seeds[4]].join(',') && lb[0][2] === 'CHAMPION' && lb[4][2] === 'OUT (QUALI)', 'leaderboard: 5 places with result', lb);
  check(lb[0][3] === '4-0-0', 'leaderboard: champion record over all duels (2 quali + HF + final)', lb[0]);
  await bv.waitForTimeout(700);
  await bv.screenshot({ path: `${OUT}/bracket-finish-1920.png` });
  check(await bv.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 2), 'finish page fits 1920x1080 (TV)');
  // Live-Update ohne Ergebnis-Änderung darf die Seite nicht neu aufbauen
  const podiumNode = await bv.$('.tn-finish .podium');
  await B.sqlRows('update public.tournament set version = version + 1, updated_at = now()');
  await bc.evaluate(() => 0);
  await bv.waitForTimeout(3500);
  check(await podiumNode.evaluate((n) => n.isConnected), 'finish page does not reload on live updates');
  // Umschalten Bracket ↔ Leaderboard
  await bv.click('.tn-view-toggle');
  await bv.waitForSelector('.tn-board:not([hidden])');
  check((await bv.$$('.tn-ko .br-line')).length === 5 && (await bv.$$('.tn-ko .br-line--lower')).length === 2, 'connector lines incl. 2 dashed lower-bracket lines');
  await bv.screenshot({ path: `${OUT}/bracket-final-1920.png` });
  check(await bv.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 2), 'bracket fits 1920x1080 without scrolling (TV)');
  check(await bv.$eval('#ko-sf1 .duel__head', (e) => e.scrollHeight <= e.clientHeight + 1), 'duel headers stay on one line');
  await bv.click('.tn-view-toggle:text("LEADERBOARD")');
  await bv.waitForSelector('.tn-finish:not([hidden])');
  check(true, 'LEADERBOARD button switches back');
  await bm.waitForSelector('.tn-finish:not([hidden])', { timeout: 10000 });
  check(await noHScroll(bm), 'finish page phone no horizontal scroll (390)');
  check(await bm.$eval('.tn-leaderboard', (t) => t.getBoundingClientRect().right <= t.closest('.br-page').getBoundingClientRect().right + 1), 'phone: leaderboard not cut off');
  await bm.screenshot({ path: `${OUT}/bracket-phone-390.png`, fullPage: true });
  await bc.screenshot({ path: `${OUT}/bracket-edit-1600.png` });
  await bv.setViewportSize({ width: 1280, height: 720 });
  await bv.waitForTimeout(400);
  await bv.screenshot({ path: `${OUT}/bracket-finish-1280.png` });
  await bv.setViewportSize({ width: 1920, height: 1080 });
  const dbT = (await B.sqlRows('select players, pairs, qual_scores, ko_scores from public.tournament'))[0];
  check(dbT.players.join(',') === names.join(',') && dbT.qual_scores.every((s) => s !== null) && dbT.ko_scores.every((s) => s !== null), 'saved in database', dbT);

  // Reload Commander → Stand wieder da
  await bc.reload();
  await bc.waitForSelector('.tn-finish:not([hidden])');
  check(await bc.isVisible('.br-tools:not(.tn-setup)') && (await text(bc, '.tn-finish .podium__slot--1 .podium__name')) === seeds[0], 'commander reload: still logged in + state restored');

  // Neu auslosen
  await bc.click('.br-tools button:text("NEU AUSLOSEN")');
  await bc.click('dialog .btn--danger');
  await bv.waitForFunction(() => document.querySelector('.tn-progress')?.textContent === '0/5', null, { timeout: 10000 });
  const redrawn = (await B.sqlRows('select pairs, qual_scores, ko_scores from public.tournament'))[0];
  check(redrawn.qual_scores.every((s) => s === null) && redrawn.ko_scores.every((s) => s === null) && redrawn.pairs.length === 10, 'NEU AUSLOSEN: new pairings, results cleared');

  // Spieler ändern → 4 Operatoren
  await bc.click('button:text("SPIELER ÄNDERN")');
  await bc.waitForSelector('.tn-setup:not([hidden])');
  await bc.fill('.tn-setup__grid input >> nth=4', '');
  await bc.click('button:text("AUSLOSEN & STARTEN")');
  await bv.waitForFunction(() => document.querySelectorAll('.qrow').length === 4, null, { timeout: 10000 });
  check((await text(bv, '.br-meta')).includes('4 OPERATORS'), 'changed to 4 operators: 4 quali duels');
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
