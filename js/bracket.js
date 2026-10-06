// =====================================================================
//  BRACKET / TURNIER (bracket.html) – 1v1 für 4–8 Operatoren
//
//  1. SETUP          Commander trägt die Spieler vorab ein
//  2. AUSLOSUNG      Server lost zufällig: Qualifikation als Ring,
//                    jeder spielt genau 2 Duelle
//  3. QUALIFIKATION  Rangliste: Punkte (Sieg 3, Remis 1), dann Runden-
//                    differenz, dann gewonnene Runden → Top 4 weiter
//  4. PLAYOFFS       Halbfinale 1. vs 4. und 2. vs 3. → FINALE → CHAMPION
//                    Lower Bracket: Verlierer der Halbfinals → Platz 3
//  Alle sehen live mit, bearbeiten kann nur der Commander.
// =====================================================================

import { configStatus, rpc, watchTables } from './supabase-client.js';
import { h, mount, errorText, confirmDialog, toast } from './utils.js';
import { createSync } from './sync.js';
import { setNetBanner, setLinkLed, renderConfigError } from './ui.js';
import { checkCommander, commanderLogin, commanderLogout, getToken, clearToken } from './commander.js';
import { TEXT } from './questions.js';
import { isMe, norm, startHeartbeat } from './account.js';
import { initGate } from './gate.js';

const app = document.getElementById('app');
const cmdArea = document.getElementById('cmd-area');
const SVG = 'http://www.w3.org/2000/svg';
const MAX_PLAYERS = 8;
const PTS = { W: 3, D: 1, L: 0 };

// K.-o.-Duelle: Index in ko_scores
const KO = {
  sf1: { no: 'HF 1', stage: 'HALBFINALE', note: 'PLATZ 1 VS PLATZ 4 DER QUALI', idx: [0, 1] },
  sf2: { no: 'HF 2', stage: 'HALBFINALE', note: 'PLATZ 2 VS PLATZ 3 DER QUALI', idx: [2, 3] },
  final: { no: 'FINALE', stage: 'TOP OPERATOR', note: 'SIEGER HF 1 + SIEGER HF 2', idx: [6, 7] },
  third: { no: 'PLATZ 3', stage: 'LOWER BRACKET', note: 'VERLIERER HF 1 + VERLIERER HF 2', idx: [4, 5] },
};

let server = null;
let local = { qual: [], ko: Array(8).fill(null) };
let commander = false;
let editing = false;
let setupOpen = false;
let dirty = false;
let saving = false;
let saveTimer = null;
let sync = null;
let structureKey = '';
let viewMode = 'bracket';     // 'bracket' | 'finish'
let finishKey = '';          // gemerkter Abschluss → automatisch einmal zur Ergebnis-Seite
let finishSig = '';
let accounts = [];
const el = { ko: {} };

// ---------------------------------------------------------------------
// Logik
// ---------------------------------------------------------------------
const has = (v) => v !== null && v !== undefined;

function duel(a, b, sa, sb) {
  let winner = null;
  let loser = null;
  let side = null;
  if (a && b && has(sa) && has(sb) && sa !== sb) {
    side = sa > sb ? 'a' : 'b';
    winner = side === 'a' ? a : b;
    loser = side === 'a' ? b : a;
  }
  return { a, b, sa, sb, winner, loser, side };
}

function compute(st, scores) {
  const players = st.players || [];
  const pairs = st.pairs || [];
  const matches = [];
  for (let k = 0; k < pairs.length; k += 2) {
    const ia = pairs[k];
    const ib = pairs[k + 1];
    matches.push({ k: k / 2, ia, ib, a: players[ia], b: players[ib], sa: scores.qual[k], sb: scores.qual[k + 1] });
  }
  const rows = players.map((name, i) => ({ i, name, played: 0, w: 0, d: 0, l: 0, rf: 0, ra: 0, pts: 0 }));
  for (const m of matches) {
    if (!has(m.sa) || !has(m.sb)) continue;
    const A = rows[m.ia];
    const B = rows[m.ib];
    A.played++; B.played++;
    A.rf += m.sa; A.ra += m.sb; B.rf += m.sb; B.ra += m.sa;
    if (m.sa > m.sb) { A.w++; B.l++; } else if (m.sa < m.sb) { B.w++; A.l++; } else { A.d++; B.d++; }
  }
  for (const r of rows) r.pts = r.w * PTS.W + r.d * PTS.D;
  const table = [...rows].sort((x, y) => (y.pts - x.pts) || ((y.rf - y.ra) - (x.rf - x.ra)) || (y.rf - x.rf) || x.name.localeCompare(y.name, 'de'));
  table.forEach((r, i) => { r.pos = i + 1; });
  const scored = matches.filter((m) => has(m.sa) && has(m.sb)).length;
  const complete = matches.length > 0 && scored === matches.length;
  const seed = (n) => (complete && table[n - 1] ? table[n - 1].name : '');
  const k = scores.ko;
  const sf1 = duel(seed(1), seed(4), k[0], k[1]);
  const sf2 = duel(seed(2), seed(3), k[2], k[3]);
  const third = duel(sf1.loser, sf2.loser, k[4], k[5]);
  const final = duel(sf1.winner, sf2.winner, k[6], k[7]);
  const placements = [final.winner, final.loser, third.winner, third.loser, ...table.slice(4).map((r) => (complete ? r.name : null))];
  const finished = !!(final.winner && third.winner);

  // Gesamtbilanz aller Duelle (Quali + Playoffs) für die Abschluss-Rangliste
  const total = Object.fromEntries(players.map((n) => [n, { w: 0, d: 0, l: 0, rf: 0, ra: 0 }]));
  const count = (a, b, sa, sb) => {
    if (!a || !b || !has(sa) || !has(sb) || !total[a] || !total[b]) return;
    total[a].rf += sa; total[a].ra += sb; total[b].rf += sb; total[b].ra += sa;
    if (sa > sb) { total[a].w++; total[b].l++; } else if (sa < sb) { total[b].w++; total[a].l++; } else { total[a].d++; total[b].d++; }
  };
  for (const m of matches) count(m.a, m.b, m.sa, m.sb);
  for (const d of [sf1, sf2, third, final]) count(d.a, d.b, d.sa, d.sb);
  return { players, matches, table, scored, complete, sf1, sf2, third, final, placements, finished, total };
}

