// Testet supabase/schema.sql mit PGlite (echtes PostgreSQL als WebAssembly)
import { createDb, anon } from './pg-harness.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; } else { fail++; console.log('FAIL:', label, extra !== undefined ? JSON.stringify(extra) : ''); }
};
const errIs = (res, code, label) => ok(res.error && res.error.message.includes(code), label, res);

const db = await createDb();
const su = async (q, p) => (await db.query(q, p)).rows;

// ---- Server time (clock sync) -------------------------------------------------
let st0 = await anon(db, 'server_time', {});
ok(st0.error === null && Math.abs(Number(st0.data) - Date.now()) < 5000, 'anon can call server_time', st0);

// ---- Commander password ----------------------------------------------------
let r = await anon(db, 'set_commander_password', { p_password: 'hackerpass123' });
errIs(r, 'permission denied', 'anon cannot set commander password');
r = await anon(db, 'host_login', { p_password: 'whatever' });
ok(r.data && r.data.error === 'COMMANDER_PASSWORD_NOT_SET', 'login before password set', r);
await db.query(`select public.set_commander_password('Geheim-LAN-2026')`);
let threw = false;
try { await db.query(`select public.set_commander_password('DEIN-GEHEIMES-PASSWORT')`); } catch { threw = true; }
ok(threw, 'placeholder password rejected');

r = await anon(db, 'host_login', { p_password: 'falsch' });
ok(r.data && r.data.ok === false && r.data.error === 'LOGIN_FAILED', 'wrong password', r);
ok((await su('select count(*)::int c from login_attempts where not success'))[0].c === 1, 'failed attempt persisted');
r = await anon(db, 'host_login', { p_password: 'Geheim-LAN-2026' });
ok(r.data && r.data.ok && r.data.token.length === 64, 'right password gives token', r);
const HOST = r.data.token;

// ---- Direct table access as anon -------------------------------------------
async function anonSql(q) {
  await db.exec('set role anon');
  try { return { rows: (await db.query(q)).rows }; } catch (e) { return { error: e.message }; } finally { await db.exec('reset role'); }
}
ok((await anonSql('select * from questions')).error?.includes('permission denied'), 'anon cannot read questions');
ok((await anonSql('select correct_option from questions')).error?.includes('permission denied'), 'anon cannot read correct_option');
ok((await anonSql('select * from answers')).error?.includes('permission denied'), 'anon cannot read answers');
ok((await anonSql('select * from player_tokens')).error?.includes('permission denied'), 'anon cannot read player tokens');
ok((await anonSql('select * from host_sessions')).error?.includes('permission denied'), 'anon cannot read host sessions');
ok((await anonSql('select * from commander_config')).error?.includes('permission denied'), 'anon cannot read commander config');
ok((await anonSql('select * from games')).rows !== undefined, 'anon can read games');
ok((await anonSql("insert into games(code,duration_s,base_points,bonus_per_second,lead_in_ms,grace_ms,max_players) values ('123456',20,100,5,0,0,10)")).error?.includes('permission denied'), 'anon cannot insert games');
ok((await anonSql("update players set score = 99999")).error?.includes('permission denied'), 'anon cannot update players');
ok((await anonSql("delete from players")).error?.includes('permission denied'), 'anon cannot delete players');
errIs(await anon(db, '_host_state', { p_game_id: '00000000-0000-0000-0000-000000000000' }), 'permission denied', 'anon cannot call internal _host_state');
errIs(await anon(db, '_start_question', { p_game_id: '00000000-0000-0000-0000-000000000000', p_index: 1 }), 'permission denied', 'anon cannot call _start_question');

// ---- Host auth on host functions -------------------------------------------
errIs(await anon(db, 'host_create_game', { p_token: 'nope' }), 'HOST_UNAUTHORIZED', 'create game needs host');
errIs(await anon(db, 'host_create_game', { p_token: null }), 'HOST_UNAUTHORIZED', 'create game null token');

// ---- Create game -------------------------------------------------------------
r = await anon(db, 'host_create_game', { p_token: HOST });
ok(r.data && /^[1-9]\d{5}$/.test(r.data.game.code), 'game created with 6-digit code', r);
const GAME = r.data.game; const CODE = GAME.code;
ok(GAME.status === 'lobby' && GAME.total_questions === 20 && GAME.max_score === 3900, 'game defaults (max 3900)', GAME);
r = await anon(db, 'host_create_game', { p_token: HOST });
ok(r.data.game.id === GAME.id, 'double-click create returns same empty game');

