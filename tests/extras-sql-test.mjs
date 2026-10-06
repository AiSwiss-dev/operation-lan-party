// Testet Game Counter + Bracket aus supabase/schema.sql (PGlite, Rolle anon)
import { createDb, anon } from './pg-harness.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) pass++;
  else { fail++; console.log('FAIL:', label, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const errIs = (res, code, label) => ok(res.error && res.error.message.includes(code), label, res);

const db = await createDb();
await db.query(`select public.set_commander_password('Commander-Test-2026')`);
const HOST = (await anon(db, 'host_login', { p_password: 'Commander-Test-2026' })).data.token;

async function anonSql(q) {
  await db.exec('set role anon');
  try { return { rows: (await db.query(q)).rows }; } catch (e) { return { error: e.message }; } finally { await db.exec('reset role'); }
}

// ---- Öffentliches Lesen / gesperrtes Schreiben -------------------------------------
let r = await anon(db, 'counter_state', {});
ok(r.data && r.data.team.name === 'LAN PARTY SQUAD' && r.data.team.roster.length === 5 && r.data.totals.wins === 0, 'counter_state default', r);
r = await anon(db, 'tournament_state', {});
ok(r.data && r.data.players.length === 0 && r.data.pairs.length === 0 && r.data.ko_scores.length === 8, 'tournament_state default', r);
ok((await anonSql('select * from counter_matches')).rows !== undefined, 'anon can read counter_matches (realtime)');
ok((await anonSql("insert into counter_matches(result) values ('W')")).error?.includes('permission denied'), 'anon cannot insert matches');
ok((await anonSql("update counter_team set name = 'hacked'")).error?.includes('permission denied'), 'anon cannot update team');
errIs(await anon(db, '_clean_label', { p: 'x', p_max: 5 }), 'permission denied', 'internal _clean_label not callable');

// ---- Host-Pflicht ---------------------------------------------------------------------
for (const [fn, args] of [
  ['counter_add_match', { p_token: 'nope', p_result: 'W', p_map: null, p_score_us: null, p_score_them: null }],
  ['counter_set_team', { p_token: 'nope', p_name: 'X', p_roster: ['a', 'b', 'c', 'd', 'e'] }],
  ['counter_delete_match', { p_token: 'nope', p_id: 1 }],
  ['counter_reset', { p_token: 'nope' }],
]) errIs(await anon(db, fn, args), 'HOST_UNAUTHORIZED', `${fn} needs commander`);

// ---- Team -----------------------------------------------------------------------------
r = await anon(db, 'counter_set_team', { p_token: HOST, p_name: '  Njorgi   Squad ', p_roster: ['Alpha', ' Bravo ', '', 'Delta', 'Echo'] });
ok(r.data && r.data.team.name === 'Njorgi Squad' && r.data.team.roster.join(',') === 'Alpha,Bravo,,Delta,Echo', 'team saved + cleaned', r.data?.team);
errIs(await anon(db, 'counter_set_team', { p_token: HOST, p_name: 'X', p_roster: ['a', 'b', 'c', 'd'] }), 'TEAM_INVALID', 'roster must have 5 slots');
errIs(await anon(db, 'counter_set_team', { p_token: HOST, p_name: '<b>x</b>', p_roster: ['a', 'b', 'c', 'd', 'e'] }), 'NAME_CHARS', 'team name html rejected');
errIs(await anon(db, 'counter_set_team', { p_token: HOST, p_name: 'X'.repeat(33), p_roster: ['a', 'b', 'c', 'd', 'e'] }), 'NAME_LENGTH', 'team name too long');
errIs(await anon(db, 'counter_set_team', { p_token: HOST, p_name: 'X', p_roster: ['a', 'b', 'c', 'd', 'Y'.repeat(25)] }), 'NAME_LENGTH', 'roster name too long');

// ---- Matches --------------------------------------------------------------------------
const add = (result, map, us, them) => anon(db, 'counter_add_match', { p_token: HOST, p_result: result, p_map: map, p_score_us: us, p_score_them: them });
r = await add('W', null, null, null);
ok(r.data && r.data.totals.wins === 1 && r.data.matches[0].result === 'W' && r.data.matches[0].map === null, 'win without score/map');
r = await add('L', 'Dust II', 13, 9);
ok(r.data.matches[0].result === 'W' && r.data.matches[0].map === 'Dust II', 'score 13:9 overrides result -> W', r.data.matches[0]);
r = await add(null, ' Mirage ', 9, 13);
ok(r.data.matches[0].result === 'L' && r.data.matches[0].map === 'Mirage', 'score 9:13 -> L', r.data.matches[0]);
r = await add(null, 'Inferno', 12, 12);
ok(r.data.matches[0].result === 'T', 'score 12:12 -> T (tie)');
r = await add('t', null, null, null);
ok(r.data.matches[0].result === 'T', 'lowercase result accepted');
errIs(await add('W', null, 13, null), 'SCORE_INVALID', 'only one score rejected');
errIs(await add('W', null, 100, 3), 'SCORE_INVALID', 'score > 99 rejected');
errIs(await add('X', null, null, null), 'RESULT_INVALID', 'invalid result rejected');
errIs(await add(null, null, null, null), 'RESULT_INVALID', 'no result + no score rejected');
errIs(await add('W', '<img>', null, null), 'NAME_CHARS', 'map html rejected');
r = await anon(db, 'counter_state', {});
ok(r.data.totals.wins === 2 && r.data.totals.losses === 1 && r.data.totals.ties === 2 && r.data.matches.length === 5, 'totals W2 L1 T2', r.data.totals);
ok(r.data.matches[0].id > r.data.matches[4].id, 'matches newest first');
const lastId = r.data.matches[0].id;
r = await anon(db, 'counter_delete_match', { p_token: HOST, p_id: lastId });
ok(r.data.matches.length === 4 && r.data.totals.ties === 1, 'delete match (undo)');
r = await anon(db, 'counter_reset', { p_token: HOST });
ok(r.data.matches.length === 0 && r.data.totals.wins === 0 && r.data.team.name === 'Njorgi Squad', 'reset keeps team, clears matches');

// ---- Bracket / Turnier -------------------------------------------------------------------
const setPlayers = (players) => anon(db, 'tournament_set_players', { p_token: HOST, p_players: players });
r = await setPlayers(['Alpha', ' Bravo ', '', 'Charlie', 'Delta', 'Echo']);
ok(r.data && r.data.players.join(',') === 'Alpha,Bravo,Charlie,Delta,Echo' && r.data.pairs.length === 0, 'players saved (trimmed, empty ignored), no draw yet', r.data);
errIs(await setPlayers(['A1', 'a1', 'B', 'C']), 'NAME_TAKEN', 'duplicate player (case-insensitive)');
errIs(await setPlayers(['1', '2', '3', '4', '5', '6', '7', '8', '9']), 'PLAYERS_COUNT', 'max 8 players');
errIs(await setPlayers(['<b>', 'x', 'y', 'z']), 'NAME_CHARS', 'html player rejected');
errIs(await anon(db, 'tournament_save_scores', { p_token: HOST, p_qual: [], p_ko: [null, null, null, null, null, null, null, null] }), 'NOT_DRAWN', 'scores need a draw');
await setPlayers(['Alpha', 'Bravo', 'Charlie']);
errIs(await anon(db, 'tournament_draw', { p_token: HOST }), 'PLAYERS_COUNT', 'draw needs at least 4 players');

for (const n of [4, 5, 6, 7, 8]) {
  const names = Array.from({ length: n }, (_, i) => `P${i + 1}`);
  await setPlayers(names);
  let allGood = true;
  for (let rep = 0; rep < 6; rep++) {
    r = await anon(db, 'tournament_draw', { p_token: HOST });
    const pairs = r.data.pairs;
    const games = Array(n).fill(0);
    let selfMatch = false;
    let dup = false;
    const seen = new Set();
    for (let k = 0; k < pairs.length; k += 2) {
      games[pairs[k]]++;
      games[pairs[k + 1]]++;
      if (pairs[k] === pairs[k + 1]) selfMatch = true;
      const key = [pairs[k], pairs[k + 1]].sort().join('-');
      if (seen.has(key)) dup = true;
      seen.add(key);
    }
    let backToBack = 0;
    for (let k = 2; k < pairs.length; k += 2) {
      const prev = [pairs[k - 2], pairs[k - 1]];
      if (prev.includes(pairs[k]) || prev.includes(pairs[k + 1])) backToBack++;
    }
    const good = pairs.length === 2 * n && games.every((g) => g === 2) && !selfMatch && !dup
      && r.data.qual_scores.length === 2 * n && r.data.qual_scores.every((x) => x === null);
    if (!good) { allGood = false; ok(false, `draw n=${n}`, r.data); }
    if (n >= 5 && backToBack > 0) { allGood = false; ok(false, `draw n=${n}: nobody plays twice in a row`, pairs); }
  }
  ok(allGood, `draw n=${n}: ${n} duels, everyone exactly 2x, no rematch${n >= 5 ? ', never twice in a row' : ''}`);
}
await setPlayers(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
const draws = new Set();
for (let i = 0; i < 8; i++) draws.add((await anon(db, 'tournament_draw', { p_token: HOST })).data.pairs.join(','));
ok(draws.size > 1, 'draw is random', draws.size);

const st = (await anon(db, 'tournament_state', {})).data;
const qual = [13, 7, 9, 13, 16, 14, 13, 11, 8, 13];
const ko = [13, 10, 11, 13, null, null, null, null];
r = await anon(db, 'tournament_save_scores', { p_token: HOST, p_qual: qual, p_ko: ko });
ok(r.data.qual_scores.join(',') === qual.join(',') && r.data.ko_scores[3] === 13 && r.data.ko_scores[4] === null && r.data.version > st.version, 'scores saved');
errIs(await anon(db, 'tournament_save_scores', { p_token: HOST, p_qual: qual.slice(0, 8), p_ko: ko }), 'BRACKET_INVALID', 'quali score count must match draw');
errIs(await anon(db, 'tournament_save_scores', { p_token: HOST, p_qual: qual, p_ko: ko.slice(0, 6) }), 'BRACKET_INVALID', 'ko needs 8 scores');
errIs(await anon(db, 'tournament_save_scores', { p_token: HOST, p_qual: [100, ...qual.slice(1)], p_ko: ko }), 'BRACKET_INVALID', 'score > 99 rejected');
r = await anon(db, 'tournament_clear_scores', { p_token: HOST });
ok(r.data.pairs.join(',') === st.pairs.join(',') && r.data.qual_scores.every((x) => x === null) && r.data.ko_scores.every((x) => x === null), 'clear scores keeps draw');
r = await setPlayers(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']);
ok(r.data.pairs.length === 0 && r.data.players.length === 6, 'changing players resets draw');
for (const [fn, args] of [['tournament_set_players', { p_token: 'x', p_players: ['a', 'b', 'c', 'd'] }], ['tournament_draw', { p_token: 'x' }],
  ['tournament_save_scores', { p_token: 'x', p_qual: [], p_ko: [] }], ['tournament_clear_scores', { p_token: 'x' }]]) {
  errIs(await anon(db, fn, args), 'HOST_UNAUTHORIZED', `${fn} needs commander`);
}
ok((await anonSql("update tournament set players = array['h','a','c','k']")).error?.includes('permission denied'), 'anon cannot update tournament');
ok((await anonSql('select * from tournament')).rows !== undefined, 'anon can read tournament (realtime)');
ok((await anonSql("select to_regclass('public.bracket') as t")).rows[0].t === null, 'old bracket table removed');

// idempotent re-run keeps data
await setPlayers(['Keep', 'b', 'c', 'd', 'e']);
await add('W', null, null, null);
const fs = await import('node:fs');
const { SCHEMA } = await import('./pg-harness.mjs');
await db.exec(fs.readFileSync(SCHEMA, 'utf8'));
ok((await anon(db, 'tournament_state', {})).data.players[0] === 'Keep' && (await anon(db, 'counter_state', {})).data.totals.wins === 1, 'schema re-run keeps tournament + counter data');

console.log(`\nEXTRAS SQL TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