// ---------------------------------------------------------------------
async function init() {
  if (!configStatus.ok) {
    renderConfigError(app, configStatus);
    return;
  }
  startHeartbeat();
  initGate();
  buildPage();
  loadAccounts();
  setInterval(loadAccounts, 20000);
  commander = await checkCommander();
  editing = commander;
  renderToolbar();

  sync = createSync({
    fetchState: () => rpc('tournament_state'),
    onState: applyServer,
    onError: (e) => toast(errorText(e.code), 'error'),
    onConnection: (ok) => setNetBanner(!ok),
    onLink: setLinkLed,
  });
  watchTables(['tournament'], {
    onChange: () => sync.realtimeEvent(),
    onLive: (live) => sync.setSubscribed(live),
  });
  sync.refresh();

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => drawLines()).observe(el.ko.root);
  window.addEventListener('resize', drawLines);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawLines);
}

function applyServer(state) {
  if (server && state.version < server.version) return;
  const structureChanged = !server || server.pairs.join(',') !== state.pairs.join(',') || server.players.join('|') !== state.players.join('|');
  server = state;
  const focused = el.page.contains(document.activeElement) && document.activeElement.classList.contains('score-input');
  if (editing && !structureChanged && (dirty || saving || focused)) return; // eigene Eingaben nicht überschreiben
  local = { qual: [...state.qual_scores], ko: [...state.ko_scores] };
  if (structureChanged) { dirty = false; fillSetupInputs(); }
  render();
}

// ---------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------
function scoreInput(label, onValue) {
  const input = h('input', { class: 'score-input', type: 'number', inputmode: 'numeric', min: '0', max: '99', 'aria-label': label });
  input.addEventListener('input', () => {
    const v = input.value.trim();
    const n = Number(v);
    onValue(v === '' || !Number.isInteger(n) ? null : Math.max(0, Math.min(99, n)));
    changed();
  });
  return input;
}

function koSlot(key, side) {
  const spec = KO[key];
  const idx = spec.idx[side === 'a' ? 0 : 1];
  const nameText = h('span', { class: 'slot__name' });
  const scoreText = h('span', { class: 'slot__score-text' });
  const input = scoreInput(`${spec.no} Score ${side.toUpperCase()}`, (v) => { local.ko[idx] = v; });
  input.classList.add('slot__score-input');
  const row = h('div', { class: 'slot' },
    h('div', { class: 'slot__who' }, h('span', { class: 'slot__label', text: 'CALLSIGN' }), nameText),
    h('div', { class: 'slot__score' }, h('span', { class: 'slot__label', text: 'SCORE' }), h('div', { class: 'slot__box' }, scoreText, input)));
  return { row, nameText, scoreText, input, idx };
}

function koCard(key) {
  const spec = KO[key];
  const a = koSlot(key, 'a');
  const b = koSlot(key, 'b');
  const card = h('article', { class: `duel duel--${key}`, id: `ko-${key}`, 'aria-label': `${spec.no} ${spec.stage}` },
    h('header', { class: 'duel__head' }, h('span', { text: `${spec.no} // ${spec.stage}` })),
    a.row, b.row);
  const wrap = h('div', { class: `duel-wrap tn-ko--${key}` }, card, h('p', { class: 'duel__note', text: spec.note }));
  el.ko[key] = { card, a, b, wrap };
  return wrap;
}