errIs(await anon(db, 'host_advance', { p_token: HOST, p_game_id: GAME.id, p_expected_status: 'lobby', p_expected_question: 0 }), 'NO_PLAYERS', 'cannot start without players');

// ---- Join validation ---------------------------------------------------------
errIs(await anon(db, 'join_game', { p_code: '12ab', p_callsign: 'RushB' }), 'MISSION_CODE_INVALID', 'invalid code format');
errIs(await anon(db, 'join_game', { p_code: CODE === '999999' ? '999998' : '999999', p_callsign: 'RushB' }), 'MISSION_NOT_FOUND', 'unknown mission');
errIs(await anon(db, 'join_game', { p_code: CODE, p_callsign: ' x ' }), 'CALLSIGN_LENGTH', 'too short');
errIs(await anon(db, 'join_game', { p_code: CODE, p_callsign: '' }), 'CALLSIGN_LENGTH', 'empty');
errIs(await anon(db, 'join_game', { p_code: CODE, p_callsign: 'A'.repeat(25) }), 'CALLSIGN_LENGTH', 'too long');
errIs(await anon(db, 'join_game', { p_code: CODE, p_callsign: '<b>x</b>' }), 'CALLSIGN_CHARS', 'html rejected');
errIs(await anon(db, 'join_game', { p_code: CODE, p_callsign: 'Rush​B' }), 'CALLSIGN_CHARS', 'zero-width rejected');
r = await anon(db, 'join_game', { p_code: CODE, p_callsign: 'Tab\tName' });
ok(r.data && r.data.callsign === 'Tab Name', 'tab normalised to space', r);
await anon(db, 'leave_game', { p_player_id: r.data.player_id, p_token: r.data.player_token });
r = await anon(db, 'join_game', { p_code: ` ${CODE} `, p_callsign: '  RushB  ' });
ok(r.data && r.data.callsign === 'RushB', 'join trims', r);
const RUSHB = r.data;
errIs(await anon(db, 'join_game', { p_code: CODE, p_callsign: 'rushb' }), 'CALLSIGN_TAKEN', 'case-insensitive duplicate');
errIs(await anon(db, 'join_game', { p_code: CODE, p_callsign: 'ＲｕｓｈＢ' }), 'CALLSIGN_TAKEN', 'fullwidth NFKC duplicate');
r = await anon(db, 'join_game', { p_code: CODE, p_callsign: 'Ä&"\'Ü  Ninja' });
ok(r.data && r.data.callsign === 'Ä&"\'Ü Ninja', 'special chars ok, spaces collapsed', r);
const SPECIAL = r.data;
// leave + kick
r = await anon(db, 'leave_game', { p_player_id: SPECIAL.player_id, p_token: SPECIAL.player_token });
ok(r.data && r.data.ok, 'leave lobby', r);
r = await anon(db, 'host_remove_player', { p_token: HOST, p_player_id: RUSHB.player_id });
ok(r.data && r.data.player_count === 0, 'host kicks player', r);
errIs(await anon(db, 'get_player_state', { p_player_id: RUSHB.player_id, p_token: RUSHB.player_token, p_touch: true }), 'PLAYER_NOT_FOUND', 'kicked player state');

// ---- 10 players ---------------------------------------------------------------
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett'];
const P = [];
for (const n of NAMES) {
  r = await anon(db, 'join_game', { p_code: CODE, p_callsign: n });
  ok(r.data, 'join ' + n, r);
  P.push(r.data);
}
r = await anon(db, 'host_get_state', { p_token: HOST, p_game_id: GAME.id });
ok(r.data.player_count === 10 && r.data.players.length === 10, 'host sees 10 players', r.data.player_count);
ok(r.data.next_action === 'start', 'next action start');
r = await anon(db, 'get_player_state', { p_player_id: P[0].player_id, p_token: P[0].player_token, p_touch: true });
ok(r.data.players.length === 10 && r.data.players.find((p) => p.is_me).callsign === 'Alpha', 'player sees lobby', r.data);
ok(!JSON.stringify(r.data).includes('token'), 'player state contains no tokens');
errIs(await anon(db, 'get_player_state', { p_player_id: P[0].player_id, p_token: P[1].player_token }), 'PLAYER_NOT_FOUND', 'foreign token rejected');

