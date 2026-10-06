// =====================================================================
//  HOST-SEITE / MISSION CONTROL (host.html)
// =====================================================================

import { configStatus, rpc, watchGame } from './supabase-client.js';
import { h, mount, storage, errorText, confirmDialog, toast, formatPoints, formatSeconds, withPositions } from './utils.js';
import { serverNow, syncClock, keepClockSynced, roughSync } from './clock.js';
import { createSync } from './sync.js';
import { initAudio, sfx, bindSoundToggle, updateSoundscape, tracks, bombTrackActive, updateUnlockHint } from './audio.js';
import { setNetBanner, setLinkLed, renderConfigError, createCountdown, progressBar, coordLine, stamp } from './ui.js';
import { TEXT, phaseInfo, rankFor, SOUND_SETUP } from './questions.js';
import { createQrSvg, playerUrl, isLocalhost } from './qr.js';

const app = document.getElementById('app');
const srStatus = document.getElementById('sr-status');
const TOKEN_KEY = 'olp.host';
const GAME_KEY = 'olp.host.game';
const OPTIONS = ['A', 'B', 'C', 'D'];

let token = null;
let gameId = null;
let st = null;          // letzter Host-Zustand
let sync = null;
let unwatch = null;
let busy = false;
let stageKey = '';
let countdown = null;
let countdownQ = null;
let controls = {};
let qrCache = { code: null, node: null };
const played = { start: null, tick: null, expired: null, reveal: null, final: false, answers: 0 };

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------
async function init() {
  initAudio();
  const toggle = document.getElementById('sound-toggle');
  if (toggle) bindSoundToggle(toggle);
  const fs = document.getElementById('fullscreen-toggle');
  if (fs) {
    if (!document.documentElement.requestFullscreen) fs.hidden = true;
    fs.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen().catch(() => {});
    });
  }
  const logout = document.getElementById('logout');
  if (logout) logout.addEventListener('click', doLogout);

  if (!configStatus.ok) {
    renderConfigError(app, configStatus);
    return;
  }

  setInterval(tick, 200);
  syncClock();
  keepClockSynced();

  const saved = storage.get(TOKEN_KEY);
  if (!saved || !saved.token) { renderLogin(); return; }
  token = saved.token;
  renderBusy('VERBINDE MIT HQ…');
  await resumeHost();
}

async function resumeHost() {
  try {
    const info = await rpc('host_session_info', { p_token: token });
    if (!info.valid) {
      clearToken();
      renderLogin('COMMANDER-SITZUNG ABGELAUFEN – BITTE NEU EINLOGGEN');
      return;
    }
    setLoggedIn(true);
    const savedGame = storage.get(GAME_KEY);
    if (savedGame) openDashboard(savedGame);
    else renderMenu(info.active_game);
  } catch (e) {
    if (e.network) {
      renderBusy('VERBINDUNG ZUM HQ VERLOREN', 'RECONNECTING…');
      setNetBanner(true);
      setTimeout(resumeHost, 3000);
    } else {
      renderError(e.code);
    }
  }
}

function announce(text) {
  if (srStatus) srStatus.textContent = text;
}

function setLoggedIn(value) {
  const logout = document.getElementById('logout');
  if (logout) logout.hidden = !value;
}

function clearToken() {
  token = null;
  storage.remove(TOKEN_KEY);
  setLoggedIn(false);
}

function renderBusy(title, sub = '') {
  mount(app, h('section', { class: 'card card--center card--narrow' },
    h('p', { class: 'eyebrow', text: 'MISSION CONTROL' }),
    h('h1', { class: 'title title--md', text: title }),
    sub ? h('p', { class: 'lead', text: sub }) : null,
    h('div', { class: 'radar radar--sm', 'aria-hidden': 'true' })));
}

function renderError(code) {
  mount(app, h('section', { class: 'card card--alert card--narrow', role: 'alert' },
    h('div', { class: 'stripes', 'aria-hidden': 'true' }),
    h('h1', { class: 'title title--md', text: errorText(code) })));
}