function buildPage() {
  // Setup (Commander)
  el.setupInputs = Array.from({ length: MAX_PLAYERS }, (_, i) => h('input', { class: 'input', maxlength: '24', autocomplete: 'off', spellcheck: 'false', placeholder: `OPERATOR ${i + 1}`, 'aria-label': `Operator ${i + 1}` }));
  const savePlayers = h('button', { type: 'button', class: 'btn btn--ghost' }, 'SPIELER SPEICHERN');
  savePlayers.addEventListener('click', () => submitPlayers(false));
  const drawStart = h('button', { type: 'button', class: 'btn btn--primary' }, 'AUSLOSEN & STARTEN');
  drawStart.addEventListener('click', () => submitPlayers(true));
  el.setupCancel = h('button', { type: 'button', class: 'btn btn--ghost' }, 'ABBRECHEN');
  el.setupCancel.addEventListener('click', () => { setupOpen = false; fillSetupInputs(); render(); });
  el.setupCount = h('span', { class: 'br-save' });
  for (const input of el.setupInputs) input.addEventListener('input', () => { updateSetupCount(); renderAccChips(); });
  el.accChips = h('div', { class: 'tn-acc' });
  const takeChecked = h('button', { type: 'button', class: 'btn btn--ghost' }, 'EINGECHECKTE ÜBERNEHMEN');
  takeChecked.addEventListener('click', takeCheckedIn);
  el.setup = h('section', { class: 'br-tools tn-setup', hidden: true, 'aria-label': 'Spieler eintragen' },
    h('p', { class: 'eyebrow', text: 'COMMANDER // SCHRITT 1: OPERATOREN EINTRAGEN' }),
    h('p', { class: 'field__hint', text: '4–8 Operatoren vorab eintragen. AUSLOSEN & STARTEN verteilt alle zufällig: In der Qualifikation spielt jeder genau 2 Duelle. Die Top 4 kommen ins Halbfinale, die Verlierer der Halbfinals spielen um Platz 3.' }),
    h('div', { class: 'tn-setup__grid' }, el.setupInputs),
    h('p', { class: 'field__label', text: 'REGISTRIERTE OPERATOREN – ANTIPPEN ZUM HINZUFÜGEN' }),
    el.accChips,
    h('div', { class: 'br-tools__row' }, takeChecked),
    h('div', { class: 'br-tools__row' }, savePlayers, drawStart, el.setupCancel, el.setupCount));

  // Werkzeuge während des Turniers (Commander)
  el.saveState = h('span', { class: 'br-save', role: 'status', 'aria-live': 'polite' });
  const redraw = h('button', { type: 'button', class: 'btn btn--ghost' }, 'NEU AUSLOSEN');
  redraw.addEventListener('click', redrawTournament);
  const clearScores = h('button', { type: 'button', class: 'btn btn--ghost' }, 'RESULTATE LÖSCHEN');
  clearScores.addEventListener('click', clearAllScores);
  const editPlayers = h('button', { type: 'button', class: 'btn btn--danger-ghost' }, 'SPIELER ÄNDERN');
  editPlayers.addEventListener('click', () => { setupOpen = true; fillSetupInputs(); render(); el.setupInputs[0].focus(); });
  el.tools = h('section', { class: 'br-tools', hidden: true },
    h('p', { class: 'eyebrow', text: 'COMMANDER // RESULTATE EINTRAGEN' }),
    h('p', { class: 'field__hint', text: 'Scores direkt in die Felder tippen – wird sofort gespeichert. Der höhere Score gewinnt; die Rangliste und die Playoffs aktualisieren sich automatisch.' }),
    h('div', { class: 'br-tools__row' }, redraw, clearScores, editPlayers, el.saveState));

  // Wartebildschirm (Setup-Phase, alle)
  el.waitList = h('ul', { class: 'chips tn-wait__list' });
  el.wait = h('section', { class: 'tn-wait', hidden: true },
    h('p', { class: 'eyebrow', text: 'OPERATORS REGISTERED' }),
    el.waitList,
    h('div', { class: 'radar', 'aria-hidden': 'true' }),
    h('p', { class: 'tn-wait__text', text: 'WARTE AUF AUSLOSUNG …' }));

  // Qualifikation
  el.qlist = h('ol', { class: 'tn-qlist' });
  el.qprogress = h('span', { class: 'tn-progress' });
  el.table = h('div', { class: 'tn-table' });
  el.quali = h('section', { class: 'tn-quali', 'aria-label': 'Qualifikation' },
    h('p', { class: 'br-col tn-label' }, 'QUALIFIKATION // JEDER SPIELT 2× ', el.qprogress),
    el.qlist,
    h('p', { class: 'br-col tn-label', text: 'RANGLISTE QUALI // TOP 4 → HALBFINALE' }),
    el.table);

  // Playoffs
  el.svg = document.createElementNS(SVG, 'svg');
  el.svg.setAttribute('class', 'br-lines');
  el.svg.setAttribute('aria-hidden', 'true');
  el.champName = h('p', { class: 'champ__name' });
  el.champion = h('article', { class: 'champ', id: 'champion', 'aria-live': 'polite' },
    h('header', { class: 'champ__head', text: 'TOP OPERATOR' }),
    h('p', { class: 'champ__title', text: 'CHAMPION' }),
    el.champName,
    h('p', { class: 'slot__label champ__label', text: 'CALLSIGN' }));
  el.standings = h('ol', { class: 'tn-standings' });
  el.ko.root = h('section', { class: 'tn-ko', 'aria-label': 'Playoffs' },
    el.svg,
    h('p', { class: 'br-col tn-ko__l1', text: 'SEMIFINALS' }),
    h('p', { class: 'br-col tn-ko__l2', text: 'FINAL // LOWER BRACKET' }),
    h('p', { class: 'br-col tn-ko__l3', text: 'VICTOR' }),
    koCard('sf1'),
    koCard('sf2'),
    koCard('final'),
    h('div', { class: 'champ-wrap tn-champ' }, el.champion),
    h('p', { class: 'br-col tn-ko__l4', text: 'LOWER BRACKET // PLATZ 3' }),
    koCard('third'),
    h('section', { class: 'tn-final-standings' },
      h('p', { class: 'br-col', text: 'ENDSTAND' }),
      el.standings));

  el.board = h('div', { class: 'tn-board', hidden: true }, el.quali, el.ko.root);

  // Abschluss-Seite (Turnier beendet)
  el.finish = h('section', { class: 'tn-finish', hidden: true, 'aria-live': 'polite' });
  // Umschalter Bracket ⇄ Leaderboard (in der Fusszeile, kostet keine Höhe)
  el.viewToggle = h('button', { type: 'button', class: 'btn btn--small tn-view-toggle', hidden: true });
  el.viewToggle.addEventListener('click', () => { viewMode = viewMode === 'finish' ? 'bracket' : 'finish'; render(); });
  el.metaPlayers = h('p', {});
  el.status = h('span', { class: 'br-status' });
  el.params = h('p', {});

  el.page = h('section', { class: 'br-page tn-page' },
    h('div', { class: 'stripes br-stripes', 'aria-hidden': 'true' }),
    h('header', { class: 'br-head' },
      h('div', {},
        h('h1', { class: 'br-title', text: 'OPERATION LAN PARTY // 1v1' }),
        h('p', { class: 'br-sub', text: 'TACTICAL DUEL BRACKET // CS2' })),
      h('div', { class: 'br-meta' },
        h('p', { text: TEXT.org }),
        el.metaPlayers,
        h('p', { class: 'br-meta--hot', text: 'CLASSIFIED // MATCH CONTROL' }))),
    el.setup,
    el.tools,
    el.wait,
    el.finish,
    el.board,
    h('footer', { class: 'br-params' },
      h('div', {}, h('p', { class: 'br-params__title', text: 'MISSION PARAMETERS' }), el.params),
      h('div', { class: 'tn-params-right' }, el.viewToggle, el.status)),
    h('div', { class: 'br-foot' }, h('span', { text: 'TACTICAL MATCH CONTROL // ORIGINAL CS2-INSPIRED DESIGN' }), h('span', { text: 'OPERATION LAN PARTY' })),
    h('div', { class: 'stripes br-stripes', 'aria-hidden': 'true' }));
  mount(app, el.page);
}

