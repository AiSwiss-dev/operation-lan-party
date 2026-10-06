// =====================================================================
//  GAME COUNTER (counter.html) – Team-Bilanz + CS-Stats für das 5er-Team
//  Alle sehen live mit. Matches und Team trägt der Commander ein, die
//  CS-Stats (K/A/D, HS %, ADR, MVPs) trägt jeder Spieler selbst ein.
// =====================================================================

import { configStatus, rpc, watchTables } from './supabase-client.js';
import { h, mount, errorText, confirmDialog, toast } from './utils.js';
import { createSync } from './sync.js';
import { setNetBanner, setLinkLed, renderConfigError, coordLine, stamp } from './ui.js';
import { checkCommander, commanderLogin, commanderLogout, getToken, clearToken } from './commander.js';
import { getAccount, clearAccount, norm, startHeartbeat } from './account.js';
import { initGate } from './gate.js';
import { aggregate, leaderboardTable, scoreboard, statsDialog } from './stats.js';

const app = document.getElementById('app');
const cmdArea = document.getElementById('cmd-area');
const MAPS = ['Ancient', 'Anubis', 'Dust II', 'Inferno', 'Mirage', 'Nuke', 'Overpass', 'Train', 'Vertigo'];
const RESULT = {
  W: { label: 'SIEG', short: 'W', cls: 'is-win' },
  L: { label: 'NIEDERLAGE', short: 'L', cls: 'is-loss' },
  T: { label: 'UNENTSCHIEDEN', short: 'T', cls: 'is-tie' },
};

let state = null;
let commander = false;
let editing = false;
let busy = false;
let sync = null;
let sortKey = 'kd';
let accounts = [];
const expanded = new Set();
const el = {};

// ---------------------------------------------------------------------
async function init() {
  if (!configStatus.ok) {
    renderConfigError(app, configStatus);
    return;
  }
  startHeartbeat();
  initGate();
  buildSkeleton();
  loadAccounts();
  setInterval(loadAccounts, 30000);
  commander = await checkCommander();
  editing = commander;
  renderToolbar();

  sync = createSync({
    fetchState: () => rpc('counter_state'),
    onState: (s) => { state = s; render(); },
    onError: (e) => toast(errorText(e.code), 'error'),
    onConnection: (ok) => setNetBanner(!ok),
    onLink: setLinkLed,
  });
  watchTables(['counter_team', 'counter_matches', 'counter_stats'], {
    onChange: () => sync.realtimeEvent(),
    onLive: (live) => sync.setSubscribed(live),
  });
  sync.refresh();
}