// ---- Start ------------------------------------------------------------------
r = await anon(db, 'host_advance', { p_token: HOST, p_game_id: GAME.id, p_expected_status: 'lobby', p_expected_question: 0 });
ok(r.data.changed === true && r.data.game.status === 'question' && r.data.game.current_question === 1, 'mission started', r.data.game);
ok(r.data.correct_option === null, 'host does not get correct option during question');
ok(r.data.game.started_at_ms - r.data.game.server_now_ms > 2500, 'lead-in present');
r = await anon(db, 'host_advance', { p_token: HOST, p_game_id: GAME.id, p_expected_status: 'lobby', p_expected_question: 0 });
ok(r.data.changed === false && r.data.game.current_question === 1, 'double start ignored');
errIs(await anon(db, 'join_game', { p_code: CODE, p_callsign: 'LateGuy' }), 'MISSION_ALREADY_STARTED', 'late join blocked');

errIs(await anon(db, 'submit_answer', { p_player_id: P[0].player_id, p_token: P[0].player_token, p_question_index: 1, p_option: 'B' }), 'QUESTION_NOT_STARTED', 'no answer during lead-in');

// Player state during question: no correct option anywhere
r = await anon(db, 'get_player_state', { p_player_id: P[0].player_id, p_token: P[0].player_token });
ok(r.data.question && r.data.question.text.startsWith('Welche Waffe') && r.data.correct_option === null, 'player question without solution', r.data);
ok(!JSON.stringify(r.data).includes('correct_option":"'), 'no correct option leaked');

// fast-forward: question started 4.3s ago -> 15.7 s remaining -> 15 full seconds -> 175 pts
async function shiftStart(gameId, secondsAgo) {
  await su(`update games set question_started_at = clock_timestamp() - make_interval(secs => $2),
                             question_ends_at = clock_timestamp() - make_interval(secs => $2) + make_interval(secs => duration_s)
            where id = $1`, [gameId, secondsAgo]);
}
await shiftStart(GAME.id, 4.3);

// Q1 correct = B. 8 correct, 2 wrong
for (let i = 0; i < 10; i++) {
  const opt = i < 8 ? 'B' : 'A';
  r = await anon(db, 'submit_answer', { p_player_id: P[i].player_id, p_token: P[i].player_token, p_question_index: 1, p_option: opt });
  ok(r.data && r.data.status === 'LOCKED' && r.data.is_correct === undefined && r.data.points === undefined, 'submit locked w/o result ' + i, r);
}
// duplicates
r = await anon(db, 'submit_answer', { p_player_id: P[9].player_id, p_token: P[9].player_token, p_question_index: 1, p_option: 'B' });
ok(r.data.status === 'ALREADY_LOCKED' && r.data.selected_option === 'A', 'second answer refused, original kept', r);
ok((await su('select count(*)::int c from answers'))[0].c === 10, 'exactly 10 answers stored');
errIs(await anon(db, 'submit_answer', { p_player_id: P[0].player_id, p_token: P[0].player_token, p_question_index: 2, p_option: 'B' }), 'QUESTION_NOT_ACTIVE', 'answer for future question');
errIs(await anon(db, 'submit_answer', { p_player_id: P[0].player_id, p_token: 'forged', p_question_index: 1, p_option: 'B' }), 'PLAYER_NOT_FOUND', 'forged token');
errIs(await anon(db, 'submit_answer', { p_player_id: P[0].player_id, p_token: P[0].player_token, p_question_index: 1, p_option: 'E' }), 'OPTION_INVALID', 'invalid option');

const pts = await su(`select p.callsign, a.points, a.is_correct, a.response_time_ms from answers a join players p on p.id=a.player_id order by p.joined_at`);
ok(pts.slice(0, 8).every((x) => x.points === 175 && x.is_correct), '8 x 175 points', pts);
ok(pts.slice(8).every((x) => x.points === 0 && !x.is_correct), '2 x 0 points', pts);
ok(pts.every((x) => x.response_time_ms >= 4300 && x.response_time_ms < 6000), 'response time measured', pts.map((x) => x.response_time_ms));

r = await anon(db, 'host_get_state', { p_token: HOST, p_game_id: GAME.id });
ok(r.data.answers_count === 10 && r.data.all_answered === true && r.data.next_action === 'reveal', 'host sees all answered', r.data);
ok(r.data.players.every((p) => p.score === 0), 'scores not visible before reveal');
r = await anon(db, 'get_player_state', { p_player_id: P[0].player_id, p_token: P[0].player_token });
ok(r.data.answer && r.data.answer.selected_option === 'B' && r.data.answer.is_correct === undefined, 'player sees locked answer only', r.data.answer);