// Quali-Liste nur neu bauen, wenn sich Auslosung/Spieler ändern
function buildQualiRows(c) {
  el.qrows = c.matches.map((m) => {
    const ia = scoreInput(`Quali ${m.k + 1} Score ${m.a}`, (v) => { local.qual[2 * m.k] = v; });
    const ib = scoreInput(`Quali ${m.k + 1} Score ${m.b}`, (v) => { local.qual[2 * m.k + 1] = v; });
    const ta = h('span', { class: 'qrow__score-text' });
    const tb = h('span', { class: 'qrow__score-text' });
    const na = h('span', { class: 'qrow__name qrow__name--a', text: m.a });
    const nb = h('span', { class: 'qrow__name qrow__name--b', text: m.b });
    const row = h('li', { class: 'qrow' },
      h('span', { class: 'qrow__no', text: `Q${String(m.k + 1).padStart(2, '0')}` }),
      na,
      h('span', { class: 'qrow__box' }, ta, ia),
      h('span', { class: 'qrow__vs', 'aria-hidden': 'true', text: ':' }),
      h('span', { class: 'qrow__box' }, tb, ib),
      nb);
    return { row, ia, ib, ta, tb, na, nb };
  });
  mount(el.qlist, el.qrows.map((r) => r.row));
}