// ---------------------------------------------------------------------
// Grundgerüst (einmal), danach werden nur die Inhalte aktualisiert
// ---------------------------------------------------------------------
function buildSkeleton() {
  el.teamName = h('h1', { class: 'title title--xl cnt-team', text: '…' });
  el.roster = h('ul', { class: 'cnt-roster', 'aria-label': 'Team' });
  el.wins = h('span', { class: 'cnt-score__num' }, '0');
  el.losses = h('span', { class: 'cnt-score__num' }, '0');
  el.ties = h('span', { class: 'cnt-score__num' }, '0');
  el.winrate = h('dd', {}, '–');
  el.streak = h('dd', {}, '–');
  el.played = h('dd', {}, '0');
  el.form = h('ol', { class: 'cnt-form', 'aria-label': 'Letzte Matches' });
  el.editor = buildEditor();
  el.maps = h('div', { class: 'cnt-maps' });
  el.log = h('ol', { class: 'cnt-log' });
  el.mine = h('div', { class: 'cnt-mine', 'aria-live': 'polite' });
  el.leader = h('div', { class: 'stats-wrap' });

  mount(app,
    h('section', { class: 'card cnt-hero' },
      stamp('CLASSIFIED'),
      h('p', { class: 'eyebrow', text: '5-MAN SQUAD // CS2 COMPETITIVE // NJORGIBICEPS' }),
      el.teamName,
      el.roster,
      h('div', { class: 'stripes', 'aria-hidden': 'true' }),
      h('div', { class: 'cnt-score', role: 'group', 'aria-label': 'Bilanz' },
        h('div', { class: 'cnt-score__box is-win' }, el.wins, h('span', { class: 'cnt-score__label', text: 'WINS' })),
        h('div', { class: 'cnt-score__box is-loss' }, el.losses, h('span', { class: 'cnt-score__label', text: 'LOSSES' })),
        h('div', { class: 'cnt-score__box is-tie' }, el.ties, h('span', { class: 'cnt-score__label', text: 'TIES' }))),
      h('dl', { class: 'facts facts--triple' },
        h('div', {}, h('dt', { text: 'WINRATE' }), el.winrate),
        h('div', {}, h('dt', { text: 'SERIE' }), el.streak),
        h('div', {}, h('dt', { text: 'MATCHES' }), el.played)),
      h('div', { class: 'cnt-form-wrap' }, h('span', { class: 'panel__label', text: 'FORM (LETZTE 10)' }), el.form)),
    el.mine,
    el.editor,
    h('section', { class: 'card stats-card' },
      h('h2', { class: 'section-title', text: 'SQUAD LEADERBOARD // CS-STATS' }),
      h('p', { class: 'field__hint', text: 'Summe bzw. Durchschnitt aller Matches mit eingetragenen Stats. Spaltenkopf antippen zum Sortieren.' }),
      el.leader),
    h('div', { class: 'cnt-grid' },
      h('section', { class: 'card' }, h('h2', { class: 'section-title', text: 'MAP-BILANZ' }), el.maps),
      h('section', { class: 'card' }, h('h2', { class: 'section-title', text: 'MATCH-LOG' }), el.log)),
    coordLine('GAME COUNTER'));
}

function buildEditor() {
  // Match eintragen
  el.mapInput = h('input', { id: 'cnt-map', class: 'input', list: 'cnt-map-list', maxlength: '24', placeholder: 'z. B. Dust II', autocomplete: 'off' });
  const mapList = h('datalist', { id: 'cnt-map-list' }, MAPS.map((m) => h('option', { value: m })));
  el.scoreUs = h('input', { id: 'cnt-us', class: 'input input--score', type: 'number', inputmode: 'numeric', min: '0', max: '99', placeholder: 'WIR', 'aria-label': 'Runden Team' });
  el.scoreThem = h('input', { id: 'cnt-them', class: 'input input--score', type: 'number', inputmode: 'numeric', min: '0', max: '99', placeholder: 'GEGNER', 'aria-label': 'Runden Gegner' });
  el.addBtns = {};
  for (const key of ['W', 'L', 'T']) {
    el.addBtns[key] = h('button', { type: 'button', class: `btn cnt-add ${RESULT[key].cls}`, dataset: { result: key } }, `+ ${RESULT[key].label}`);
    el.addBtns[key].addEventListener('click', () => addMatch(key));
  }
  el.scoreHint = h('p', { class: 'field__hint' }, 'Map und Score sind optional. Mit Score wird das Ergebnis automatisch bestimmt.');
  for (const input of [el.scoreUs, el.scoreThem]) input.addEventListener('input', updateAddButtons);

  // Team
  el.teamInput = h('input', { id: 'cnt-team', class: 'input', maxlength: '32', autocomplete: 'off' });
  el.rosterInputs = [0, 1, 2, 3, 4].map((i) => h('input', { class: 'input', maxlength: '24', autocomplete: 'off', list: 'cnt-accounts', placeholder: `OPERATOR ${i + 1}`, 'aria-label': `Operator ${i + 1}` }));
  el.accountList = h('datalist', { id: 'cnt-accounts' });
  el.rosterHint = h('p', { class: 'field__hint' });
  const saveTeam = h('button', { type: 'button', class: 'btn btn--ghost' }, 'TEAM SPEICHERN');
  saveTeam.addEventListener('click', () => act((t) => rpc('counter_set_team', {
    p_token: t, p_name: el.teamInput.value, p_roster: el.rosterInputs.map((x) => x.value),
  }), 'TEAM GESPEICHERT'));
  for (const input of [el.teamInput, ...el.rosterInputs]) input.addEventListener('input', () => { input.dataset.dirty = '1'; });

  const reset = h('button', { type: 'button', class: 'btn btn--danger-ghost' }, 'BILANZ ZURÜCKSETZEN');
  reset.addEventListener('click', async () => {
    const yes = await confirmDialog({ title: 'BILANZ WIRKLICH ZURÜCKSETZEN?', text: 'Alle eingetragenen Matches werden gelöscht. Team und Operatoren bleiben erhalten.', confirmLabel: 'ZURÜCKSETZEN', danger: true });
    if (yes) act((t) => rpc('counter_reset', { p_token: t }), 'BILANZ ZURÜCKGESETZT');
  });

  return h('section', { class: 'card cnt-editor', hidden: true, 'aria-label': 'Commander: Bilanz bearbeiten' },
    h('p', { class: 'eyebrow', text: 'COMMANDER // MATCH EINTRAGEN' }),
    h('div', { class: 'cnt-editor__row' },
      h('div', { class: 'field cnt-editor__map' }, h('label', { for: 'cnt-map', class: 'field__label' }, 'MAP'), el.mapInput, mapList),
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'SCORE (RUNDEN)'),
        h('div', { class: 'cnt-scorepair' }, el.scoreUs, h('span', { class: 'cnt-colon', 'aria-hidden': 'true' }, ':'), el.scoreThem))),
    el.scoreHint,
    h('div', { class: 'cnt-addrow' }, el.addBtns.W, el.addBtns.L, el.addBtns.T),
    h('details', { class: 'cnt-team-edit' },
      h('summary', {}, 'TEAM & OPERATOREN BEARBEITEN'),
      h('div', { class: 'form' },
        h('div', { class: 'field' }, h('label', { for: 'cnt-team', class: 'field__label' }, 'TEAMNAME'), el.teamInput),
        h('div', { class: 'cnt-roster-inputs' }, el.rosterInputs, el.accountList),
        el.rosterHint,
        h('div', { class: 'cnt-editor__actions' }, saveTeam, reset))));
}