// ---------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------
function renderLogin(message = '') {
  stopDashboard();
  setLoggedIn(false);
  const input = h('input', { id: 'password', type: 'password', class: 'input', autocomplete: 'current-password', required: true, 'aria-describedby': 'login-error' });
  const error = h('p', { id: 'login-error', class: 'form-error', role: 'alert', text: message });
  const button = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'COMMANDER LOGIN');
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' },
      h('label', { for: 'password', class: 'field__label' }, 'COMMANDER-PASSWORT'),
      input),
    error,
    button);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input.value) { error.textContent = 'PASSWORT EINGEBEN'; input.focus(); return; }
    button.disabled = true;
    button.textContent = 'PRÜFE FREIGABE…';
    error.textContent = '';
    try {
      const res = await rpc('host_login', { p_password: input.value });
      if (!res.ok) {
        error.textContent = errorText(res.error);
        input.select();
        return;
      }
      token = res.token;
      storage.set(TOKEN_KEY, { token, expiresAt: res.expires_at_ms });
      setLoggedIn(true);
      sfx.lock();
      const info = await rpc('host_session_info', { p_token: token });
      renderMenu(info.active_game);
    } catch (e) {
      error.textContent = errorText(e.code);
    } finally {
      button.disabled = false;
      button.textContent = 'COMMANDER LOGIN';
    }
  });

  mount(app,
    h('section', { class: 'card card--briefing card--narrow' },
      stamp('RESTRICTED'),
      h('p', { class: 'eyebrow', text: 'NJORGIBICEPS // COMMANDER' }),
      h('h1', { class: 'title title--xl', text: 'MISSION CONTROL' }),
      h('p', { class: 'subtitle', text: `${TEXT.title} // ${TEXT.subtitle}` }),
      h('div', { class: 'stripes', 'aria-hidden': 'true' }),
      form,
      coordLine('COMMAND POST')));
  input.focus();
}

async function doLogout() {
  const yes = await confirmDialog({ title: 'AUSLOGGEN?', text: 'Die laufende Mission bleibt erhalten. Du kannst dich jederzeit wieder einloggen.', confirmLabel: 'AUSLOGGEN' });
  if (!yes) return;
  try { if (token) await rpc('host_logout', { p_token: token }); } catch { /* egal */ }
  clearToken();
  renderLogin();
}

// ---------------------------------------------------------------------
// Menü
// ---------------------------------------------------------------------
function renderMenu(activeGame = null, message = '') {
  stopDashboard();
  storage.remove(GAME_KEY);
  const create = h('button', { type: 'button', class: 'btn btn--primary btn--xl btn--block' }, 'NEUE MISSION');
  create.addEventListener('click', () => createMission(create));
  let resume = null;
  if (activeGame) {
    resume = h('button', { type: 'button', class: 'btn btn--ghost btn--block' }, `MISSION ${activeGame.code} FORTSETZEN`);
    resume.addEventListener('click', () => openDashboard(activeGame.id));
  }
  mount(app,
    h('section', { class: 'card card--briefing card--narrow' },
      stamp('CLEARED'),
      h('p', { class: 'eyebrow', text: 'NJORGIBICEPS // COMMANDER' }),
      h('h1', { class: 'title title--xl', text: 'MISSION CONTROL' }),
      h('p', { class: 'subtitle', text: `${TEXT.title} // ${TEXT.subtitle}` }),
      h('div', { class: 'stripes', 'aria-hidden': 'true' }),
      message ? h('p', { class: 'form-error', role: 'alert', text: message }) : null,
      h('div', { class: 'stack' },
        create,
        activeGame ? h('p', { class: 'muted', text: `Offene Mission gefunden: ${activeGame.code} (${statusLabel(activeGame.status)})` }) : null,
        resume),
      coordLine('COMMAND POST')));
  create.focus();
}