// ---------------------------------------------------------------------
// Anzeige
// ---------------------------------------------------------------------
function render() {
  if (!server) return;
  const c = compute(server, local);
  const n = c.players.length;
  const drawn = c.matches.length > 0;
  const showSetup = editing && (!drawn || setupOpen);

  el.setup.hidden = !showSetup;
  el.setupCancel.hidden = !drawn;
  el.tools.hidden = !(editing && drawn && !setupOpen);
  el.wait.hidden = drawn;
  el.board.hidden = !drawn;
  el.finish.hidden = true;
  el.viewToggle.hidden = true;
  el.metaPlayers.textContent = `${n || 5} OPERATORS // QUALI 2× + PLAYOFFS`;
  el.params.textContent = `${n || '4–8'} Spieler // Quali: jeder 2 Duelle, zufällig gelost // Top 4 → Halbfinale (1.–4., 2.–3.) // Finale + Spiel um Platz 3`;

  const waitKey = `${editing}|${c.players.join('|')}`;
  if (el.waitKey !== waitKey) {
    el.waitKey = waitKey;
    mount(el.waitList, n
      ? c.players.map((p) => h('li', { class: 'chip' }, h('span', { class: 'roster__dot', 'aria-hidden': 'true' }), h('span', { class: 'chip__name', text: p })))
      : h('li', { class: 'muted', text: editing ? 'Oben die Operatoren eintragen.' : 'Noch keine Operatoren eingetragen.' }));
  }
  el.wait.querySelector('.tn-wait__text').textContent = n >= 4 ? 'WARTE AUF AUSLOSUNG …' : 'WARTE AUF OPERATOREN …';

  if (showSetup) renderAccChips();
  if (!drawn) {
    el.status.textContent = `STATUS: SETUP // ${TEXT.eventDate}`;
    updateSetupCount();
    return;
  }

  // Quali-Liste
  const key = `${server.players.join('|')}#${server.pairs.join(',')}`;
  if (key !== structureKey) { structureKey = key; buildQualiRows(c); }
  c.matches.forEach((m, i) => {
    const r = el.qrows[i];
    const decided = has(m.sa) && has(m.sb);
    r.ta.textContent = has(m.sa) ? String(m.sa) : '–';
    r.tb.textContent = has(m.sb) ? String(m.sb) : '–';
    if (document.activeElement !== r.ia) r.ia.value = has(m.sa) ? String(m.sa) : '';
    if (document.activeElement !== r.ib) r.ib.value = has(m.sb) ? String(m.sb) : '';
    r.row.classList.toggle('is-done', decided);
    r.na.classList.toggle('is-winner', decided && m.sa > m.sb);
    r.nb.classList.toggle('is-winner', decided && m.sb > m.sa);
    r.na.classList.toggle('is-loser', decided && m.sa < m.sb);
    r.nb.classList.toggle('is-loser', decided && m.sb < m.sa);
    r.na.classList.toggle('is-me', isMe(m.a));
    r.nb.classList.toggle('is-me', isMe(m.b));
  });
  el.qprogress.textContent = `${c.scored}/${c.matches.length}`;

  // Rangliste
  mount(el.table, h('table', { class: 'ranking ranking--compact tn-ranking' },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', text: '#' }), h('th', { scope: 'col', text: 'CALLSIGN' }),
      h('th', { scope: 'col', class: 'num tn-opt', text: 'SP' }), h('th', { scope: 'col', class: 'num', text: 'S-U-N' }),
      h('th', { scope: 'col', class: 'num', text: '+/-' }), h('th', { scope: 'col', class: 'num', text: 'PKT' }))),
    h('tbody', {}, c.table.map((r) => h('tr', { class: `${r.pos <= 4 ? `is-top is-top-${r.pos} tn-qualified` : 'tn-out'}${isMe(r.name) ? ' is-me' : ''}` },
      h('td', { class: 'pos', text: String(r.pos) }),
      h('td', { class: 'name' }, r.name, r.pos > 4 && c.complete ? h('span', { class: 'tn-tag', text: ' OUT' }) : null),
      h('td', { class: 'num tn-opt', text: String(r.played) }),
      h('td', { class: 'num', text: `${r.w}-${r.d}-${r.l}` }),
      h('td', { class: 'num', text: `${r.rf - r.ra > 0 ? '+' : ''}${r.rf - r.ra}` }),
      h('td', { class: 'num tn-pts', text: String(r.pts) }))))));

  // Playoffs
  const placeholders = {
    sf1: ['PLATZ 1 QUALI', 'PLATZ 4 QUALI'], sf2: ['PLATZ 2 QUALI', 'PLATZ 3 QUALI'],
    final: ['SIEGER HF 1', 'SIEGER HF 2'], third: ['VERLIERER HF 1', 'VERLIERER HF 2'],
  };
  for (const k of Object.keys(KO)) {
    const res = c[k === 'third' ? 'third' : k];
    const parts = el.ko[k];
    for (const side of ['a', 'b']) {
      const slot = parts[side];
      const name = res[side];
      const score = res[side === 'a' ? 'sa' : 'sb'];
      slot.nameText.textContent = name || placeholders[k][side === 'a' ? 0 : 1];
      slot.nameText.classList.toggle('is-empty', !name);
      slot.scoreText.textContent = has(score) ? String(score) : '';
      if (document.activeElement !== slot.input) slot.input.value = has(score) ? String(score) : '';
      slot.input.disabled = !(res.a && res.b);
      slot.row.classList.toggle('is-winner', res.side === side);
      slot.row.classList.toggle('is-loser', res.side !== null && res.side !== side);
      slot.row.classList.toggle('is-me', isMe(name));
    }
    parts.card.classList.toggle('is-decided', !!res.winner);
    parts.card.classList.toggle('is-ready', !!(res.a && res.b) && !res.winner);
  }
  el.champName.textContent = c.final.winner || '—';
  el.champion.classList.toggle('is-crowned', !!c.final.winner);

  const labels = ['CHAMPION', 'FINALIST', 'PLATZ 3', 'PLATZ 4'];
  mount(el.standings, c.placements.slice(0, Math.max(4, n)).map((name, i) => h('li', { class: `tn-standings__item${name ? '' : ' is-open'}${i === 0 && name ? ' is-champ' : ''}${isMe(name) ? ' is-me' : ''}` },
    h('span', { class: 'tn-standings__pos', text: `${i + 1}.` }),
    h('span', { class: 'tn-standings__name', text: name || '—' }),
    h('span', { class: 'tn-standings__tag', text: labels[i] || 'QUALI' }))));

  const phase = c.final.winner ? `CHAMPION // ${c.final.winner.toUpperCase()}`
    : c.complete ? 'PLAYOFFS' : `QUALIFIKATION ${c.scored}/${c.matches.length}`;
  el.status.textContent = `STATUS: ${c.finished ? 'TOURNAMENT COMPLETE' : phase} // ${TEXT.eventDate}`;

  // Turnier beendet → einmal automatisch zur Ergebnis-Seite wechseln
  const doneKey = c.finished ? c.placements.join('|') : '';
  if (doneKey && doneKey !== finishKey) viewMode = 'finish';
  finishKey = doneKey;
  if (!c.finished) viewMode = 'bracket';
  const showFinish = c.finished && viewMode === 'finish';
  el.finish.hidden = !showFinish;
  el.board.hidden = showFinish;
  el.viewToggle.hidden = !c.finished;
  el.viewToggle.textContent = showFinish ? '◂ BRACKET ANZEIGEN' : 'LEADERBOARD ▸';
  el.viewToggle.classList.toggle('btn--primary', !showFinish);
  el.viewToggle.classList.toggle('btn--ghost', showFinish);
  if (showFinish) renderFinish(c);
  requestAnimationFrame(drawLines);
}