// ---------------------------------------------------------------------
// Commander-Leiste oben rechts
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
    toggle.addEventListener('click', () => { editing = !editing; renderToolbar(); render(); });
    const logout = h('button', { type: 'button', class: 'btn btn--tiny' }, 'LOGOUT');
    logout.addEventListener('click', async () => { await commanderLogout(); commander = false; editing = false; renderToolbar(); render(); });
    mount(cmdArea, toggle, logout);
  }
  document.body.classList.toggle('is-editing', editing);
  if (el.editor) el.editor.hidden = !editing;
}

// ---------------------------------------------------------------------
// Anzeige
// ---------------------------------------------------------------------
function streakText(matches) {
  if (!matches.length) return '–';
  const first = matches[0].result;
  let n = 0;
  for (const m of matches) { if (m.result === first) n++; else break; }
  const word = { W: n === 1 ? 'SIEG' : 'SIEGE', L: n === 1 ? 'NIEDERLAGE' : 'NIEDERLAGEN', T: 'REMIS' }[first];
  return `${n} ${word}`;
}

function timeLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const hhmm = d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? hhmm : `${d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })} ${hhmm}`;
}

function render() {
  if (!state) return;
  const { team, totals, matches } = state;
  const played = totals.wins + totals.losses + totals.ties;

  el.teamName.textContent = team.name;
  const roster = team.roster.filter((n) => n);
  const rosterKey = `${editing}|${roster.join('|')}`;
  if (el.rosterKey !== rosterKey) {
    el.rosterKey = rosterKey;
    mount(el.roster, roster.length
    ? roster.map((n) => h('li', { class: 'chip cnt-roster__item' }, h('span', { class: 'roster__dot', 'aria-hidden': 'true' }), h('span', { class: 'chip__name', text: n })))
    : h('li', { class: 'muted', text: editing ? 'Operatoren unten unter „TEAM & OPERATOREN BEARBEITEN“ eintragen.' : '5 OPERATORS DEPLOYED' }));
  }

  el.wins.textContent = String(totals.wins);
  el.losses.textContent = String(totals.losses);
  el.ties.textContent = String(totals.ties);
  el.winrate.textContent = played ? `${Math.round((totals.wins / played) * 100)} %` : '–';
  el.streak.textContent = streakText(matches);
  el.played.textContent = String(played);

  const last10 = matches.slice(0, 10).reverse();
  mount(el.form, last10.length
    ? last10.map((m) => h('li', { class: `cnt-form__dot ${RESULT[m.result].cls}`, title: RESULT[m.result].label, text: RESULT[m.result].short }))
    : h('li', { class: 'muted', text: 'Noch keine Matches' }));

  // Map-Bilanz
  const byMap = new Map();
  for (const m of matches) {
    const key = m.map || '—';
    const row = byMap.get(key) || { map: key, W: 0, L: 0, T: 0 };
    row[m.result] += 1;
    byMap.set(key, row);
  }
  const rows = [...byMap.values()].sort((a, b) => (b.W + b.L + b.T) - (a.W + a.L + a.T) || b.W - a.W);
  mount(el.maps, rows.length
    ? h('table', { class: 'ranking cnt-maptable' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col', text: 'MAP' }), h('th', { scope: 'col', class: 'num', text: 'W' }),
          h('th', { scope: 'col', class: 'num', text: 'L' }), h('th', { scope: 'col', class: 'num', text: 'T' }),
          h('th', { scope: 'col', class: 'num', text: 'WINRATE' }))),
        h('tbody', {}, rows.map((r) => {
          const n = r.W + r.L + r.T;
          return h('tr', {},
            h('td', { class: 'name', text: r.map === '—' ? 'OHNE MAP' : r.map }),
            h('td', { class: 'num cnt-w', text: String(r.W) }),
            h('td', { class: 'num cnt-l', text: String(r.L) }),
            h('td', { class: 'num cnt-t', text: String(r.T) }),
            h('td', { class: 'num', text: `${Math.round((r.W / n) * 100)} %` }));
        })))
    : h('p', { class: 'muted', text: 'Noch keine Matches eingetragen.' }));

  // CS-Stats: eigene offene Matches, Leaderboard
  const stats = state.stats || [];
  const me = getAccount();
  const rosterNames = team.roster.filter(Boolean);
  const inTeam = !!(me && rosterNames.some((n) => norm(n) === norm(me.username)));
  const myStats = (matchId) => (me ? stats.find((x) => x.match_id === matchId && norm(x.player) === norm(me.username)) : null);
  renderMine(me, inTeam, matches.filter((m) => !myStats(m.id)));
  mount(el.leader, rosterNames.length
    ? leaderboardTable(aggregate(team.roster, stats), sortKey, (k) => { sortKey = k; render(); }, me && me.username)
    : h('p', { class: 'muted', text: 'Zuerst das 5er-Team eintragen (Commander).' }));

  // Match-Log mit Scoreboard pro Match
  mount(el.log, matches.length
    ? matches.slice(0, 50).map((m, i) => {
        const del = editing ? h('button', { type: 'button', class: 'chip__remove', 'aria-label': `Match ${matches.length - i} löschen`, title: 'Match löschen' }, '×') : null;
        if (del) del.addEventListener('click', () => deleteMatch(m));
        const filled = rosterNames.filter((n) => stats.some((x) => x.match_id === m.id && norm(x.player) === norm(n))).length;
        const open = expanded.has(m.id);
        const toggle = h('button', { type: 'button', class: `cnt-log__stats${filled < rosterNames.length ? ' is-open' : ''}`, 'aria-expanded': open ? 'true' : 'false', title: 'Scoreboard anzeigen' },
          `STATS ${filled}/${rosterNames.length} ${open ? '▴' : '▾'}`);
        toggle.addEventListener('click', () => { if (expanded.has(m.id)) expanded.delete(m.id); else expanded.add(m.id); render(); });
        const mine = myStats(m.id);
        const myBtn = inTeam ? h('button', { type: 'button', class: `btn btn--small ${mine ? 'btn--ghost' : 'btn--primary'}` }, mine ? 'MEINE STATS ÄNDERN' : 'MEINE STATS EINTRAGEN') : null;
        if (myBtn) myBtn.addEventListener('click', () => openStats(m, mine));
        return h('li', { class: `cnt-log__item ${RESULT[m.result].cls}`, dataset: { match: String(m.id) } },
          h('div', { class: 'cnt-log__row' },
            h('span', { class: 'cnt-log__badge', text: RESULT[m.result].short }),
            h('span', { class: 'cnt-log__main' },
              h('b', { text: RESULT[m.result].label }),
              m.map ? h('span', { class: 'cnt-log__map', text: ` // ${m.map}` }) : null),
            h('span', { class: 'cnt-log__score', text: m.score_us !== null && m.score_us !== undefined ? `${m.score_us}:${m.score_them}` : '' }),
            h('span', { class: 'cnt-log__time', text: timeLabel(m.at_ms) }),
            rosterNames.length ? toggle : null,
            del),
          open ? h('div', { class: 'cnt-log__board' }, scoreboard(team.roster, stats, m.id, me && me.username), myBtn) : null);
      })
    : h('li', { class: 'muted', text: editing ? 'Erstes Match oben eintragen.' : 'Noch keine Matches eingetragen.' }));

  // Hinweis im Team-Editor: welche Namen haben (noch) keinen Account?
  const known = new Set(accounts.map((a) => norm(a.username)));
  const missing = rosterNames.filter((n) => !known.has(norm(n)));
  el.rosterHint.textContent = missing.length
    ? `Ohne Account (können keine Stats eintragen): ${missing.join(', ')}. Tipp: Namen aus den registrierten Accounts wählen.`
    : 'Die Team-Spieler tragen ihre Stats nach jedem Match selbst ein (Login nötig).';

  // Editor-Felder mit Serverwerten füllen (nicht während des Tippens)
  if (editing) {
    if (!el.teamInput.dataset.dirty && document.activeElement !== el.teamInput) el.teamInput.value = team.name;
    el.rosterInputs.forEach((input, i) => {
      if (!input.dataset.dirty && document.activeElement !== input) input.value = team.roster[i] || '';
    });
  }
  updateAddButtons();
}