async function createMission(button) {
  if (busy) return;
  busy = true;
  if (button) { button.disabled = true; button.textContent = 'ERSTELLE MISSION…'; }
  try {
    const res = await rpc('host_create_game', { p_token: token });
    busy = false;
    openDashboard(res.game.id, res);
  } catch (e) {
    busy = false;
    if (e.code === 'HOST_UNAUTHORIZED') { clearToken(); renderLogin(errorText(e.code)); return; }
    toast(errorText(e.code), 'error');
    if (button) { button.disabled = false; button.textContent = 'NEUE MISSION'; }
  }
}

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------
function stopDashboard() {
  if (sync) sync.stop();
  if (unwatch) unwatch();
  sync = null;
  unwatch = null;
  st = null;
  gameId = null;
  stageKey = '';
  countdown = null;
  countdownQ = null;
  controls = {};
  setNetBanner(false);
  setLinkLed('');
  document.body.classList.remove('is-dashboard');
  updateSoundscape(null, 0, SOUND_SETUP.host);
}

function openDashboard(id, initialState = null) {
  stopDashboard();
  gameId = id;
  storage.set(GAME_KEY, id);
  Object.assign(played, { start: null, tick: null, expired: null, reveal: null, final: false, answers: 0 });
  document.body.classList.add('is-dashboard');
  if (SOUND_SETUP.host.music) tracks.music.preload();
  if (SOUND_SETUP.host.bomb) tracks.bomb.preload();

  const stage = h('section', { id: 'stage', class: 'stage', 'aria-live': 'polite' });
  const side = h('aside', { id: 'side', class: 'side', 'aria-label': 'Missionsdaten' });
  const nav = buildControls();
  mount(app, h('div', { class: 'dash' }, stage, side, nav));

  sync = createSync({
    fetchState: () => rpc('host_get_state', { p_token: token, p_game_id: id }),
    onState: applyState,
    onError: (e) => {
      if (e.code === 'HOST_UNAUTHORIZED') { clearToken(); renderLogin(errorText(e.code)); }
      else if (e.code === 'MISSION_NOT_FOUND') renderMenu(null, errorText(e.code));
      else toast(errorText(e.code), 'error');
    },
    onConnection: (ok) => setNetBanner(!ok),
    onLink: setLinkLed,
  });
  unwatch = watchGame(id, {
    onChange: () => sync && sync.realtimeEvent(),
    onLive: (live) => sync && sync.setSubscribed(live),
  });
  if (initialState) applyState(initialState);
  else renderStageLoading();
  sync.refresh();
}

function renderStageLoading() {
  const stage = document.getElementById('stage');
  if (stage) mount(stage, h('div', { class: 'stage__center' }, h('h1', { class: 'title title--md', text: 'LADE MISSION…' })));
}

function applyState(next) {
  if (!next || !next.game || next.game.id !== gameId) return;
  if (st && next.game.state_version < st.game.state_version) return; // verspätet
  roughSync(next.game.server_now_ms);
  const prev = st;
  st = next;

  // Sounds bei Zustandswechseln
  const g = st.game;
  if (g.status === 'question' && played.start !== g.current_question) {
    played.start = g.current_question;
    played.answers = 0;
    sfx.missionStart();
  }
  if (g.status === 'question' && st.answers_count > played.answers) {
    if (prev && prev.game.current_question === g.current_question) sfx.lock();
    played.answers = st.answers_count;
  }
  if (g.status === 'results' && played.reveal !== g.current_question) {
    played.reveal = g.current_question;
    if (prev) sfx.correct();
  }
  if (g.status === 'finished' && !played.final) {
    played.final = true;
    if (prev) sfx.accomplished();
  }
  render();
}

function timePhase(game, now) {
  if (!game.started_at_ms || !game.ends_at_ms) return 'expired';
  if (now < game.started_at_ms) return 'lead';
  if (now < game.ends_at_ms) return 'open';
  return 'expired';
}

function statusLabel(status) {
  return {
    lobby: 'LOBBY', question: 'FRAGE LÄUFT', results: 'ERGEBNIS', phase_break: 'ZWISCHENRANKING',
    finished: 'MISSION ACCOMPLISHED', aborted: 'ABGEBROCHEN',
  }[status] || String(status || '').toUpperCase();
}

