// =====================================================================
//  BRACKET (bracket.html) – 1v1, 5 Operatoren, Single Elimination
//
//  Duel 01 (Vorrunde)    Seed 1 vs Seed 2          (zwei ausgeloste Operatoren)
//  Duel 02 (Halbfinale)  Seed 3 vs Sieger Duel 01  (Freilos + Sieger Duel 01)
//  Duel 03 (Halbfinale)  Seed 4 vs Seed 5          (zwei Operatoren mit Freilos)
//  Duel 04 (Finale)      Sieger Duel 02 vs Sieger Duel 03
//  Champion              Sieger Duel 04
//
//  Namen und Resultate trägt der Commander von Hand ein; der höhere Score
//  gewinnt und rückt automatisch in die nächste Runde.
// =====================================================================

import { configStatus, rpc, watchTables } from './supabase-client.js';
import { h, mount, errorText, confirmDialog, toast } from './utils.js';
import { createSync } from './sync.js';
import { setNetBanner, setLinkLed, renderConfigError } from './ui.js';
import { checkCommander, commanderLogin, commanderLogout, getToken, clearToken } from './commander.js';
import { TEXT } from './questions.js';

const app = document.getElementById('app');
const cmdArea = document.getElementById('cmd-area');
const SVG = 'http://www.w3.org/2000/svg';

// Aufbau: welcher Slot kommt woher? seed = Index in names, from = Sieger eines Duels
const MATCHES = [
  { id: 'd1', no: '01', stage: 'VORRUNDE', note: 'ZWEI AUSGELOSTE OPERATOREN', a: { seed: 0 }, b: { seed: 1 }, scores: [0, 1] },
  { id: 'd2', no: '02', stage: 'HALBFINALE', note: 'FREILOS + SIEGER DUEL 01', a: { seed: 2 }, b: { from: 'd1' }, scores: [2, 3] },
  { id: 'd3', no: '03', stage: 'HALBFINALE', note: 'ZWEI OPERATOREN MIT FREILOS', a: { seed: 3 }, b: { seed: 4 }, scores: [4, 5] },
  { id: 'd4', no: '04', stage: 'FINALE', note: 'SIEGER DUEL 02 + DUEL 03', a: { from: 'd2' }, b: { from: 'd3' }, scores: [6, 7] },
];

let server = null;                        // letzter Serverstand
let local = { names: ['', '', '', '', ''], scores: Array(8).fill(null) };
let commander = false;
let editing = false;
let dirty = false;
let saving = false;
let saveTimer = null;
let sync = null;
const el = { matches: {} };

// ---------------------------------------------------------------------
// Logik
// ---------------------------------------------------------------------
function resolve(state) {
  const out = {};
  const nameOf = (slot) => (slot.seed !== undefined ? state.names[slot.seed] || '' : (out[slot.from] && out[slot.from].winner) || '');
  for (const m of MATCHES) {
    const a = nameOf(m.a);
    const b = nameOf(m.b);
    const sa = state.scores[m.scores[0]];
    const sb = state.scores[m.scores[1]];
    let winner = null;
    let side = null;
    if (a && b && sa !== null && sb !== null && sa !== undefined && sb !== undefined && sa !== sb) {
      side = sa > sb ? 'a' : 'b';
      winner = side === 'a' ? a : b;
    }
    out[m.id] = { a, b, sa, sb, winner, side };
  }
  out.champion = out.d4.winner;
  return out;
}

// ---------------------------------------------------------------------
async function init() {
  if (!configStatus.ok) {
    renderConfigError(app, configStatus);
    return;
  }
  buildBoard();
  commander = await checkCommander();
  editing = commander;
  renderToolbar();

  sync = createSync({
    fetchState: () => rpc('bracket_state'),
    onState: applyServer,
    onError: (e) => toast(errorText(e.code), 'error'),
    onConnection: (ok) => setNetBanner(!ok),
    onLink: setLinkLed,
  });
  watchTables(['bracket'], {
    onChange: () => sync.realtimeEvent(),
    onLive: (live) => sync.setSubscribed(live),
  });
  sync.refresh();

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => drawLines()).observe(el.board);
  window.addEventListener('resize', drawLines);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawLines);
}

function applyServer(state) {
  if (server && state.version < server.version) return;
  server = state;
  const focused = el.board.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (editing && (dirty || saving || focused)) return; // eigene Eingaben nicht überschreiben
  local = { names: [...state.names], scores: [...state.scores] };
  render();
}