// reveal
r = await anon(db, 'host_advance', { p_token: HOST, p_game_id: GAME.id, p_expected_status: 'question', p_expected_question: 1 });
ok(r.data.changed && r.data.game.status === 'results' && r.data.correct_option === 'B', 'reveal', r.data);
ok(r.data.distribution.B === 8 && r.data.distribution.A === 2, 'distribution', r.data.distribution);
r = await anon(db, 'host_advance', { p_token: HOST, p_game_id: GAME.id, p_expected_status: 'question', p_expected_question: 1 });
ok(r.data.changed === false, 'double reveal ignored');
ok(r.data.players.filter((p) => p.score === 175).length === 8, 'scores applied once', r.data.players.map((p) => p.score));
r = await anon(db, 'get_player_state', { p_player_id: P[0].player_id, p_token: P[0].player_token });
ok(r.data.answer.is_correct === true && r.data.answer.points === 175 && r.data.correct_option === 'B' && r.data.me.score === 175 && r.data.me.position === 1, 'player feedback correct', r.data);
r = await anon(db, 'get_player_state', { p_player_id: P[9].player_id, p_token: P[9].player_token });
ok(r.data.answer.is_correct === false && r.data.answer.points === 0 && r.data.me.position === 9, 'player feedback wrong', r.data);
errIs(await anon(db, 'submit_answer', { p_player_id: P[0].player_id, p_token: P[0].player_token, p_question_index: 1, p_option: 'B' }), 'QUESTION_NOT_ACTIVE', 'no answer after reveal');

// ---- Q2: deadline edge cases ---------------------------------------------------
r = await anon(db, 'host_advance', { p_token: HOST, p_game_id: GAME.id, p_expected_status: 'results', p_expected_question: 1 });
ok(r.data.game.current_question === 2 && r.data.next_action === 'reveal', 'next question 2', r.data.game);
// 19.5 s after start (0.5 s left): correct -> 100 + 0
await shiftStart(GAME.id, 19.5);
r = await anon(db, 'submit_answer', { p_player_id: P[0].player_id, p_token: P[0].player_token, p_question_index: 2, p_option: 'C' });
ok(r.data.status === 'LOCKED', 'answer at 0.5 s left accepted');
// 20.5 s after start (0.5 s past deadline, inside 750 ms grace)
await shiftStart(GAME.id, 20.5);
r = await anon(db, 'submit_answer', { p_player_id: P[1].player_id, p_token: P[1].player_token, p_question_index: 2, p_option: 'C' });
ok(r.data && r.data.status === 'LOCKED', 'answer within grace accepted', r);
// 22 s after start -> expired
await shiftStart(GAME.id, 22);
errIs(await anon(db, 'submit_answer', { p_player_id: P[2].player_id, p_token: P[2].player_token, p_question_index: 2, p_option: 'C' }), 'TIME_EXPIRED', 'answer after deadline');
const q2 = await su(`select points from answers where question_index = 2 order by created_at`);
ok(q2[0].points === 100 && q2[1].points === 100, 'deadline bonus 0', q2);
// very fast answer: 0.05 s after start -> capped at 19 s bonus -> 195
r = await anon(db, 'host_advance', { p_token: HOST, p_game_id: GAME.id, p_expected_status: 'question', p_expected_question: 2 });
r = await anon(db, 'host_advance', { p_token: HOST, p_game_id: GAME.id, p_expected_status: 'results', p_expected_question: 2 });
await shiftStart(GAME.id, 0.05);
r = await anon(db, 'submit_answer', { p_player_id: P[0].player_id, p_token: P[0].player_token, p_question_index: 3, p_option: 'A' });
ok((await su(`select points from answers where question_index = 3`))[0].points === 195, 'max 195 per question');
// close answers early
await shiftStart(GAME.id, 3);
r = await anon(db, 'host_close_answers', { p_token: HOST, p_game_id: GAME.id, p_question_index: 3 });
ok(r.data.game.ends_at_ms <= r.data.game.server_now_ms, 'close answers moves deadline', r.data.game);
await su(`update games set question_ends_at = question_ends_at - interval '2 seconds' where id = $1`, [GAME.id]);
errIs(await anon(db, 'submit_answer', { p_player_id: P[1].player_id, p_token: P[1].player_token, p_question_index: 3, p_option: 'A' }), 'TIME_EXPIRED', 'closed question rejects');