function render() {
  if (!st) return;
  const g = st.game;
  const now = serverNow();
  const key = `${g.status}:${g.current_question}`;
  const entering = key !== stageKey;
  stageKey = key;

  if (g.status === 'question' && countdownQ !== g.current_question) {
    countdown = createCountdown({ size: 'xl' });
    countdownQ = g.current_question;
  }

  const stage = document.getElementById('stage');
  const side = document.getElementById('side');
  if (!stage || !side) return;
  const builders = { lobby: stageLobby, question: stageQuestion, results: stageResults, phase_break: stagePhaseBreak, finished: stageFinished, aborted: stageAborted };
  mount(stage, (builders[g.status] || stageLobby)(g, now));
  stage.classList.toggle('is-entering', entering);
  if (entering) {
    announce(statusLabel(g.status));
    void stage.offsetWidth; // Animation neu starten
  }
  mount(side, ...buildSide(g));
  const dash = app.querySelector('.dash');
  if (dash) dash.dataset.status = g.status;
  updateControls();
  tick();
}

// alle 200 ms: Countdown, zeitabhängige Buttons, Ticks, Musik/Bombe
function tick() {
  updateSoundscape(st ? st.game : null, serverNow(), SOUND_SETUP.host);
  updateUnlockHint(!!st && (SOUND_SETUP.host.music || SOUND_SETUP.host.bomb));
  if (!st) return;
  const g = st.game;
  if (g.status !== 'question' || !countdown) { updateControls(); return; }
  const now = serverNow();
  const { phase, secs } = countdown.update(g, now);
  if (phase === 'open' && secs <= 5 && secs > 0 && played.tick !== `${g.current_question}:${secs}`) {
    played.tick = `${g.current_question}:${secs}`;
    if (!bombTrackActive(SOUND_SETUP.host)) sfx.tick();
  }
  if (phase === 'expired' && played.expired !== g.current_question) {
    played.expired = g.current_question;
    if (!bombTrackActive(SOUND_SETUP.host)) sfx.expired();
  }
  const line = document.getElementById('question-status');
  if (line) {
    const text = questionStatusText(g, now);
    if (line.textContent !== text) line.textContent = text;
    line.dataset.state = st.all_answered ? 'done' : phase;
  }
  updateControls();
}

function questionStatusText(g, now) {
  const phase = timePhase(g, now);
  if (st.all_answered) return 'ALLE ANTWORTEN EINGEGANGEN';
  if (phase === 'lead') return 'GET READY – FRAGE WIRD FREIGEGEBEN';
  if (phase === 'open') return 'ANTWORTFENSTER OFFEN';
  return 'ZEIT ABGELAUFEN';
}

// ---------------------------------------------------------------------
// Stage-Inhalte
// ---------------------------------------------------------------------
function stageHeader(g, title) {
  const p = phaseInfo(g.phase);
  return h('header', { class: 'stage__head' },
    h('p', { class: 'eyebrow', text: g.current_question > 0 ? `${p.label} // ${p.name}` : `${TEXT.title} // ${TEXT.subtitle}` }),
    h('h1', { class: 'title title--lg', text: title }));
}

function stageLobby(g) {
  const players = st.players;
  const chips = players.length
    ? h('ul', { class: 'chips chips--lobby' }, players.map((p) => {
        const remove = h('button', { type: 'button', class: 'chip__remove', 'aria-label': `${p.callsign} entfernen`, title: 'Aus Lobby entfernen' }, '×');
        remove.addEventListener('click', () => removePlayer(p));
        return h('li', { class: 'chip' }, h('span', { class: 'chip__name', text: p.callsign }), remove);
      }))
    : h('div', { class: 'empty' },
        h('div', { class: 'radar', 'aria-hidden': 'true' }),
        h('p', { class: 'lead', text: 'Warte auf Operatoren – QR-Code scannen oder Mission Code eingeben.' }));
  return h('div', { class: 'stage__inner' },
    stageHeader(g, 'OPERATORS DEPLOYED'),
    h('p', { class: 'big-count' }, h('b', { text: String(players.length) }), players.length === 1 ? ' OPERATOR BEREIT' : ' OPERATOREN BEREIT'),
    chips,
    coordLine(`MISSION ${g.code}`));
}

