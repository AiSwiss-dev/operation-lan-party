// =====================================================================
//  SPIELER-SEITE (index.html)
// =====================================================================

import { configStatus, rpc, watchGame } from './supabase-client.js';
import {
  h, mount, storage, errorText, onlyDigits, cleanCallsign, callsignProblem,
  confirmDialog, toast, vibrate, formatPoints, withPositions,
} from './utils.js';
import { serverNow, syncClock, keepClockSynced, roughSync } from './clock.js';
import { createSync } from './sync.js';
import { initAudio, sfx, bindSoundToggle, updateSoundscape, tracks, bombTrackActive, updateUnlockHint } from './audio.js';
import { setNetBanner, setLinkLed, renderConfigError, createCountdown, progressBar, coordLine, stamp } from './ui.js';
import { TEXT, phaseInfo, rankFor, SOUND_SETUP } from './questions.js';

const app = document.getElementById('app');
const srStatus = document.getElementById('sr-status');
const LAST_KEY = 'olp.player.last';
const sessionKey = (code) => `olp.player.${code}`;
const OPTIONS = ['A', 'B', 'C', 'D'];

let session = null;      // { code, gameId, playerId, token, callsign }
let sync = null;
let unwatch = null;
let state = null;        // letzter Serverzustand
let firstFetch = true;
let screenKey = '';
let ui = {};             // Referenzen des aktuellen Screens
let selected = null;     // { q, option } – gewählt, noch nicht bestätigt
let submitting = false;
let localLock = null;    // { q, option } – nach erfolgreichem Submit
let localExpired = null; // Frage, bei der der Server TIME_EXPIRED gemeldet hat
const played = { feedback: null, start: null, final: false, tick: null, expired: null };

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------
function init() {
  initAudio();
  const toggle = document.getElementById('sound-toggle');
  if (toggle) bindSoundToggle(toggle);

  if (!configStatus.ok) {
    renderConfigError(app, configStatus);
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const paramCode = onlyDigits(params.get('game'));
  let saved = null;
  if (paramCode.length === 6) {
    saved = storage.get(sessionKey(paramCode));
  } else {
    const last = storage.get(LAST_KEY);
    if (last) saved = storage.get(sessionKey(last));
  }

  if (saved && saved.playerId && saved.token && saved.gameId) startSession(saved);
  else renderJoin({ code: paramCode });

  if (SOUND_SETUP.player.music) tracks.music.preload();
  if (SOUND_SETUP.player.bomb) tracks.bomb.preload();
  setInterval(tick, 200);
}

function announce(text) {
  if (srStatus) srStatus.textContent = text;
}

function focusTitle() {
  const title = app.querySelector('h1');
  if (title) {
    title.setAttribute('tabindex', '-1');
    try { title.focus({ preventScroll: true }); } catch { /* egal */ }
  }
}

// ---------------------------------------------------------------------
// Beitritt
// ---------------------------------------------------------------------
function renderJoin({ code = '', callsign = '', error = '' } = {}) {
  screenKey = 'join';
  setLinkLed('');
  const codeInput = h('input', {
    id: 'mission-code', name: 'code', class: 'input input--code', inputmode: 'numeric',
    autocomplete: 'off', maxlength: '6', pattern: '[0-9]{6}', placeholder: '000000',
    'aria-describedby': 'join-error', value: code, required: true,
  });
  const callsignInput = h('input', {
    id: 'callsign', name: 'callsign', class: 'input', maxlength: '24', autocomplete: 'nickname',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'z. B. HeadshotHans',
    'aria-describedby': 'join-error callsign-hint', value: callsign, required: true,
  });
  const errorBox = h('p', { id: 'join-error', class: 'form-error', role: 'alert', text: error });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'MISSION BEITRETEN');

  codeInput.addEventListener('input', () => { codeInput.value = onlyDigits(codeInput.value); });

  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' },
      h('label', { for: 'mission-code', class: 'field__label' }, 'MISSION CODE'),
      codeInput),
    h('div', { class: 'field' },
      h('label', { for: 'callsign', class: 'field__label' }, 'CALLSIGN'),
      callsignInput,
      h('p', { id: 'callsign-hint', class: 'field__hint', text: '2–24 Zeichen. Wird für alle sichtbar angezeigt.' })),
    errorBox,
    submit);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const c = onlyDigits(codeInput.value);
    const name = cleanCallsign(callsignInput.value);
    errorBox.textContent = '';
    if (c.length !== 6) { errorBox.textContent = errorText('MISSION_CODE_INVALID'); codeInput.focus(); return; }
    const problem = callsignProblem(name);
    if (problem) { errorBox.textContent = errorText(problem); callsignInput.focus(); return; }

    submit.disabled = true;
    submit.textContent = 'VERBINDE MIT HQ…';
    try {
      const res = await rpc('join_game', { p_code: c, p_callsign: name });
      const s = { code: res.code, gameId: res.game_id, playerId: res.player_id, token: res.player_token, callsign: res.callsign };
      storage.set(sessionKey(s.code), s);
      storage.set(LAST_KEY, s.code);
      sfx.lock();
      startSession(s);
    } catch (e) {
      errorBox.textContent = errorText(e.code);
      submit.disabled = false;
      submit.textContent = 'MISSION BEITRETEN';
      if (e.code === 'CALLSIGN_TAKEN' || e.code === 'CALLSIGN_LENGTH' || e.code === 'CALLSIGN_CHARS') callsignInput.focus();
      else if (e.code === 'MISSION_NOT_FOUND' || e.code === 'MISSION_CODE_INVALID') codeInput.focus();
    }
  });

  mount(app,
    h('section', { class: 'card card--briefing' },
      stamp('CLASSIFIED'),
      h('p', { class: 'eyebrow', text: TEXT.org }),
      h('h1', { class: 'title title--xl' }, 'OPERATION', h('br'), 'LAN-PARTY'),
      h('p', { class: 'subtitle', text: TEXT.subtitle }),
      h('div', { class: 'stripes', 'aria-hidden': 'true' }),
      h('p', { class: 'meta', text: `${TEXT.eventDate} // ${TEXT.eventTime} UHR // COMMANDER ${TEXT.commander}` }),
      form,
      coordLine('BRIEFING ROOM')));
  announce('Mission beitreten');
}