// ---- Play to the end ------------------------------------------------------------
const correct = Object.fromEntries((await su('select question_index, correct_option from questions')).map((x) => [x.question_index, x.correct_option]));
let st = (await anon(db, 'host_get_state', { p_token: HOST, p_game_id: GAME.id })).data;
let sawPhaseBreak = false;
let guard = 0;
while (st.game.status !== 'finished' && guard++ < 100) {
  const g = st.game;
  if (g.status === 'question') {
    await shiftStart(GAME.id, 2.2); // 17 full seconds left -> 185
    for (let i = 0; i < 10; i++) {
      const opt = i === 0 ? correct[g.current_question] : (i % 2 ? correct[g.current_question] : 'D' === correct[g.current_question] ? 'A' : 'D');
      await anon(db, 'submit_answer', { p_player_id: P[i].player_id, p_token: P[i].player_token, p_question_index: g.current_question, p_option: opt });
    }
  }
  if (g.status === 'phase_break') { sawPhaseBreak = true; ok(g.current_question === 10, 'phase break after Q10', g); }
  if (g.status === 'results' && g.current_question === 10) ok(st.next_action === 'phase_break', 'Q10 -> phase break action', st.next_action);
  if (g.status === 'results' && g.current_question === 20) ok(st.next_action === 'final', 'Q20 -> final action', st.next_action);
  if (g.status === 'question' && g.current_question === 11) ok(g.phase === 2 && g.phase_first === 11 && g.phase_last === 20, 'phase II meta', g);
  const r2 = await anon(db, 'host_advance', { p_token: HOST, p_game_id: GAME.id, p_expected_status: g.status, p_expected_question: g.current_question });
  ok(r2.data, 'advance from ' + g.status + ' ' + g.current_question, r2);
  st = r2.data;
}
ok(sawPhaseBreak, 'phase break happened');
ok(st.game.status === 'finished' && st.next_action === 'none', 'game finished', st.game);
const final = await su(`select p.callsign, p.score, (select coalesce(sum(points),0)::int from answers a where a.player_id = p.id) as sum from players p where game_id = $1 order by score desc`, [GAME.id]);
ok(final.every((f) => f.score === f.sum), 'score == sum of answer points', final);
ok(final[0].callsign === 'Alpha', 'Alpha wins', final[0]);
console.log('final top3:', final.slice(0, 3));
errIs(await anon(db, 'host_advance', { p_token: HOST, p_game_id: GAME.id, p_expected_status: 'finished', p_expected_question: 20 }), 'MISSION_CLOSED', 'no advance after finish');
r = await anon(db, 'get_player_state', { p_player_id: P[0].player_id, p_token: P[0].player_token });
ok(r.data.game.status === 'finished' && r.data.me.position === 1, 'player sees final', r.data.me);

// ---- New mission, reset ------------------------------------------------------
r = await anon(db, 'host_create_game', { p_token: HOST });
ok(r.data.game.id !== GAME.id && r.data.game.code !== CODE, 'new mission with new code');
const G2 = r.data.game;
r = await anon(db, 'host_session_info', { p_token: HOST });
ok(r.data.valid && r.data.active_game.id === G2.id, 'session info returns active game', r.data);
r = await anon(db, 'host_reset_game', { p_token: HOST, p_game_id: G2.id });
ok(r.data.game.status === 'aborted', 'reset aborts');
errIs(await anon(db, 'join_game', { p_code: G2.code, p_callsign: 'Alpha' }), 'MISSION_CLOSED', 'join aborted mission');
r = await anon(db, 'host_session_info', { p_token: HOST });
ok(r.data.active_game === null, 'no active game after reset', r.data);

// ---- Logout + brute force lock -----------------------------------------------------
r = await anon(db, 'host_logout', { p_token: HOST });
errIs(await anon(db, 'host_get_state', { p_token: HOST, p_game_id: G2.id }), 'HOST_UNAUTHORIZED', 'logged out token invalid');
for (let i = 0; i < 15; i++) await anon(db, 'host_login', { p_password: 'wrong' + i });
r = await anon(db, 'host_login', { p_password: 'Geheim-LAN-2026' });
ok(r.data.ok === false && r.data.error === 'LOGIN_LOCKED', 'brute force lock', r.data);

// ---- Realtime publication ----------------------------------------------------------
const pub = await su(`select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1`);
ok(pub.map((x) => x.tablename).join(',') === 'games,players', 'realtime publication', pub);

console.log(`\nSQL TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