async function removePlayer(p) {
  const yes = await confirmDialog({ title: `${p.callsign} ENTFERNEN?`, text: 'Der Operator wird aus der Lobby entfernt und kann neu beitreten.', confirmLabel: 'ENTFERNEN', danger: true });
  if (!yes) return;
  await act(() => rpc('host_remove_player', { p_token: token, p_player_id: p.id }));
}

function optionGrid(q, { correct = null, distribution = null, total = 0 } = {}) {
  return h('ol', { class: 'host-options' }, OPTIONS.map((opt) => {
    const count = distribution ? Number(distribution[opt] || 0) : null;
    const pct = distribution && total > 0 ? Math.round((count / total) * 100) : 0;
    const state = correct ? (opt === correct ? ' is-correct' : ' is-wrong') : '';
    return h('li', { class: `host-option${state}` },
      h('span', { class: 'answer__key', text: opt }),
      h('span', { class: 'host-option__text', text: q.options[opt] }),
      distribution ? h('span', { class: 'host-option__count', text: String(count) }) : null,
      distribution ? h('span', { class: 'host-option__bar', 'aria-hidden': 'true', style: { '--pct': `${pct}%` } }) : null);
  }));
}

function stageQuestion(g, now) {
  const q = st.question;
  return h('div', { class: 'stage__inner stage__inner--question' },
    h('div', { class: 'qhead' },
      h('div', {},
        h('p', { class: 'eyebrow', text: `${phaseInfo(g.phase).label} // ${phaseInfo(g.phase).name}` }),
        h('p', { class: 'qnum' }, 'FRAGE ', h('b', { text: String(g.current_question) }), ` / ${g.total_questions}`)),
      countdown ? countdown.node : null),
    progressBar(g),
    h('h1', { class: 'host-question', text: q ? q.text : '' }),
    q ? optionGrid(q) : null,
    h('div', { class: 'answer-meter' },
      h('p', { class: 'answer-meter__count' }, 'ANTWORTEN ', h('b', { text: `${st.answers_count} / ${st.player_count}` })),
      h('p', { id: 'question-status', class: 'answer-meter__status', text: questionStatusText(g, now) })),
    h('ul', { class: 'chips chips--status', 'aria-label': 'Antwortstatus der Operatoren' },
      st.players.map((p) => h('li', { class: `chip${p.answered ? ' is-locked' : ''}` },
        h('span', { class: 'chip__name', text: p.callsign }),
        h('span', { class: 'sr-only', text: p.answered ? ' – Antwort gesperrt' : ' – wartet' })))));
}

function stageResults(g) {
  const q = st.question;
  const total = OPTIONS.reduce((s, o) => s + Number((st.distribution || {})[o] || 0), 0);
  return h('div', { class: 'stage__inner stage__inner--results' },
    h('div', { class: 'qhead' },
      h('div', {},
        h('p', { class: 'eyebrow', text: `${phaseInfo(g.phase).label} // ERGEBNIS` }),
        h('p', { class: 'qnum' }, 'FRAGE ', h('b', { text: String(g.current_question) }), ` / ${g.total_questions}`)),
      h('p', { class: 'solution-badge' }, 'LÖSUNG ', h('b', { text: st.correct_option || '–' }))),
    progressBar(g),
    h('h1', { class: 'host-question host-question--sm', text: q ? q.text : '' }),
    q ? optionGrid(q, { correct: st.correct_option, distribution: st.distribution, total }) : null,
    h('p', { class: 'muted', text: `${st.distribution ? Number(st.distribution[st.correct_option] || 0) : 0} von ${st.player_count} Operatoren richtig · ${st.player_count - total} ohne Antwort` }));
}