// ---------------------------------------------------------------------
// Aufbau (einmal) – danach werden nur Werte/Klassen aktualisiert
// ---------------------------------------------------------------------
function slotRow(match, side) {
  const spec = match[side];
  const scoreIndex = match.scores[side === 'a' ? 0 : 1];
  const nameText = h('span', { class: 'slot__name' });
  let nameInput = null;
  if (spec.seed !== undefined) {
    nameInput = h('input', { class: 'slot__input', maxlength: '24', autocomplete: 'off', spellcheck: 'false', placeholder: 'CALLSIGN', 'aria-label': `Duel ${match.no} Operator ${side.toUpperCase()}` });
    nameInput.addEventListener('input', () => { local.names[spec.seed] = nameInput.value; changed(); });
  }
  const scoreText = h('span', { class: 'slot__score-text' });
  const scoreInput = h('input', { class: 'slot__score-input', type: 'number', inputmode: 'numeric', min: '0', max: '99', 'aria-label': `Duel ${match.no} Score ${side.toUpperCase()}` });
  scoreInput.addEventListener('input', () => {
    const v = scoreInput.value.trim();
    const n = Number(v);
    local.scores[scoreIndex] = v === '' || !Number.isInteger(n) ? null : Math.max(0, Math.min(99, n));
    changed();
  });
  const row = h('div', { class: 'slot' },
    h('div', { class: 'slot__who' }, h('span', { class: 'slot__label', text: 'CALLSIGN' }), nameText, nameInput),
    h('div', { class: 'slot__score' }, h('span', { class: 'slot__label', text: 'SCORE' }), h('div', { class: 'slot__box' }, scoreText, scoreInput)));
  return { row, nameText, nameInput, scoreText, scoreInput, spec, scoreIndex };
}

function matchCard(m) {
  const a = slotRow(m, 'a');
  const b = slotRow(m, 'b');
  const card = h('article', { class: `duel duel--${m.id}`, id: `duel-${m.id}`, 'aria-label': `Duel ${m.no} ${m.stage}` },
    h('header', { class: 'duel__head' }, h('span', { text: `DUEL ${m.no} // ${m.stage}` })),
    a.row, b.row);
  const wrap = h('div', { class: `duel-wrap duel-wrap--${m.id}` }, card, h('p', { class: 'duel__note', text: m.note }));
  el.matches[m.id] = { card, a, b, wrap };
  return wrap;
}

function buildBoard() {
  el.champName = h('p', { class: 'champ__name' });
  el.champion = h('article', { class: 'champ', id: 'champion', 'aria-live': 'polite' },
    h('header', { class: 'champ__head', text: 'TOP OPERATOR' }),
    h('p', { class: 'champ__title', text: 'CHAMPION' }),
    el.champName,
    h('p', { class: 'slot__label champ__label', text: 'CALLSIGN' }));
  el.svg = document.createElementNS(SVG, 'svg');
  el.svg.setAttribute('class', 'br-lines');
  el.svg.setAttribute('aria-hidden', 'true');
  el.board = h('div', { class: 'br-board' },
    el.svg,
    h('p', { class: 'br-col br-col--1', text: 'PLAY-IN' }),
    h('p', { class: 'br-col br-col--2', text: 'SEMIFINALS' }),
    h('p', { class: 'br-col br-col--3', text: 'FINAL' }),
    h('p', { class: 'br-col br-col--4', text: 'VICTOR' }),
    MATCHES.map(matchCard),
    h('div', { class: 'champ-wrap' }, el.champion),
    h('div', { class: 'br-radar radar', 'aria-hidden': 'true' }),
    h('div', { class: 'br-sites', 'aria-hidden': 'true' }, h('span', { text: 'A' }), h('span', { text: 'B' })));

  el.status = h('span', { class: 'br-status' });
  el.saveState = h('span', { class: 'br-save', role: 'status', 'aria-live': 'polite' });
  const draw = h('button', { type: 'button', class: 'btn btn--ghost' }, 'AUSLOSEN');
  draw.addEventListener('click', shuffleSeeds);
  const clearScores = h('button', { type: 'button', class: 'btn btn--ghost' }, 'RESULTATE LÖSCHEN');
  clearScores.addEventListener('click', () => resetBracket(true));
  const clearAll = h('button', { type: 'button', class: 'btn btn--danger-ghost' }, 'ALLES LEEREN');
  clearAll.addEventListener('click', () => resetBracket(false));
  el.tools = h('div', { class: 'br-tools', hidden: true },
    h('p', { class: 'eyebrow', text: 'COMMANDER // NAMEN & RESULTATE EINTRAGEN' }),
    h('p', { class: 'field__hint', text: 'Namen der 5 Operatoren in Duel 01–03 eintragen (oder AUSLOSEN), danach die Scores. Der höhere Score gewinnt und rückt automatisch weiter. Alles wird sofort gespeichert.' }),
    h('div', { class: 'br-tools__row' }, draw, clearScores, clearAll, el.saveState));

  mount(app,
    h('section', { class: 'br-page' },
      h('div', { class: 'stripes br-stripes', 'aria-hidden': 'true' }),
      h('header', { class: 'br-head' },
        h('div', {},
          h('h1', { class: 'br-title', text: 'OPERATION LAN-PARTY // 1v1' }),
          h('p', { class: 'br-sub', text: 'TACTICAL DUEL BRACKET // CS2' })),
        h('div', { class: 'br-meta' },
          h('p', { text: 'NJORGIBICEPS // SPECIAL OPERATIONS' }),
          h('p', { text: '5 OPERATORS // SINGLE ELIMINATION' }),
          h('p', { class: 'br-meta--hot', text: 'CLASSIFIED // MATCH CONTROL' }))),
      el.tools,
      el.board,
      h('footer', { class: 'br-params' },
        h('div', {},
          h('p', { class: 'br-params__title', text: 'MISSION PARAMETERS' }),
          h('p', { text: '5 Spieler // Single Elimination // Namen & Resultate direkt von Hand eintragen' })),
        el.status),
      h('div', { class: 'br-foot' }, h('span', { text: 'TACTICAL MATCH CONTROL // ORIGINAL CS2-INSPIRED DESIGN' }), h('span', { text: 'OPERATION LAN-PARTY' })),
      h('div', { class: 'stripes br-stripes', 'aria-hidden': 'true' })));
}