// ---------------------------------------------------------------------
// Session / Synchronisation
// ---------------------------------------------------------------------
function startSession(s) {
  session = s;
  state = null;
  firstFetch = true;
  screenKey = '';
  Object.assign(played, { feedback: null, start: null, final: false, tick: null, expired: null });
  if (onlyDigits(new URLSearchParams(window.location.search).get('game')) !== s.code) {
    try { window.history.replaceState(null, '', `?game=${s.code}`); } catch { /* egal */ }
  }
  mount(app, h('section', { class: 'card card--center' },
    h('p', { class: 'eyebrow', text: `MISSION ${s.code}` }),
    h('h1', { class: 'title title--md', text: 'VERBINDE MIT HQ…' }),
    h('div', { class: 'radar radar--sm', 'aria-hidden': 'true' })));

  syncClock();
  keepClockSynced();

  sync = createSync({
    fetchState: async () => {
      const touch = firstFetch;
      const res = await rpc('get_player_state', { p_player_id: s.playerId, p_token: s.token, p_touch: touch });
      firstFetch = false;
      return res;
    },
    onState,
    onError: (e) => {
      if (e.code === 'PLAYER_NOT_FOUND') {
        const code = session ? session.code : '';
        endSession();
        renderJoin({ code, error: errorText('PLAYER_NOT_FOUND') });
      } else if (e.code === 'SETUP' || e.code === 'CONFIG_KEY') {
        mount(app, h('section', { class: 'card card--alert', role: 'alert' },
          h('h1', { class: 'title title--md', text: errorText(e.code) })));
      }
    },
    onConnection: (ok) => setNetBanner(!ok),
    onLink: setLinkLed,
  });
  unwatch = watchGame(s.gameId, {
    onChange: () => sync && sync.realtimeEvent(),
    onLive: (live) => sync && sync.setSubscribed(live),
  });
  sync.refresh();
}

function endSession({ forget = true } = {}) {
  if (sync) sync.stop();
  if (unwatch) unwatch();
  sync = null;
  unwatch = null;
  if (forget && session) {
    storage.remove(sessionKey(session.code));
    if (storage.get(LAST_KEY) === session.code) storage.remove(LAST_KEY);
  }
  session = null;
  state = null;
  selected = null;
  localLock = null;
  localExpired = null;
  setNetBanner(false);
  updateSoundscape(null, 0, SOUND_SETUP.player);
}

function onState(next) {
  if (!session) return;
  if (state && next.game.state_version < state.game.state_version) return; // verspätete Antwort
  roughSync(next.game.server_now_ms);
  if (state && state.game.current_question !== next.game.current_question) {
    selected = null;
  }
  state = next;
  render();
}

