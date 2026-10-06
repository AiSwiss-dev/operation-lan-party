// Testet Operator-Accounts, Quiz-Login, CS-Stats, Mission Ops und Hold-Screen (PGlite, Rolle anon)
import { createDb, anon } from './pg-harness.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) pass++;
  else { fail++; console.log('FAIL:', label, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''); }
};
const errIs = (res, code, label) => ok(res.error && res.error.message.includes(code), label, res);
const db = await createDb();
await db.query(`select public.set_commander_password('Commander-Test-2026')`);
let HOST = (await anon(db, 'host_login', { p_password: 'Commander-Test-2026' })).data.token;
async function anonSql(q) {
  await db.exec('set role anon');
  try { return { rows: (await db.query(q)).rows }; } catch (e) { return { error: e.message }; } finally { await db.exec('reset role'); }
}

// ---- Registrierung / Login ----------------------------------------------------------
let r = await anon(db, 'account_register', { p_username: '  HeadshotHans ', p_password: 'hans1234' });
ok(r.data && r.data.ok && r.data.username === 'HeadshotHans' && r.data.token.length === 64, 'register', r);
const HANS = r.data.token;
errIs(await anon(db, 'account_register', { p_username: 'headshothans', p_password: 'xxxx1' }), 'NAME_TAKEN', 'username unique (case-insensitive)');
errIs(await anon(db, 'account_register', { p_username: 'A', p_password: 'abcd' }), 'NAME_LENGTH', 'username too short');
errIs(await anon(db, 'account_register', { p_username: '<b>x</b>', p_password: 'abcd' }), 'NAME_CHARS', 'html username rejected');
errIs(await anon(db, 'account_register', { p_username: 'RushB', p_password: 'abc' }), 'PASSWORD_INVALID', 'password min 4');
r = await anon(db, 'account_register', { p_username: 'RushB', p_password: 'rushb!' });
const RUSH = r.data.token;
r = await anon(db, 'account_login', { p_username: 'HEADSHOTHANS', p_password: 'hans1234' });
ok(r.data.ok && r.data.username === 'HeadshotHans', 'login case-insensitive username', r);
r = await anon(db, 'account_login', { p_username: 'Nobody', p_password: 'x' });
ok(r.data.ok === false && r.data.error === 'LOGIN_FAILED', 'unknown user → LOGIN_FAILED (no user enumeration)');
for (let i = 0; i < 8; i++) await anon(db, 'account_login', { p_username: 'RushB', p_password: 'wrong' + i });
r = await anon(db, 'account_login', { p_username: 'RushB', p_password: 'rushb!' });
ok(r.data.ok === false && r.data.error === 'LOGIN_LOCKED', 'lock after 8 failed logins', r.data);
r = await anon(db, 'account_me', { p_token: HANS, p_touch: true });
ok(r.data && r.data.username === 'HeadshotHans' && r.data.checked_in === false && r.data.team.in_roster === false, 'account_me', r.data);
errIs(await anon(db, 'account_me', { p_token: 'forged', p_touch: true }), 'ACCOUNT_UNAUTHORIZED', 'forged account token');

// ---- Commander-Account havoc ----------------------------------------------------------
r = await anon(db, 'account_login', { p_username: 'HAVOC', p_password: 'Commander-Test-2026' });
ok(r.data.ok && r.data.commander === true && r.data.username === 'havoc' && r.data.host_token, 'havoc logs in with commander password, gets host token', r.data);
const HAVOC = r.data.token;
ok((await anon(db, 'host_session_info', { p_token: r.data.host_token })).data.valid, 'havoc host token is a valid commander session');
ok((await anon(db, 'account_me', { p_token: HAVOC })).data.commander === true, 'account_me: commander flag');
errIs(await anon(db, 'account_register', { p_username: 'Havoc', p_password: 'abcd1' }), 'NAME_TAKEN', 'nobody can register as havoc');
await db.query(`select public.set_commander_password('Neues-Cmd-Passwort')`);
ok((await anon(db, 'account_login', { p_username: 'havoc', p_password: 'Neues-Cmd-Passwort' })).data.ok, 'changing commander password updates havoc');
errIs(await anon(db, 'account_me', { p_token: HAVOC }), 'ACCOUNT_UNAUTHORIZED', 'old havoc session logged out after password change');
await db.query(`select public.set_commander_password('Commander-Test-2026')`);
const HOST2 = (await anon(db, 'host_login', { p_password: 'Commander-Test-2026' })).data.token;