function rankingTable(players, { maxScore = 0, showRank = false, showTime = false, limit = Infinity, compact = false } = {}) {
  const rows = withPositions(players).slice(0, limit);
  return h('table', { class: `ranking${compact ? ' ranking--compact' : ''}` },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', text: 'PLATZ' }),
      h('th', { scope: 'col', text: 'CALLSIGN' }),
      h('th', { scope: 'col', class: 'num', text: 'PUNKTE' }),
      showTime ? h('th', { scope: 'col', class: 'num time-col', text: 'ZEIT', title: 'Summe der Antwortzeiten richtiger Antworten (Tie-Breaker)' }) : null,
      showRank ? h('th', { scope: 'col', class: 'rank-col', text: 'RANG' }) : null)),
    h('tbody', {}, rows.map((p) => h('tr', { class: p.position <= 3 ? `is-top is-top-${p.position}` : '' },
      h('td', { class: 'pos', text: `#${p.position}` }),
      h('td', { class: 'name', text: p.callsign }),
      h('td', { class: 'num', text: formatPoints(p.score) }),
      showTime ? h('td', { class: 'num time-col', text: formatSeconds(p.time_ms) }) : null,
      showRank ? h('td', { class: 'rank-col', text: rankFor(p.score, maxScore).title }) : null))));
}

function stagePhaseBreak(g) {
  const next = phaseInfo(g.phase + 1);
  return h('div', { class: 'stage__inner' },
    h('div', { class: 'stripes', 'aria-hidden': 'true' }),
    stageHeader(g, 'PHASE I COMPLETE'),
    h('p', { class: 'lead', text: `ZWISCHENRANKING nach ${g.current_question} Fragen` }),
    rankingTable(st.players),
    h('p', { class: 'next-phase' }, 'NÄCHSTE PHASE: ', h('b', { text: `${next.label} – ${next.name}` })));
}

function podium(players) {
  const ranked = withPositions(players);
  const slot = (p, place) => p
    ? h('div', { class: `podium__slot podium__slot--${place}` },
        place === 1 ? h('p', { class: 'top-operator', text: 'TOP OPERATOR' }) : null,
        h('p', { class: 'podium__name', text: p.callsign }),
        h('p', { class: 'podium__pts', text: `${formatPoints(p.score)} PTS` }),
        h('div', { class: 'podium__block' }, h('span', { text: `#${p.position}` })))
    : h('div', { class: `podium__slot podium__slot--${place} is-empty` }, h('div', { class: 'podium__block' }, h('span', { text: `#${place}` })));
  return h('div', { class: 'podium', role: 'list', 'aria-label': 'Siegerpodium' },
    h('div', { role: 'listitem' }, slot(ranked[1], 2)),
    h('div', { role: 'listitem' }, slot(ranked[0], 1)),
    h('div', { role: 'listitem' }, slot(ranked[2], 3)));
}

function stageFinished(g) {
  return h('div', { class: 'stage__inner stage__inner--final' },
    stamp('DEBRIEFING'),
    h('header', { class: 'stage__head stage__head--center' },
      h('p', { class: 'eyebrow', text: `${TEXT.org}` }),
      h('h1', { class: 'title title--xl', text: 'MISSION ACCOMPLISHED' })),
    podium(st.players),
    h('p', { class: 'muted center', text: `Maximal möglich: ${formatPoints(g.max_score)} Punkte · Gleichstand: schnellere Gesamtzeit der richtigen Antworten gewinnt` }));
}

function stageAborted(g) {
  return h('div', { class: 'stage__inner stage__center' },
    h('div', { class: 'stripes', 'aria-hidden': 'true' }),
    h('h1', { class: 'title title--lg', text: 'MISSION ABGEBROCHEN' }),
    h('p', { class: 'lead', text: `Mission ${g.code} wurde geschlossen. Starte eine neue Mission.` }));
}