// Banner oben: eigene offene Stats bzw. Login-Hinweis
function renderMine(me, inTeam, pending) {
  if (!me) {
    mount(el.mine, h('p', { class: 'cnt-mine__hint' }, 'Team-Spieler: ', h('a', { href: './login.html?return=counter.html' }, 'EINLOGGEN'), ' und die eigenen CS-Stats nach jedem Match eintragen.'));
    return;
  }
  if (!inTeam) {
    mount(el.mine, h('p', { class: 'cnt-mine__hint', text: `Eingeloggt als ${me.username} – nicht im 5er-Team, daher keine Stats-Eingabe.` }));
    return;
  }
  if (!pending.length) {
    mount(el.mine, h('p', { class: 'cnt-mine__hint is-ok', text: `${me.username}: alle deine Stats sind eingetragen. ✓` }));
    return;
  }
  const next = pending[0];
  const btn = h('button', { type: 'button', class: 'btn btn--primary' }, `JETZT EINTRAGEN: ${RESULT[next.result].label}${next.map ? ` // ${next.map}` : ''}${next.score_us !== null && next.score_us !== undefined ? ` ${next.score_us}:${next.score_them}` : ''}`);
  btn.addEventListener('click', () => openStats(next, null));
  mount(el.mine, h('div', { class: 'cnt-mine__todo' },
    h('p', { class: 'eyebrow', text: `${me.username} // ${pending.length} ${pending.length === 1 ? 'MATCH' : 'MATCHES'} OHNE DEINE STATS` }),
    btn));
}

function openStats(m, existing) {
  const me = getAccount();
  if (!me) { window.location.href = './login.html?return=counter.html'; return; }
  statsDialog({
    title: `MEINE STATS // ${RESULT[m.result].label}${m.map ? ` // ${m.map}` : ''}${m.score_us !== null && m.score_us !== undefined ? ` ${m.score_us}:${m.score_them}` : ''}`,
    existing,
    onSubmit: async (v, setError) => {
      try {
        state = await rpc('counter_submit_stats', {
          p_token: me.token, p_match_id: m.id, p_kills: v.kills, p_deaths: v.deaths, p_assists: v.assists,
          p_hs_pct: v.hs, p_adr: v.adr, p_mvps: v.mvps,
        });
        expanded.add(m.id);
        render();
        toast('STATS GESPEICHERT');
        return true;
      } catch (e) {
        if (e.code === 'ACCOUNT_UNAUTHORIZED') { clearAccount(); setError('LOGIN ABGELAUFEN – BITTE NEU EINLOGGEN'); return false; }
        setError(e.code === 'NOT_IN_TEAM' ? 'DU BIST NICHT IM 5ER-TEAM' : errorText(e.code));
        return false;
      }
    },
  });
}

async function loadAccounts() {
  try {
    accounts = await rpc('accounts_public');
    mount(el.accountList, accounts.map((a) => h('option', { value: a.username })));
  } catch { /* egal */ }
}

// Mit Score: nur der passende Ergebnis-Button ist aktiv
function scoreValues() {
  const us = el.scoreUs.value.trim();
  const them = el.scoreThem.value.trim();
  if (us === '' && them === '') return { ok: true, us: null, them: null, result: null };
  const a = Number(us);
  const b = Number(them);
  const valid = us !== '' && them !== '' && Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a <= 99 && b <= 99;
  if (!valid) return { ok: false };
  return { ok: true, us: a, them: b, result: a > b ? 'W' : a < b ? 'L' : 'T' };
}

function updateAddButtons() {
  const s = scoreValues();
  for (const [key, btn] of Object.entries(el.addBtns)) {
    btn.disabled = busy || !s.ok || (s.result !== null && s.result !== key);
    btn.classList.toggle('is-suggested', s.result === key);
  }
  el.scoreHint.textContent = !s.ok
    ? 'Score: beide Werte 0–99 eintragen (oder beide leer lassen).'
    : s.result
      ? `${s.us}:${s.them} → ${RESULT[s.result].label}`
      : 'Map und Score sind optional. Mit Score wird das Ergebnis automatisch bestimmt.';
}

// ---------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------
async function act(fn, successText = '') {
  if (busy) return false;
  const token = getToken();
  if (!token) { commander = false; editing = false; renderToolbar(); render(); return false; }
  busy = true;
  updateAddButtons();
  try {
    state = await fn(token);
    if (successText) toast(successText);
    for (const input of [el.teamInput, ...el.rosterInputs]) delete input.dataset.dirty;
    render();
    return true;
  } catch (e) {
    if (e.code === 'HOST_UNAUTHORIZED') {
      clearToken();
      commander = false;
      editing = false;
      renderToolbar();
      render();
    }
    toast(errorText(e.code), 'error');
    return false;
  } finally {
    busy = false;
    updateAddButtons();
  }
}

function addMatch(result) {
  const s = scoreValues();
  if (!s.ok) return;
  const map = el.mapInput.value;
  act((t) => rpc('counter_add_match', { p_token: t, p_result: result, p_map: map, p_score_us: s.us, p_score_them: s.them }),
    `${RESULT[s.result || result].label} EINGETRAGEN`).then((done) => {
    if (!done) return;
    el.scoreUs.value = '';
    el.scoreThem.value = '';
    updateAddButtons();
  });
}

async function deleteMatch(m) {
  const what = `${RESULT[m.result].label}${m.map ? ` auf ${m.map}` : ''}${m.score_us !== null && m.score_us !== undefined ? ` (${m.score_us}:${m.score_them})` : ''}`;
  const yes = await confirmDialog({ title: 'MATCH LÖSCHEN?', text: what, confirmLabel: 'LÖSCHEN', danger: true });
  if (yes) act((t) => rpc('counter_delete_match', { p_token: t, p_id: m.id }), 'MATCH GELÖSCHT');
}

init();