// ---- Rechte ---------------------------------------------------------------------------
ok((await anonSql('select * from accounts')).error?.includes('permission denied'), 'anon cannot read accounts');
ok((await anonSql('select * from account_sessions')).error?.includes('permission denied'), 'anon cannot read sessions');
ok((await anonSql("update accounts set checked_in = true")).error?.includes('permission denied'), 'anon cannot check in via table');
ok((await anonSql('select * from counter_stats')).rows !== undefined, 'anon can read counter_stats (leaderboard)');
ok((await anonSql("insert into counter_stats(match_id, account_id, kills, deaths, assists, hs_pct, adr) values (1, gen_random_uuid(), 99, 0, 0, 100, 999)")).error?.includes('permission denied'), 'anon cannot insert stats directly');
errIs(await anon(db, '_account_auth', { p_token: HANS }), 'permission denied', 'internal _account_auth not callable');
errIs(await anon(db, 'account_set_checkin', { p_token: HANS, p_checked: true }), 'does not exist', 'no self check-in function');
r = await anon(db, 'accounts_public', {});
ok(Array.isArray(r.data) && r.data.length === 3 && r.data.some((a) => a.username === 'havoc') && !JSON.stringify(r.data).includes('hash'), 'accounts_public lists names only (incl. commander havoc)', r.data);

// ---- Mission Ops ----------------------------------------------------------------------
errIs(await anon(db, 'ops_state', { p_token: 'x' }), 'HOST_UNAUTHORIZED', 'ops_state needs commander');
errIs(await anon(db, 'ops_set_checkin', { p_token: HANS, p_account_id: '00000000-0000-0000-0000-000000000000', p_checked: true }), 'HOST_UNAUTHORIZED', 'player token cannot check in');
r = await anon(db, 'ops_create_account', { p_token: HOST2, p_username: 'AWP_Gott', p_password: 'awp123' });
ok(r.data.accounts.length === 4, 'commander creates account in advance', r.data.accounts.map((a) => a.username));
ok((await anon(db, 'account_login', { p_username: 'AWP_Gott', p_password: 'awp123' })).data.ok, 'pre-created account can log in');
const ids = Object.fromEntries(r.data.accounts.map((a) => [a.username, a.id]));
r = await anon(db, 'ops_reset_password', { p_token: HOST2, p_account_id: ids.RushB, p_password: 'neu1234' });
ok((await anon(db, 'account_login', { p_username: 'RushB', p_password: 'neu1234' })).data.ok, 'reset password unlocks + works');
errIs(await anon(db, 'account_me', { p_token: RUSH }), 'ACCOUNT_UNAUTHORIZED', 'reset password logs out old sessions');

// ---- Hold-Screen ----------------------------------------------------------------------
r = await anon(db, 'site_status', {});
ok(r.data.open === true && r.data.hold_enabled === false && r.data.total === 3 && r.data.checked_in === 0, 'site open without hold', r.data);
await anon(db, 'ops_set_hold', { p_token: HOST2, p_enabled: true });
r = await anon(db, 'site_status', {});
ok(r.data.open === false && r.data.operators.length === 3, 'hold enabled → site on hold', r.data);
await anon(db, 'ops_set_checkin', { p_token: HOST2, p_account_id: ids.HeadshotHans, p_checked: true });
await anon(db, 'ops_set_checkin', { p_token: HOST2, p_account_id: ids.RushB, p_checked: true });
r = await anon(db, 'site_status', {});
ok(r.data.open === false && r.data.checked_in === 2, '2/3 checked in → still on hold', r.data);
await anon(db, 'ops_set_checkin', { p_token: HOST2, p_account_id: ids.AWP_Gott, p_checked: true });
r = await anon(db, 'site_status', {});
ok(r.data.open === true && r.data.released === true, 'all checked in → released automatically', r.data);
await anon(db, 'ops_set_checkin', { p_token: HOST2, p_account_id: ids.RushB, p_checked: false });
ok((await anon(db, 'site_status', {})).data.open === true, 'release stays after someone checks out');
await anon(db, 'ops_set_hold', { p_token: HOST2, p_enabled: true });
ok((await anon(db, 'site_status', {})).data.open === false, 're-enabling hold locks again');
// harter Hold: niemand ausser dem Commander kann etwas tun
errIs(await anon(db, 'account_register', { p_username: 'NewGuy', p_password: 'abcd1' }), 'SITE_ON_HOLD', 'hold: no registration');
r = await anon(db, 'account_login', { p_username: 'RushB', p_password: 'neu1234' });
ok(r.data.ok === false && r.data.error === 'SITE_ON_HOLD', 'hold: players cannot log in', r.data);
r = await anon(db, 'account_login', { p_username: 'havoc', p_password: 'Commander-Test-2026' });
ok(r.data.ok === true, 'hold: commander can log in');
const holdGame = (await anon(db, 'host_create_game', { p_token: HOST2 })).data.game;
errIs(await anon(db, 'join_game', { p_code: holdGame.code, p_callsign: 'Guest' }), 'SITE_ON_HOLD', 'hold: guests cannot join quiz');
errIs(await anon(db, 'join_game_account', { p_token: HANS }), 'SITE_ON_HOLD', 'hold: accounts cannot join quiz');
errIs(await anon(db, 'join_game_account', { p_token: r.data.token }), 'COMMANDER_NO_QUIZ', 'commander (MISSION CONTROL) cannot join the quiz as player');
await anon(db, 'host_reset_game', { p_token: HOST2, p_game_id: holdGame.id });
await anon(db, 'ops_release', { p_token: HOST2 });
const g3 = (await anon(db, 'host_create_game', { p_token: HOST2 })).data.game;
errIs(await anon(db, 'join_game', { p_code: g3.code, p_callsign: 'Havoc' }), 'CALLSIGN_TAKEN', 'callsign havoc reserved for guests');
await anon(db, 'host_reset_game', { p_token: HOST2, p_game_id: g3.id });
await anon(db, 'ops_set_hold', { p_token: HOST2, p_enabled: true });
ok((await anon(db, 'site_status', {})).data.total === 3, 'hold count excludes commander');
await anon(db, 'ops_release', { p_token: HOST2 });
ok((await anon(db, 'site_status', {})).data.open === true, 'commander can release manually');
r = await anon(db, 'account_me', { p_token: HANS });
ok(r.data.checked_in === true, 'account_me shows checked in');