// Ergebnis-Seite – nur neu aufbauen, wenn sich das Ergebnis ändert
// (sonst würden Podium/Rangliste bei jedem Live-Update neu einfliegen)
function renderFinish(c) {
  const rows = c.placements.filter(Boolean).map((name, i) => {
    const t = c.total[name] || { w: 0, d: 0, l: 0, rf: 0, ra: 0 };
    const q = c.table.find((r) => r.name === name);
    return { name, pos: i + 1, ...t, diff: t.rf - t.ra, qpts: q ? q.pts : 0, qpos: q ? q.pos : null };
  });
  const sig = JSON.stringify(rows);
  if (sig === finishSig && el.finish.childElementCount) return;
  const first = !finishSig;
  finishSig = sig;
  const result = ['CHAMPION', 'FINALIST', 'PLATZ 3', 'PLATZ 4'];
  const slot = (r, place) => (r
    ? h('div', { class: `podium__slot podium__slot--${place}` },
        place === 1 ? h('p', { class: 'top-operator', text: 'TOP OPERATOR' }) : null,
        h('p', { class: 'podium__name', text: r.name }),
        h('p', { class: 'podium__pts', text: `${r.w}-${r.d}-${r.l} // ${r.diff > 0 ? '+' : ''}${r.diff}` }),
        h('div', { class: 'podium__block' }, h('span', { text: `#${place}` })))
    : h('div', { class: `podium__slot podium__slot--${place} is-empty` }, h('div', { class: 'podium__block' }, h('span', { text: `#${place}` }))));
  mount(el.finish,
    h('header', { class: 'tn-finish__head' },
      h('p', { class: 'eyebrow', text: 'TACTICAL DUEL BRACKET // TOURNAMENT COMPLETE' }),
      h('h2', { class: 'tn-finish__title', text: 'MISSION ACCOMPLISHED' })),
    h('div', { class: 'podium', role: 'list', 'aria-label': 'Siegerpodium' },
      h('div', { role: 'listitem' }, slot(rows[1], 2)),
      h('div', { role: 'listitem' }, slot(rows[0], 1)),
      h('div', { role: 'listitem' }, slot(rows[2], 3))),
    h('p', { class: 'br-col tn-label', text: 'LEADERBOARD // ALLE DUELLE (QUALI + PLAYOFFS)' }),
    h('table', { class: 'ranking ranking--compact tn-leaderboard' },
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col', text: 'PLATZ' }), h('th', { scope: 'col', text: 'CALLSIGN' }),
        h('th', { scope: 'col', text: 'ERGEBNIS' }), h('th', { scope: 'col', class: 'num', text: 'S-U-N', title: 'Duelle gesamt: Siege-Unentschieden-Niederlagen' }),
        h('th', { scope: 'col', class: 'num tn-opt', text: 'RUNDEN' }), h('th', { scope: 'col', class: 'num tn-opt', text: '+/-' }),
        h('th', { scope: 'col', class: 'num tn-opt', text: 'QUALI' }))),
      h('tbody', {}, rows.map((r) => h('tr', { class: `${r.pos <= 3 ? `is-top is-top-${r.pos}` : ''}${isMe(r.name) ? ' is-me' : ''}` },
        h('td', { class: 'pos', text: `#${r.pos}` }),
        h('td', { class: 'name', text: r.name }),
        h('td', { class: 'tn-result', text: result[r.pos - 1] || 'OUT (QUALI)' }),
        h('td', { class: 'num', text: `${r.w}-${r.d}-${r.l}` }),
        h('td', { class: 'num tn-opt', text: `${r.rf}:${r.ra}` }),
        h('td', { class: 'num tn-opt', text: `${r.diff > 0 ? '+' : ''}${r.diff}` }),
        h('td', { class: 'num tn-opt', text: r.qpos ? `${r.qpos}. // ${r.qpts} PKT` : '–' }))))));
  el.finish.classList.toggle('is-entering', first);
}