// Antwort aus Serverzustand + lokalem Lock zusammenführen
function myAnswer() {
  if (!state) return null;
  if (state.answer) return state.answer;
  if (localLock && localLock.q === state.game.current_question) {
    return { question_index: localLock.q, selected_option: localLock.option };
  }
  return null;
}

function timePhase(game, now) {
  if (!game.started_at_ms || !game.ends_at_ms) return 'expired';
  if (now < game.started_at_ms) return 'lead';
  if (now < game.ends_at_ms) return 'open';
  return 'expired';
}

function computeKey(now) {
  const g = state.game;
  switch (g.status) {
    case 'lobby': return 'lobby';
    case 'question': {
      if (myAnswer()) return `locked:${g.current_question}`;
      if (localExpired === g.current_question) return `expired:${g.current_question}`;
      return `${timePhase(g, now)}:${g.current_question}`;
    }
    case 'results': return `results:${g.current_question}`;
    case 'phase_break': return 'phase_break';
    case 'finished': return 'finished';
    case 'aborted': return 'aborted';
    default: return 'unknown';
  }
}

function render() {
  if (!state || !session) return;
  const now = serverNow();
  const key = computeKey(now);
  if (key !== screenKey) {
    screenKey = key;
    ui = {};
    buildScreen(key.split(':')[0]);
    focusTitle();
  } else {
    patchScreen();
  }
  tick();
}

// alle 200 ms: Countdown, zeitabhängige Screenwechsel, Musik/Bombe
function tick() {
  updateSoundscape(state && session ? state.game : null, serverNow(), SOUND_SETUP.player);
  updateUnlockHint(!!(state && session) && (SOUND_SETUP.player.music || SOUND_SETUP.player.bomb));
  if (!state || !session) return;
  const now = serverNow();
  const key = computeKey(now);
  if (key !== screenKey) { render(); return; }
  const g = state.game;
  if (ui.countdown && g.status === 'question') {
    const { phase, secs } = ui.countdown.update(g, now);
    if (phase === 'open' && secs <= 5 && secs > 0 && played.tick !== `${g.current_question}:${secs}`) {
      played.tick = `${g.current_question}:${secs}`;
      if (!myAnswer() && !bombTrackActive(SOUND_SETUP.player)) sfx.tick();
    }
  }
}

// ---------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------
function hud() {
  const g = state.game;
  const p = phaseInfo(g.phase);
  return h('div', { class: 'hud' },
    h('span', { class: 'hud__item' }, h('b', { text: `FRAGE ${g.current_question}` }), `/${g.total_questions}`),
    h('span', { class: 'hud__item hud__item--phase', text: p.label }),
    h('span', { class: 'hud__item hud__item--score' }, h('b', { text: formatPoints(state.me.score) }), ' PTS'));
}

function rosterList(players) {
  return h('ul', { class: 'roster', 'aria-label': 'Operatoren in der Mission' },
    players.map((p) => h('li', { class: `roster__item${p.is_me ? ' is-me' : ''}` },
      h('span', { class: 'roster__dot', 'aria-hidden': 'true' }),
      h('span', { class: 'roster__name', text: p.callsign }),
      p.is_me ? h('span', { class: 'roster__tag', text: 'DU' }) : null)));
}

function buildScreen(kind) {
  const g = state.game;
  const builders = { lobby, lead, open, locked, expired, results, phase_break: phaseBreak, finished, aborted };
  (builders[kind] || unknown)(g);
}

function lobby(g) {
  ui.count = h('span', { class: 'count', text: String(state.players.length) });
  ui.roster = h('div', { class: 'roster-wrap' }, rosterList(state.players));
  const leave = h('button', { type: 'button', class: 'btn btn--ghost btn--small' }, 'MISSION VERLASSEN');
  leave.addEventListener('click', async () => {
    const yes = await confirmDialog({ title: 'MISSION VERLASSEN?', text: 'Dein Callsign wird aus der Lobby entfernt. Du kannst danach neu beitreten.', confirmLabel: 'VERLASSEN', danger: true });
    if (!yes || !session) return;
    try {
      await rpc('leave_game', { p_player_id: session.playerId, p_token: session.token });
    } catch (e) {
      if (e.code !== 'PLAYER_NOT_FOUND') { toast(errorText(e.code), 'error'); return; }
    }
    const code = session.code;
    endSession();
    renderJoin({ code });
  });

  mount(app,
    h('section', { class: 'card card--lobby' },
      h('div', { class: 'card__head' },
        h('p', { class: 'eyebrow' }, 'MISSION CODE: ', h('b', { class: 'mono', text: g.code })),
        stamp('STANDBY')),
      h('h1', { class: 'title title--lg', text: 'WAITING FOR COMMANDER' }),
      h('div', { class: 'radar', 'aria-hidden': 'true' }),
      h('dl', { class: 'facts' },
        h('div', {}, h('dt', { text: 'STATUS' }), h('dd', { class: 'status-ok' }, h('span', { class: 'led led--ok', 'aria-hidden': 'true' }), 'OPERATOR BEREIT')),
        h('div', {}, h('dt', { text: 'CALLSIGN' }), h('dd', { class: 'callsign', text: state.me.callsign }))),
      h('h2', { class: 'section-title' }, 'OPERATORS DEPLOYED ', ui.count),
      ui.roster,
      h('div', { class: 'card__foot' }, leave),
      coordLine('STAGING AREA')));
  announce('Lobby. Warte auf den Commander.');
}