// ---- Quiz mit Login ------------------------------------------------------------------
errIs(await anon(db, 'join_game_account', { p_token: HANS, p_code: null }), 'NO_ACTIVE_MISSION', 'no mission yet');
const game = (await anon(db, 'host_create_game', { p_token: HOST2 })).data.game;
r = await anon(db, 'join_game', { p_code: game.code, p_callsign: 'awp_gott' }); // Gast blockiert den Namen
r = await anon(db, 'join_game_account', { p_token: HANS, p_code: null });
ok(r.data && r.data.callsign === 'HeadshotHans' && r.data.code === game.code, 'account joins active lobby without code', r);
const P1 = r.data;
r = await anon(db, 'join_game_account', { p_token: HANS, p_code: game.code });
ok(r.data.player_id === P1.player_id && r.data.player_token !== P1.player_token, 'second device: same player, own token');
ok((await anon(db, 'get_player_state', { p_player_id: P1.player_id, p_token: P1.player_token })).data && (await anon(db, 'get_player_state', { p_player_id: P1.player_id, p_token: r.data.player_token })).data, 'both device tokens valid');
const AWP = (await anon(db, 'account_login', { p_username: 'AWP_Gott', p_password: 'awp123' })).data.token;
errIs(await anon(db, 'join_game_account', { p_token: AWP }), 'CALLSIGN_TAKEN', 'username already used by a guest callsign');
r = await anon(db, 'account_me', { p_token: HANS });
ok(r.data.quiz && r.data.quiz.code === game.code && r.data.quiz.joined === true, 'profile shows quiz mission + joined', r.data.quiz);
await anon(db, 'host_advance', { p_token: HOST2, p_game_id: game.id, p_expected_status: 'lobby', p_expected_question: 0 });
const RB = (await anon(db, 'account_login', { p_username: 'RushB', p_password: 'neu1234' })).data.token;
errIs(await anon(db, 'join_game_account', { p_token: RB }), 'NO_ACTIVE_MISSION', 'after start: new account finds no open lobby');
errIs(await anon(db, 'join_game_account', { p_token: RB, p_code: game.code }), 'MISSION_ALREADY_STARTED', 'after start: new account blocked');
r = await anon(db, 'join_game_account', { p_token: HANS });
ok(r.data && r.data.player_id === P1.player_id, 'after start: existing account can rejoin');