// Linien: Sieger (durchgezogen) Richtung Finale/Champion, Verlierer der
// Halbfinals (gestrichelt) ins Lower Bracket
function drawLines() {
  const svg = el.svg;
  if (!svg || !el.ko.root || el.board.hidden) return;
  while (svg.firstChild) svg.firstChild.remove();
  if (getComputedStyle(svg).display === 'none') return;
  const box = el.ko.root.getBoundingClientRect();
  svg.setAttribute('width', String(box.width));
  svg.setAttribute('height', String(box.height));
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  if (!server) return;
  const c = compute(server, local);
  const rel = (r) => ({ left: r.left - box.left, right: r.right - box.left, mid: (r.top + r.bottom) / 2 - box.top, bottom: r.bottom - box.top, cx: (r.left + r.right) / 2 - box.left });
  const add = (d, cls, x, y) => {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', cls);
    svg.append(path);
    if (x !== undefined) {
      const dot = document.createElementNS(SVG, 'circle');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(y));
      dot.setAttribute('r', '3.5');
      dot.setAttribute('class', cls.includes('is-active') ? 'br-dot is-active' : 'br-dot');
      svg.append(dot);
    }
  };
  const elbow = (from, to, active, cls = 'br-line') => {
    const a = rel(from.getBoundingClientRect());
    const b = rel(to.getBoundingClientRect());
    const xm = a.right + (b.left - a.right) / 2;
    add(`M${a.right} ${a.mid} H${xm} V${b.mid} H${b.left}`, `${cls}${active ? ' is-active' : ''}`, b.left, b.mid);
  };
  const K = el.ko;
  elbow(K.sf1.card, K.final.a.row, !!c.sf1.winner);
  elbow(K.sf2.card, K.final.b.row, !!c.sf2.winner);
  elbow(K.final.card, el.champion, !!c.final.winner);
  // Verlierer → Platz 3 (von unten in die Lower-Bracket-Karte)
  const t = rel(K.third.card.getBoundingClientRect());
  for (const [key, row, active] of [['sf1', K.third.a.row, !!c.sf1.loser], ['sf2', K.third.b.row, !!c.sf2.loser]]) {
    const a = rel(K[key].card.getBoundingClientRect());
    const b = rel(row.getBoundingClientRect());
    const x = t.left - 18 - (key === 'sf1' ? 10 : 0);
    add(`M${a.right} ${a.mid + (key === 'sf1' ? 10 : -10)} H${x} V${b.mid} H${b.left}`, `br-line br-line--lower${active ? ' is-active' : ''}`, b.left, b.mid);
  }
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
    toggle.addEventListener('click', () => { editing = !editing; setupOpen = false; renderToolbar(); if (!editing && server) applyServer(server); render(); });
    const logout = h('button', { type: 'button', class: 'btn btn--tiny' }, 'LOGOUT');
    logout.addEventListener('click', async () => { await commanderLogout(); commander = false; editing = false; setupOpen = false; renderToolbar(); render(); });
    mount(cmdArea, toggle, logout);
  }
  document.body.classList.toggle('is-editing', editing);
  render();
  requestAnimationFrame(drawLines);
}

async function loadAccounts() {
  try {
    accounts = await rpc('accounts_public');
    if (el.setup && !el.setup.hidden) renderAccChips();
  } catch { /* egal */ }
}

function renderAccChips() {
  if (!el.accChips) return;
  const used = new Set(setupNames().map(norm));
  mount(el.accChips, accounts.length
    ? accounts.map((a) => {
        const taken = used.has(norm(a.username));
        const chip = h('button', { type: 'button', class: `tn-acc__chip${a.checked_in ? ' is-in' : ''}`, disabled: taken, title: a.checked_in ? 'eingecheckt' : 'nicht eingecheckt' },
          h('span', { class: 'led', 'aria-hidden': 'true' }), a.username, taken ? ' ✓' : '');
        chip.addEventListener('click', () => {
          const slot = el.setupInputs.find((x) => !x.value.trim());
          if (!slot) { toast('MAXIMAL 8 OPERATOREN'); return; }
          slot.value = a.username;
          updateSetupCount();
          renderAccChips();
        });
        return chip;
      })
    : h('p', { class: 'muted', text: 'Noch keine registrierten Accounts – Namen einfach eintippen.' }));
}