function lead(g) {
  const p = phaseInfo(g.phase);
  const isPhaseStart = g.current_question === g.phase_first;
  ui.countdown = createCountdown({ size: 'lg' });
  if (played.start !== g.current_question) {
    played.start = g.current_question;
    if (isPhaseStart) sfx.missionStart();
  }
  mount(app,
    h('section', { class: 'card card--center card--lead' },
      hud(),
      progressBar(g),
      h('p', { class: 'eyebrow', text: `${p.label} // ${p.name}` }),
      h('h1', { class: 'title title--lg', text: isPhaseStart ? (g.phase === 1 ? 'MISSION START' : 'PHASE II') : `FRAGE ${g.current_question}` }),
      isPhaseStart ? h('p', { class: 'lead', text: p.name }) : null,
      ui.countdown.node));
  announce(`Frage ${g.current_question} startet gleich.`);
}

function open(g) {
  const q = state.question;
  if (!q) { unknown(); return; }
  if (!selected || selected.q !== g.current_question) selected = null;
  ui.countdown = createCountdown({ size: 'md' });
  ui.confirm = h('button', { type: 'button', class: 'btn btn--primary btn--block btn--confirm', disabled: !selected }, 'ANTWORT BESTÄTIGEN');
  ui.options = OPTIONS.map((opt) => {
    const btn = h('button', {
      type: 'button', class: 'answer', 'aria-pressed': selected && selected.option === opt ? 'true' : 'false', dataset: { option: opt },
    },
    h('span', { class: 'answer__key', 'aria-hidden': 'true', text: opt }),
    h('span', { class: 'answer__text' }, h('span', { class: 'sr-only', text: `Antwort ${opt}: ` }), q.options[opt]));
    btn.addEventListener('click', () => choose(opt));
    return btn;
  });
  ui.confirm.addEventListener('click', submitAnswer);

  mount(app,
    h('section', { class: 'card card--question' },
      hud(),
      progressBar(g),
      ui.countdown.node,
      h('h1', { class: 'question-text', text: q.text }),
      h('div', { class: 'answers', role: 'group', 'aria-label': 'Antwortmöglichkeiten' }, ui.options),
      ui.confirm));
  announce(`Frage ${g.current_question}: ${q.text}`);
}

function choose(option) {
  if (submitting || !state || state.game.status !== 'question') return;
  if (timePhase(state.game, serverNow()) !== 'open') return;
  selected = { q: state.game.current_question, option };
  for (const btn of ui.options || []) btn.setAttribute('aria-pressed', btn.dataset.option === option ? 'true' : 'false');
  if (ui.confirm) ui.confirm.disabled = false;
  vibrate(10);
}