// ---- CS-Stats ------------------------------------------------------------------------
await anon(db, 'counter_set_team', { p_token: HOST2, p_name: 'Squad', p_roster: ['headshothans', 'RushB', '', '', ''] });
r = await anon(db, 'counter_add_match', { p_token: HOST2, p_result: null, p_map: 'Mirage', p_score_us: 13, p_score_them: 8 });
const M1 = r.data.matches[0].id;
await anon(db, 'counter_add_match', { p_token: HOST2, p_result: 'L', p_map: null, p_score_us: null, p_score_them: null });
r = await anon(db, 'account_me', { p_token: HANS });
ok(r.data.team.in_roster === true && r.data.team.pending_stats === 2, 'roster member has 2 pending stats', r.data.team);
const submit = (tok, m, k, d, a, hs, adr, mvp) => anon(db, 'counter_submit_stats', { p_token: tok, p_match_id: m, p_kills: k, p_deaths: d, p_assists: a, p_hs_pct: hs, p_adr: adr, p_mvps: mvp });
r = await submit(HANS, M1, 24, 15, 4, 54, 102, 5);
const st = r.data.stats.find((x) => x.match_id === M1 && x.player === 'HeadshotHans');
ok(st && st.kills === 24 && st.hs === 54 && st.adr === 102 && st.mvps === 5, 'player submits own stats', r.data.stats);
r = await submit(HANS, M1, 25, 15, 4, 56, 104, 5);
ok(r.data.stats.filter((x) => x.match_id === M1 && x.player === 'HeadshotHans').length === 1 && r.data.stats.find((x) => x.player === 'HeadshotHans').kills === 25, 'resubmit updates own row');
errIs(await submit(AWP, M1, 30, 5, 2, 60, 150, 8), 'NOT_IN_TEAM', 'non-roster account cannot submit');
errIs(await submit(HANS, M1, 24, 15, 4, 101, 102, 5), 'STATS_INVALID', 'HS% > 100 rejected');
errIs(await submit(HANS, M1, -1, 15, 4, 50, 102, 5), 'STATS_INVALID', 'negative kills rejected');
errIs(await submit(HANS, 999999, 1, 1, 1, 1, 1, 0), 'NOT_FOUND', 'unknown match');
errIs(await submit('forged', M1, 1, 1, 1, 1, 1, 0), 'ACCOUNT_UNAUTHORIZED', 'stats need login');
r = await anon(db, 'account_me', { p_token: HANS });
ok(r.data.team.pending_stats === 1 && r.data.team.totals.kills === 25 && r.data.team.totals.matches === 1, 'profile totals + pending', r.data.team);
r = await anon(db, 'ops_state', { p_token: HOST2 });
const hansOps = r.data.accounts.find((a) => a.username === 'HeadshotHans');
ok(hansOps.in_roster && hansOps.in_quiz && hansOps.pending_stats === 1 && hansOps.checked_in, 'ops_state flags', hansOps);
ok(r.data.quiz && r.data.quiz.code === game.code && r.data.quiz.player_count === 2, 'ops_state quiz summary', r.data.quiz);
await anon(db, 'counter_delete_match', { p_token: HOST2, p_id: M1 });
ok((await anon(db, 'counter_state', {})).data.stats.length === 0, 'deleting a match removes its stats');

r = await anon(db, 'ops_checkin_all', { p_token: HOST2, p_checked: true });
ok(r.data.accounts.every((x) => x.checked_in), 'ALLE EINCHECKEN');
r = await anon(db, 'ops_checkin_all', { p_token: HOST2, p_checked: false });
ok(r.data.accounts.every((x) => x.commander ? x.checked_in : !x.checked_in), 'ALLE AUSCHECKEN (commander stays on site)');
errIs(await anon(db, 'ops_checkin_all', { p_token: HANS, p_checked: true }), 'HOST_UNAUTHORIZED', 'checkin_all needs commander');

errIs(await anon(db, 'ops_delete_account', { p_token: HOST2, p_account_id: (await anon(db, 'ops_state', { p_token: HOST2 })).data.accounts.find((a) => a.commander).id }), 'COMMANDER_ACCOUNT', 'commander account cannot be deleted');

// ---- Account löschen -------------------------------------------------------------------
await anon(db, 'ops_delete_account', { p_token: HOST2, p_account_id: ids.AWP_Gott });
errIs(await anon(db, 'account_me', { p_token: AWP }), 'ACCOUNT_UNAUTHORIZED', 'deleted account session invalid');
ok((await anon(db, 'accounts_public', {})).data.length === 3, 'account removed from list');


// ---- Neue Einrichtung: Hold-Screen ist standardmässig AKTIV ------------------------------
{
  const { createDb: create2, anon: anon2 } = await import('./pg-harness.mjs');
  const fresh = await create2({ keepHold: true });
  await fresh.query(`select public.set_commander_password('Commander-Test-2026')`);
  const st = (await anon2(fresh, 'site_status', {})).data;
  const reg = await anon2(fresh, 'account_register', { p_username: 'Early', p_password: 'abcd1' });
  const cmd = await anon2(fresh, 'account_login', { p_username: 'havoc', p_password: 'Commander-Test-2026' });
  const ok2 = st.hold_enabled === true && st.open === false && reg.error?.message === 'SITE_ON_HOLD' && cmd.data.ok;
  console.log(ok2 ? '' : 'FAIL: fresh install: hold active by default', JSON.stringify({ st, reg, cmd: cmd.data }));
  if (!ok2) process.exit(1);
}
console.log(`\nACCOUNTS SQL TESTS: ${pass + 1} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