async function takeCheckedIn() {
  const names = accounts.filter((a) => a.checked_in).map((a) => a.username).slice(0, 8);
  if (!names.length) { toast('NOCH NIEMAND EINGECHECKT (MISSION OPS)'); return; }
  if (setupNames().length) {
    const yes = await confirmDialog({ title: 'EINGECHECKTE ÜBERNEHMEN?', text: `Die Liste wird ersetzt durch: ${names.join(', ')}`, confirmLabel: 'ÜBERNEHMEN' });
    if (!yes) return;
  }
  el.setupInputs.forEach((input, i) => { input.value = names[i] || ''; });
  updateSetupCount();
  renderAccChips();
}

function fillSetupInputs() {
  const players = server ? server.players : [];
  el.setupInputs.forEach((input, i) => { input.value = players[i] || ''; });
  updateSetupCount();
}

function setupNames() {
  return el.setupInputs.map((x) => x.value.trim()).filter(Boolean);
}

function updateSetupCount() {
  const n = setupNames().length;
  el.setupCount.textContent = n < 4 ? `${n} OPERATOREN – MINDESTENS 4` : `${n} OPERATOREN // ${n} QUALI-DUELLE`;
  el.setupCount.dataset.kind = n < 4 ? 'error' : 'ok';
}

function setSaveState(text, kind = '') {
  el.saveState.textContent = text;
  el.saveState.dataset.kind = kind;
}

function tokenOrLogout() {
  const token = getToken();
  if (!token) { commander = false; editing = false; renderToolbar(); }
  return token;
}

function handleError(e) {
  if (e.code === 'HOST_UNAUTHORIZED') {
    clearToken();
    commander = false;
    editing = false;
    renderToolbar();
  }
  toast(e.code === 'PLAYERS_COUNT' ? '4–8 OPERATOREN EINTRAGEN' : errorText(e.code), 'error');
}

async function submitPlayers(andDraw) {
  const names = setupNames();
  if (andDraw && names.length < 4) { toast('MINDESTENS 4 OPERATOREN EINTRAGEN', 'error'); return; }
  const anyScore = local.qual.some(has) || local.ko.some(has);
  if (server && server.pairs.length && anyScore) {
    const yes = await confirmDialog({ title: 'TURNIER NEU STARTEN?', text: 'Die bisherige Auslosung und alle Resultate werden gelöscht.', confirmLabel: 'NEU STARTEN', danger: true });
    if (!yes) return;
  }
  const token = tokenOrLogout();
  if (!token) return;
  clearTimeout(saveTimer);
  try {
    let res = await rpc('tournament_set_players', { p_token: token, p_players: names });
    if (andDraw) res = await rpc('tournament_draw', { p_token: token });
    setupOpen = false;
    server = null;
    applyServer(res);
    toast(andDraw ? 'OPERATOREN AUSGELOST – TURNIER LÄUFT' : 'OPERATOREN GESPEICHERT');
  } catch (e) {
    handleError(e);
  }
}

async function redrawTournament() {
  const yes = await confirmDialog({ title: 'NEU AUSLOSEN?', text: 'Neue zufällige Quali-Paarungen. Alle Resultate werden gelöscht.', confirmLabel: 'AUSLOSEN', danger: true });
  if (!yes) return;
  const token = tokenOrLogout();
  if (!token) return;
  clearTimeout(saveTimer);
  try {
    const res = await rpc('tournament_draw', { p_token: token });
    server = null;
    applyServer(res);
    toast('NEU AUSGELOST');
  } catch (e) {
    handleError(e);
  }
}

async function clearAllScores() {
  const yes = await confirmDialog({ title: 'RESULTATE LÖSCHEN?', text: 'Alle Scores werden gelöscht, die Auslosung bleibt.', confirmLabel: 'LÖSCHEN', danger: true });
  if (!yes) return;
  const token = tokenOrLogout();
  if (!token) return;
  clearTimeout(saveTimer);
  try {
    const res = await rpc('tournament_clear_scores', { p_token: token });
    dirty = false;
    server = res;
    local = { qual: [...res.qual_scores], ko: [...res.ko_scores] };
    render();
    setSaveState('GESPEICHERT ✓', 'ok');
  } catch (e) {
    handleError(e);
  }
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
  const token = tokenOrLogout();
  if (!token) return;
  saving = true;
  dirty = false;
  setSaveState('SPEICHERN …');
  try {
    const res = await rpc('tournament_save_scores', { p_token: token, p_qual: local.qual, p_ko: local.ko });
    server = res;
    setSaveState('GESPEICHERT ✓', 'ok');
    if (!dirty) { local = { qual: [...res.qual_scores], ko: [...res.ko_scores] }; render(); }
  } catch (e) {
    dirty = true;
    setSaveState(errorText(e.code), 'error');
    if (e.code === 'HOST_UNAUTHORIZED') handleError(e);
    else if (e.network) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 2000); }
  } finally {
    saving = false;
  }
}

init();
