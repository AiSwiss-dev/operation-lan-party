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
ok(r.data && r.data.team.name === 'NJORGIBICEPS SQUAD' && r.data.team.roster.length === 5 && r.data.totals.wins === 0, 'counter_state default', r);
r = await anon(db, 'bracket_state', {});
ok(r.data && r.data.names.length === 5 && r.data.scores.length === 8 && r.data.scores.every((x) => x === null), 'bracket_state default', r);
ok((await anonSql('select * from counter_matches')).rows !== undefined, 'anon can read counter_matches (realtime)');
ok((await anonSql("insert into counter_matches(result) values ('W')")).error?.includes('permission denied'), 'anon cannot insert matches');
ok((await anonSql("update bracket set names = array['a','b','c','d','e']")).error?.includes('permission denied'), 'anon cannot update bracket');
ok((await anonSql("update counter_team set name = 'hacked'")).error?.includes('permission denied'), 'anon cannot update team');
errIs(await anon(db, '_clean_label', { p: 'x', p_max: 5 }), 'permission denied', 'internal _clean_label not callable');

// ---- Host-Pflicht ---------------------------------------------------------------------
for (const [fn, args] of [
  ['counter_add_match', { p_token: 'nope', p_result: 'W', p_map: null, p_score_us: null, p_score_them: null }],
  ['counter_set_team', { p_token: 'nope', p_name: 'X', p_roster: ['a', 'b', 'c', 'd', 'e'] }],
  ['counter_delete_match', { p_token: 'nope', p_id: 1 }],
  ['counter_reset', { p_token: 'nope' }],
  ['bracket_save', { p_token: 'nope', p_names: ['a', 'b', 'c', 'd', 'e'], p_scores: [null, null, null, null, null, null, null, null] }],
  ['bracket_reset', { p_token: 'nope', p_keep_names: true }],
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

// ---- Bracket ---------------------------------------------------------------------------
const N = (a) => a;
const save = (names, scores) => anon(db, 'bracket_save', { p_token: HOST, p_names: names, p_scores: scores });
r = await save(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'], [13, 7, null, null, 16, 14, null, null]);
ok(r.data && r.data.names.join(',') === 'Alpha,Bravo,Charlie,Delta,Echo' && r.data.scores[0] === 13 && r.data.scores[2] === null && r.data.version === 2, 'bracket saved', r.data);
r = await save(['  Alpha  ', '', 'Charlie', 'Delta', 'Echo'], [null, null, null, null, null, null, null, null]);
ok(r.data.names[0] === 'Alpha' && r.data.names[1] === '' && r.data.version === 3, 'names trimmed, empty slot allowed', r.data.names);
errIs(await save(['a', 'b', 'c', 'd'], [null, null, null, null, null, null, null, null]), 'BRACKET_INVALID', 'need 5 names');
errIs(await save(['a', 'b', 'c', 'd', 'e'], [null, null, null]), 'BRACKET_INVALID', 'need 8 scores');
errIs(await save(['a', 'b', 'c', 'd', 'e'], [100, null, null, null, null, null, null, null]), 'BRACKET_INVALID', 'score > 99 rejected');
errIs(await save(['a', 'b', 'c', 'd', 'e'], [-1, null, null, null, null, null, null, null]), 'BRACKET_INVALID', 'negative score rejected');
errIs(await save(['<script>', 'b', 'c', 'd', 'e'], [null, null, null, null, null, null, null, null]), 'NAME_CHARS', 'html name rejected');
await save(N(['A1', 'B1', 'C1', 'D1', 'E1']), [1, 2, 3, 4, 5, 6, 7, 8]);
r = await anon(db, 'bracket_reset', { p_token: HOST, p_keep_names: true });
ok(r.data.names[0] === 'A1' && r.data.scores.every((x) => x === null), 'reset scores keeps names');
r = await anon(db, 'bracket_reset', { p_token: HOST, p_keep_names: false });
ok(r.data.names.every((x) => x === ''), 'reset all clears names');

// idempotent re-run keeps data
await save(['Keep', 'b', 'c', 'd', 'e'], [1, 0, null, null, null, null, null, null]);
await add('W', null, null, null);
const fs = await import('node:fs');
const { SCHEMA } = await import('./pg-harness.mjs');
await db.exec(fs.readFileSync(SCHEMA, 'utf8'));
ok((await anon(db, 'bracket_state', {})).data.names[0] === 'Keep' && (await anon(db, 'counter_state', {})).data.totals.wins === 1, 'schema re-run keeps bracket + counter data');

console.log(`\nEXTRAS SQL TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