async function submitAnswer() {
  if (submitting || !selected || !session || !state) return;
  const q = selected.q;
  const option = selected.option;
  const g = state.game;
  if (g.current_question !== q) return;
  submitting = true;
  ui.confirm.disabled = true;
  ui.confirm.textContent = 'ÜBERMITTLE…';
  for (const btn of ui.options || []) btn.disabled = true;

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await rpc('submit_answer', { p_player_id: session.playerId, p_token: session.token, p_question_index: q, p_option: option }, { timeoutMs: 6000 });
      localLock = { q, option: res.selected_option };
      submitting = false;
      sfx.lock();
      vibrate(40);
      render();
      if (sync) sync.request(300);
      return;
    } catch (e) {
      lastError = e;
      // Nur Netzwerkfehler wiederholen, und nur solange die Frage noch läuft
      if (!e.network || serverNow() > g.ends_at_ms + (g.grace_ms || 0)) break;
    }
  }
  submitting = false;
  if (lastError.code === 'TIME_EXPIRED') {
    localExpired = q;
    render();
    return;
  }
  if (lastError.code === 'QUESTION_NOT_ACTIVE' || lastError.code === 'QUESTION_NOT_STARTED') {
    if (sync) sync.refresh();
    return;
  }
  toast(lastError.network ? 'VERBINDUNG ZUM HQ VERLOREN – ANTWORT NICHT ÜBERMITTELT' : errorText(lastError.code), 'error');
  if (ui.confirm && timePhase(g, serverNow()) === 'open') {
    ui.confirm.disabled = false;
    ui.confirm.textContent = 'ANTWORT BESTÄTIGEN';
    for (const btn of ui.options || []) btn.disabled = false;
  }
}

function locked(g) {
  const a = myAnswer();
  const q = state.question;
  ui.countdown = createCountdown({ size: 'sm' });
  ui.answered = h('p', { class: 'muted' });
  mount(app,
    h('section', { class: 'card card--center card--locked' },
      hud(),
      progressBar(g),
      h('div', { class: 'lock-icon', 'aria-hidden': 'true' }),
      h('h1', { class: 'title title--lg', text: 'ANSWER LOCKED' }),
      h('p', { class: 'locked-choice' },
        h('span', { class: 'answer__key', text: a.selected_option }),
        h('span', { text: q ? q.options[a.selected_option] : '' })),
      ui.countdown.node,
      ui.answered,
      h('p', { class: 'eyebrow', text: 'WARTE AUF COMMANDER' })));
  patchScreen();
  announce('Antwort gesperrt. Warte auf den Commander.');
}

function expired(g) {
  if (played.expired !== g.current_question) {
    played.expired = g.current_question;
    if (!bombTrackActive(SOUND_SETUP.player)) sfx.expired();
    vibrate(80);
  }
  mount(app,
    h('section', { class: 'card card--center card--expired' },
      hud(),
      progressBar(g),
      h('h1', { class: 'title title--lg title--warn', text: 'TIME EXPIRED' }),
      h('p', { class: 'lead', text: 'Keine Antwort abgegeben.' }),
      h('p', { class: 'eyebrow', text: 'WARTE AUF COMMANDER' })));
  announce('Zeit abgelaufen.');
}

function results(g) {
  const a = state.answer;
  const q = state.question;
  const correct = state.correct_option;
  let title;
  let cls;
  let pts;
  if (a && a.is_correct) { title = 'TARGET ELIMINATED'; cls = 'is-hit'; pts = `+${formatPoints(a.points)} PTS`; }
  else if (a) { title = 'TARGET MISSED'; cls = 'is-miss'; pts = '0 PTS'; }
  else { title = 'TIME EXPIRED'; cls = 'is-miss'; pts = '0 PTS'; }

  if (played.feedback !== g.current_question) {
    played.feedback = g.current_question;
    if (a && a.is_correct) { sfx.correct(); vibrate([30, 40, 30]); } else { sfx.wrong(); vibrate(120); }
  }

  mount(app,
    h('section', { class: `card card--center card--result ${cls}` },
      hud(),
      progressBar(g),
      h('h1', { class: 'title title--lg result-title', text: title }),
      h('p', { class: 'result-points', text: pts }),
      !a ? h('p', { class: 'muted', text: 'Keine Antwort abgegeben.' }) : null,
      q && correct ? h('div', { class: 'solution' },
        h('p', { class: 'eyebrow', text: 'LÖSUNG' }),
        h('p', { class: 'locked-choice' },
          h('span', { class: 'answer__key answer__key--ok', text: correct }),
          h('span', { text: q.options[correct] }))) : null,
      h('dl', { class: 'facts facts--row' },
        h('div', {}, h('dt', { text: 'GESAMT' }), h('dd', { text: `${formatPoints(state.me.score)} PTS` })),
        h('div', {}, h('dt', { text: 'PLATZ' }), h('dd', { text: `${state.me.position} / ${state.players.length}` }))),
      h('p', { class: 'eyebrow', text: 'WARTE AUF COMMANDER' })));
  announce(`${title}. ${pts}.`);
}