// ---------------------------------------------------------------------
// Anzeige
// ---------------------------------------------------------------------
function render() {
  const r = resolve(local);
  for (const m of MATCHES) {
    const res = r[m.id];
    const parts = el.matches[m.id];
    for (const side of ['a', 'b']) {
      const slot = parts[side];
      const name = res[side];
      const score = res[side === 'a' ? 'sa' : 'sb'];
      slot.nameText.textContent = name || (slot.spec.from ? `SIEGER DUEL ${slot.spec.from.slice(1).padStart(2, '0')}` : '—');
      slot.nameText.classList.toggle('is-empty', !name);
      if (slot.nameInput && document.activeElement !== slot.nameInput) slot.nameInput.value = local.names[slot.spec.seed] || '';
      slot.scoreText.textContent = score === null || score === undefined ? '' : String(score);
      if (document.activeElement !== slot.scoreInput) slot.scoreInput.value = score === null || score === undefined ? '' : String(score);
      slot.scoreInput.disabled = !(res.a && res.b);
      slot.row.classList.toggle('is-winner', res.side === side);
      slot.row.classList.toggle('is-loser', res.side !== null && res.side !== side);
      slot.row.classList.toggle('is-seed', !!slot.nameInput);
    }
    parts.card.classList.toggle('is-decided', !!res.winner);
    parts.card.classList.toggle('is-ready', !!(res.a && res.b) && !res.winner);
  }
  el.champName.textContent = r.champion || '—';
  el.champion.classList.toggle('is-crowned', !!r.champion);

  const anyScore = local.scores.some((s) => s !== null && s !== undefined);
  el.status.textContent = `STATUS: ${r.champion ? `CHAMPION // ${r.champion.toUpperCase()}` : anyScore ? 'LIVE' : 'READY'} // ${TEXT.eventDate}`;
  requestAnimationFrame(drawLines);
}

// Verbindungslinien wie auf der Vorlage: vom Duel nach rechts zum
// nächsten Slot (waagrecht – senkrecht – waagrecht)
function drawLines() {
  const svg = el.svg;
  if (!svg || !el.board) return;
  while (svg.firstChild) svg.firstChild.remove();
  if (getComputedStyle(svg).display === 'none') return;
  const box = el.board.getBoundingClientRect();
  svg.setAttribute('width', String(box.width));
  svg.setAttribute('height', String(box.height));
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  const r = resolve(local);
  const rel = (rect) => ({ left: rect.left - box.left, right: rect.right - box.left, top: rect.top - box.top, bottom: rect.bottom - box.top, mid: (rect.top + rect.bottom) / 2 - box.top });
  const link = (fromCard, toEl, active) => {
    const a = rel(fromCard.getBoundingClientRect());
    const b = rel(toEl.getBoundingClientRect());
    const x1 = a.right;
    const y1 = a.mid;
    const x2 = b.left;
    const y2 = b.mid;
    const xm = x1 + (x2 - x1) / 2;
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', `M${x1} ${y1} H${xm} V${y2} H${x2}`);
    path.setAttribute('class', `br-line${active ? ' is-active' : ''}`);
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('cx', String(x2));
    dot.setAttribute('cy', String(y2));
    dot.setAttribute('r', '3.5');
    dot.setAttribute('class', `br-dot${active ? ' is-active' : ''}`);
    svg.append(path, dot);
  };
  const M = el.matches;
  link(M.d1.card, M.d2.b.row, !!r.d1.winner);
  link(M.d2.card, M.d4.a.row, !!r.d2.winner);
  link(M.d3.card, M.d4.b.row, !!r.d3.winner);
  link(M.d4.card, el.champion, !!r.champion);
}