// ---------------------------------------------------------------------
// Seitenleiste: Code, QR, Status, Rangliste
// ---------------------------------------------------------------------
function qrNode(code) {
  if (qrCache.code !== code) {
    qrCache = { code, node: createQrSvg(playerUrl(code), { label: `QR-Code zum Beitreten der Mission ${code}` }) };
  }
  return qrCache.node;
}

function buildSide(g) {
  const url = playerUrl(g.code);
  const lobby = g.status === 'lobby';
  const parts = [];

  // Finale: die komplette Rangliste bekommt die Seitenleiste
  if (g.status === 'finished') {
    parts.push(h('div', { class: 'panel panel--rank panel--final' },
      h('p', { class: 'panel__label', text: 'FINALE RANGLISTE' }),
      rankingTable(st.players, { maxScore: g.max_score, showRank: true, showTime: true, compact: true })));
    return parts;
  }

  parts.push(h('div', { class: `panel panel--code${lobby ? ' is-big' : ''}` },
    h('p', { class: 'panel__label', text: 'MISSION CODE' }),
    h('p', { class: 'mission-code', text: g.code.replace(/(\d{3})(\d{3})/, '$1 $2'), 'aria-label': `Mission Code ${g.code.split('').join(' ')}` }),
    lobby ? h('div', { class: 'qr-wrap' }, qrNode(g.code)) : null,
    lobby ? h('p', { class: 'join-url', text: url.replace(/^https?:\/\//, '') }) : null,
    lobby && isLocalhost() ? h('p', { class: 'warn', text: 'ACHTUNG: localhost – Handys können diese Adresse nicht öffnen. host.html über die IP dieses PCs oder GitHub Pages öffnen.' }) : null,
    !lobby && g.status !== 'aborted' ? h('p', { class: 'muted small', text: 'Beitritt gesperrt – Mission läuft' }) : null));

  parts.push(h('div', { class: 'panel' },
    h('dl', { class: 'facts facts--grid' },
      h('div', {}, h('dt', { text: 'STATUS' }), h('dd', { class: 'status-chip', dataset: { status: g.status }, text: statusLabel(g.status) })),
      h('div', {}, h('dt', { text: 'OPERATOREN' }), h('dd', { text: String(st.player_count) })),
      h('div', {}, h('dt', { text: 'FRAGE' }), h('dd', { text: g.current_question > 0 ? `${g.current_question} / ${g.total_questions}` : `– / ${g.total_questions}` })),
      h('div', {}, h('dt', { text: 'ANTWORTEN' }), h('dd', { text: g.current_question > 0 ? `${st.answers_count} / ${st.player_count}` : '–' })))));

  if (g.status !== 'lobby' && g.status !== 'phase_break' && g.status !== 'finished') {
    parts.push(h('div', { class: 'panel panel--rank' },
      h('p', { class: 'panel__label', text: 'RANGLISTE' }),
      rankingTable(st.players, { limit: 8 })));
  }
  return parts;
}

// ---------------------------------------------------------------------
// Steuerung
// ---------------------------------------------------------------------
function buildControls() {
  const make = (id, label, handler, cls = '') => {
    const b = h('button', { type: 'button', class: `btn ctrl ${cls}`, 'data-ctrl': id }, label);
    b.addEventListener('click', handler);
    controls[id] = b;
    return b;
  };
  return h('nav', { class: 'controls', 'aria-label': 'Missionssteuerung' },
    h('div', { class: 'controls__flow' },
      make('start', 'MISSION STARTEN', () => advance()),
      make('close', 'ANTWORTEN SCHLIESSEN', closeAnswers),
      make('reveal', 'ERGEBNIS ANZEIGEN', () => advance()),
      make('next', 'NÄCHSTE FRAGE', () => advance()),
      make('phase_break', 'ZWISCHENRANKING', () => advance()),
      make('phase2', 'PHASE II STARTEN', () => advance()),
      make('final', 'FINALE ANZEIGEN', () => advance())),
    h('div', { class: 'controls__meta' },
      make('export', 'ERGEBNIS EXPORTIEREN', exportCsv, 'btn--ghost'),
      make('new', 'NEUE MISSION', () => createMission(null), 'btn--ghost'),
      make('reset', 'MISSION ZURÜCKSETZEN', resetMission, 'btn--danger-ghost')));
}

function allowed() {
  const a = { start: false, close: false, reveal: false, next: false, phase_break: false, phase2: false, final: false, export: false, new: false, reset: false };
  if (!st) return a;
  const g = st.game;
  const now = serverNow();
  const tp = timePhase(g, now);
  a.start = g.status === 'lobby' && st.player_count > 0;
  a.close = g.status === 'question' && tp !== 'expired' && !st.all_answered;
  a.reveal = g.status === 'question' && (st.all_answered || now >= g.ends_at_ms + (g.grace_ms || 0));
  a.next = g.status === 'results' && st.next_action === 'next';
  a.phase_break = g.status === 'results' && st.next_action === 'phase_break';
  a.phase2 = g.status === 'phase_break';
  a.final = g.status === 'results' && st.next_action === 'final';
  a.export = g.status === 'finished' || g.status === 'phase_break';
  a.new = g.status === 'finished' || g.status === 'aborted';
  a.reset = g.status !== 'finished' && g.status !== 'aborted';
  return a;
}

const FLOW = ['start', 'reveal', 'next', 'phase_break', 'phase2', 'final'];

function updateControls() {
  const a = allowed();
  // Primär hervorgehoben: der nächste logische Schritt
  const primary = FLOW.find((k) => a[k]) || (a.close ? 'close' : a.new ? 'new' : null);
  // Nach dem Finale / Abbruch sind alle Ablauf-Buttons ohnehin gesperrt → ausblenden
  const over = st && (st.game.status === 'finished' || st.game.status === 'aborted');
  for (const [id, btn] of Object.entries(controls)) {
    const enabled = !busy && a[id];
    if (btn.disabled === enabled) btn.disabled = !enabled;
    btn.classList.toggle('btn--primary', id === primary && enabled);
    const flowButton = id !== 'new' && id !== 'export' && id !== 'reset';
    btn.classList.toggle('is-hidden', ((id === 'new' || id === 'export') && !a[id]) || (flowButton && over));
  }
}

async function act(fn) {
  if (busy) return;
  busy = true;
  updateControls();
  try {
    const res = await fn();
    if (res) applyState(res);
  } catch (e) {
    if (e.code === 'HOST_UNAUTHORIZED') { clearToken(); renderLogin(errorText(e.code)); return; }
    toast(errorText(e.code), 'error');
    if (sync) sync.refresh();
  } finally {
    busy = false;
    updateControls();
  }
}

function advance() {
  if (!st) return;
  const g = st.game;
  return act(() => rpc('host_advance', { p_token: token, p_game_id: g.id, p_expected_status: g.status, p_expected_question: g.current_question }));
}

function closeAnswers() {
  if (!st) return;
  const g = st.game;
  return act(() => rpc('host_close_answers', { p_token: token, p_game_id: g.id, p_question_index: g.current_question }));
}

async function resetMission() {
  if (!st) return;
  const yes = await confirmDialog({
    title: 'MISSION WIRKLICH ZURÜCKSETZEN?',
    text: 'Die Mission wird geschlossen. Alle Spieler sehen „MISSION ABGEBROCHEN“. Danach kannst du eine neue Mission mit neuem Code starten.',
    confirmLabel: 'ZURÜCKSETZEN',
    danger: true,
  });
  if (!yes) return;
  const id = st.game.id;
  await act(() => rpc('host_reset_game', { p_token: token, p_game_id: id }));
}

function exportCsv() {
  if (!st) return;
  const g = st.game;
  const safe = (v) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keine Formeln in Excel
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [['Platz', 'Callsign', 'Punkte', 'Rang'].join(';')];
  for (const p of withPositions(st.players)) {
    lines.push([p.position, safe(p.callsign), p.score, safe(rankFor(p.score, g.max_score).title)].join(';'));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `operation-lan-party-${g.code}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

init();