function topList(limit = 3) {
  const top = withPositions(state.players).slice(0, limit);
  return h('ol', { class: 'mini-rank' },
    top.map((p) => h('li', { class: `mini-rank__item${p.is_me ? ' is-me' : ''}` },
      h('span', { class: 'mini-rank__pos', text: `#${p.position}` }),
      h('span', { class: 'mini-rank__name', text: p.callsign }),
      h('span', { class: 'mini-rank__pts', text: formatPoints(p.score) }))));
}

function phaseBreak(g) {
  const next = phaseInfo(g.phase + 1);
  mount(app,
    h('section', { class: 'card card--center card--phase' },
      h('div', { class: 'stripes', 'aria-hidden': 'true' }),
      h('p', { class: 'eyebrow', text: `${phaseInfo(g.phase).label} // ${phaseInfo(g.phase).name}` }),
      h('h1', { class: 'title title--lg', text: 'PHASE I COMPLETE' }),
      h('dl', { class: 'facts facts--row' },
        h('div', {}, h('dt', { text: 'DEIN PLATZ' }), h('dd', { text: `#${state.me.position}` })),
        h('div', {}, h('dt', { text: 'PUNKTE' }), h('dd', { text: formatPoints(state.me.score) }))),
      h('h2', { class: 'section-title', text: 'ZWISCHENSTAND' }),
      topList(3),
      h('p', { class: 'lead' }, `NÄCHSTE PHASE: ${next.label} – ${next.name}`),
      h('p', { class: 'eyebrow', text: 'WARTE AUF COMMANDER' })));
  announce('Phase eins abgeschlossen.');
}

function finished(g) {
  const rank = rankFor(state.me.score, g.max_score);
  const isTop = state.me.position === 1;
  if (!played.final) { played.final = true; sfx.accomplished(); vibrate([60, 60, 60, 60, 200]); }
  const again = h('button', { type: 'button', class: 'btn btn--ghost btn--small' }, 'NÄCHSTE MISSION');
  again.addEventListener('click', () => {
    endSession();
    renderJoin({});
    try { window.history.replaceState(null, '', window.location.pathname); } catch { /* egal */ }
  });
  mount(app,
    h('section', { class: `card card--center card--final${isTop ? ' is-top' : ''}` },
      stamp('DEBRIEFING'),
      h('p', { class: 'eyebrow', text: TEXT.org }),
      h('h1', { class: 'title title--lg', text: 'MISSION ACCOMPLISHED' }),
      isTop ? h('p', { class: 'top-operator', text: 'TOP OPERATOR' }) : null,
      h('p', { class: 'final-pos', text: `#${state.me.position}` }),
      h('dl', { class: 'facts facts--row' },
        h('div', {}, h('dt', { text: 'PUNKTE' }), h('dd', { text: formatPoints(state.me.score) })),
        h('div', {}, h('dt', { text: 'RANG' }), h('dd', { class: 'rank-title', text: rank.title }))),
      h('p', { class: 'muted', text: `${rank.pct} % der maximal möglichen ${formatPoints(g.max_score)} Punkte` }),
      h('h2', { class: 'section-title', text: 'TOP 3' }),
      topList(3),
      h('div', { class: 'card__foot' }, again)));
  announce(`Mission accomplished. Platz ${state.me.position}.`);
}

function aborted() {
  const back = h('button', { type: 'button', class: 'btn btn--primary btn--block' }, 'ZUR STARTSEITE');
  back.addEventListener('click', () => {
    endSession();
    renderJoin({});
    try { window.history.replaceState(null, '', window.location.pathname); } catch { /* egal */ }
  });
  mount(app,
    h('section', { class: 'card card--center card--alert' },
      h('div', { class: 'stripes', 'aria-hidden': 'true' }),
      h('h1', { class: 'title title--lg', text: 'MISSION ABGEBROCHEN' }),
      h('p', { class: 'lead', text: 'Der Commander hat diese Mission beendet.' }),
      back));
  announce('Mission abgebrochen.');
}

function unknown() {
  mount(app, h('section', { class: 'card card--center' },
    h('h1', { class: 'title title--md', text: 'SYNCHRONISIERE…' }),
    h('div', { class: 'radar radar--sm', 'aria-hidden': 'true' })));
}

// Teil-Aktualisierung ohne Neuaufbau (Lobby-Liste, Antwortzähler)
function patchScreen() {
  if (!state) return;
  if (ui.roster) {
    mount(ui.roster, rosterList(state.players));
    ui.count.textContent = String(state.players.length);
  }
  if (ui.answered) {
    const n = state.players.filter((p) => p.answered).length;
    ui.answered.textContent = `${n} / ${state.players.length} OPERATORS LOCKED`;
  }
}

init();