// ---------------------------------------------------------------------
// Commander
// ---------------------------------------------------------------------
function renderToolbar() {
  if (!commander) {
    const login = h('button', { type: 'button', class: 'btn btn--tiny' }, 'COMMANDER LOGIN');
    login.addEventListener('click', async () => {
      if (await commanderLogin()) { commander = true; editing = true; renderToolbar(); render(); }
    });
    mount(cmdArea, login);
  } else {
    const toggle = h('button', { type: 'button', class: 'btn btn--tiny', 'aria-pressed': editing ? 'true' : 'false' }, editing ? 'BEARBEITEN: AN' : 'BEARBEITEN: AUS');
    toggle.addEventListener('click', () => { editing = !editing; renderToolbar(); if (!editing && server) applyServer(server); render(); });
    const logout = h('button', { type: 'button', class: 'btn btn--tiny' }, 'LOGOUT');
    logout.addEventListener('click', async () => { await commanderLogout(); commander = false; editing = false; renderToolbar(); render(); });
    mount(cmdArea, toggle, logout);
  }
  document.body.classList.toggle('is-editing', editing);
  if (el.tools) el.tools.hidden = !editing;
  requestAnimationFrame(drawLines);
}

function setSaveState(text, kind = '') {
  el.saveState.textContent = text;
  el.saveState.dataset.kind = kind;
}

function changed() {
  dirty = true;
  render();
  setSaveState('ÄNDERUNGEN …');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}

async function save() {
  if (saving) { saveTimer = setTimeout(save, 300); return; }
  const token = getToken();
  if (!token) { commander = false; editing = false; renderToolbar(); return; }
  saving = true;
  dirty = false;
  setSaveState('SPEICHERN …');
  try {
    const res = await rpc('bracket_save', { p_token: token, p_names: local.names, p_scores: local.scores });
    server = res;
    setSaveState('GESPEICHERT ✓', 'ok');
    if (!dirty) { local = { names: [...res.names], scores: [...res.scores] }; render(); }
  } catch (e) {
    dirty = true;
    setSaveState(errorText(e.code), 'error');
    if (e.code === 'HOST_UNAUTHORIZED') {
      clearToken();
      commander = false;
      editing = false;
      renderToolbar();
    } else if (e.network) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 2000); // nach Reconnect erneut
    }
  } finally {
    saving = false;
  }
}

async function shuffleSeeds() {
  const names = local.names.map((n) => n.trim()).filter(Boolean);
  if (names.length < 2) { toast('ZUERST NAMEN EINTRAGEN'); return; }
  const anyScore = local.scores.some((s) => s !== null && s !== undefined);
  if (anyScore) {
    const yes = await confirmDialog({ title: 'NEU AUSLOSEN?', text: 'Die Operatoren werden zufällig neu verteilt und alle Resultate gelöscht.', confirmLabel: 'AUSLOSEN', danger: true });
    if (!yes) return;
  }
  const pool = [...local.names];
  for (let i = pool.length - 1; i > 0; i--) {
    const rnd = new Uint32Array(1);
    crypto.getRandomValues(rnd);
    const j = rnd[0] % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  local = { names: pool, scores: Array(8).fill(null) };
  changed();
  toast('OPERATOREN AUSGELOST');
}

async function resetBracket(keepNames) {
  const yes = await confirmDialog({
    title: keepNames ? 'RESULTATE LÖSCHEN?' : 'BRACKET KOMPLETT LEEREN?',
    text: keepNames ? 'Alle Scores werden gelöscht, die Namen bleiben.' : 'Alle Namen und Scores werden gelöscht.',
    confirmLabel: keepNames ? 'LÖSCHEN' : 'LEEREN',
    danger: true,
  });
  if (!yes) return;
  const token = getToken();
  if (!token) return;
  clearTimeout(saveTimer);
  try {
    const res = await rpc('bracket_reset', { p_token: token, p_keep_names: keepNames });
    server = res;
    dirty = false;
    local = { names: [...res.names], scores: [...res.scores] };
    render();
    setSaveState('GESPEICHERT ✓', 'ok');
  } catch (e) {
    toast(errorText(e.code), 'error');
  }
}

init();
