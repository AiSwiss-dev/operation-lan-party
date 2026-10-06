// =====================================================================
//  MISSION OPS (commander.html) – nur für den Commander
//  Anwesenheit & Check-in, Accounts, Hold-Screen, Überblick
// =====================================================================

import { configStatus, rpc } from './supabase-client.js';
import { h, mount, errorText, confirmDialog, toast } from './utils.js';
import { createSync } from './sync.js';
import { setNetBanner, setLinkLed, renderConfigError, coordLine, stamp } from './ui.js';
import { checkCommander, commanderLogin, commanderLogout, getToken, clearToken } from './commander.js';
import { TEXT } from './questions.js';

const app = document.getElementById('app');
const cmdArea = document.getElementById('cmd-area');
const ONLINE_MS = 150000; // "online" = in den letzten 2,5 Minuten gesehen
const QUIZ_STATUS = { lobby: 'LOBBY', question: 'FRAGE LÄUFT', results: 'ERGEBNIS', phase_break: 'ZWISCHENRANKING' };

let st = null;
let sync = null;
let busy = false;
const el = {};

async function init() {
  if (!configStatus.ok) { renderConfigError(app, configStatus); return; }
  if (await checkCommander()) start();
  else renderLocked();
}

function renderLocked(message = '') {
  if (sync) { sync.stop(); sync = null; }
  mount(cmdArea);
  const login = h('button', { type: 'button', class: 'btn btn--primary btn--block' }, 'COMMANDER LOGIN');
  login.addEventListener('click', async () => { if (await commanderLogin()) start(); });
  mount(app, h('section', { class: 'card card--briefing card--narrow' },
    stamp('RESTRICTED'),
    h('p', { class: 'eyebrow', text: 'OPERATION LAN PARTY // COMMANDER' }),
    h('h1', { class: 'title title--xl', text: 'MISSION OPS' }),
    h('p', { class: 'subtitle', text: 'NUR FÜR DEN COMMANDER' }),
    h('div', { class: 'stripes', 'aria-hidden': 'true' }),
    message ? h('p', { class: 'form-error', role: 'alert', text: message }) : null,
    login,
    coordLine('COMMAND POST')));
}

// ---------------------------------------------------------------------
function start() {
  const logout = h('button', { type: 'button', class: 'btn btn--tiny' }, 'LOGOUT');
  logout.addEventListener('click', async () => { await commanderLogout(); renderLocked(); });
  mount(cmdArea, logout);

  el.tiles = h('div', { class: 'ops-tiles' });
  el.hold = h('div', { class: 'ops-hold' });
  el.list = h('ol', { class: 'ops-list', 'aria-label': 'Operatoren' });
  el.count = h('span', { class: 'count', text: '0' });

  // Account anlegen (bleibt beim Aktualisieren erhalten)
  el.newUser = h('input', { id: 'ops-user', class: 'input', maxlength: '24', autocomplete: 'off', placeholder: 'Benutzername' });
  el.newPass = h('input', { id: 'ops-pass', class: 'input', maxlength: '64', autocomplete: 'off', placeholder: 'Passwort (min. 4)' });
  const create = h('button', { type: 'submit', class: 'btn btn--primary' }, 'ACCOUNT ANLEGEN');
  const createForm = h('form', { class: 'ops-create', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'ops-user', class: 'field__label' }, 'BENUTZERNAME'), el.newUser),
    h('div', { class: 'field' }, h('label', { for: 'ops-pass', class: 'field__label' }, 'PASSWORT'), el.newPass),
    create);
  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = el.newUser.value.trim();
    if (!name || el.newPass.value.length < 4) { toast('NAME UND PASSWORT (MIN. 4 ZEICHEN) EINGEBEN', 'error'); return; }
    if (await act((t) => rpc('ops_create_account', { p_token: t, p_username: name, p_password: el.newPass.value }), `ACCOUNT ${name} ANGELEGT`)) {
      el.newUser.value = '';
      el.newPass.value = '';
      el.newUser.focus();
    }
  });

  const checkAll = h('button', { type: 'button', class: 'btn btn--ghost' }, 'ALLE EINCHECKEN');
  checkAll.addEventListener('click', async () => {
    if (await confirmDialog({ title: 'ALLE EINCHECKEN?', text: 'Alle registrierten Operatoren werden als vor Ort markiert.', confirmLabel: 'ALLE EINCHECKEN' })) {
      act((t) => rpc('ops_checkin_all', { p_token: t, p_checked: true }), 'ALLE EINGECHECKT');
    }
  });
  const checkNone = h('button', { type: 'button', class: 'btn btn--danger-ghost' }, 'ALLE AUSCHECKEN');
  checkNone.addEventListener('click', async () => {
    if (await confirmDialog({ title: 'ALLE AUSCHECKEN?', text: 'Alle Check-ins werden zurückgesetzt.', confirmLabel: 'AUSCHECKEN', danger: true })) {
      act((t) => rpc('ops_checkin_all', { p_token: t, p_checked: false }), 'ALLE AUSGECHECKT');
    }
  });

  mount(app,
    h('section', { class: 'card ops-head' },
      stamp('CLASSIFIED'),
      h('p', { class: 'eyebrow', text: `OPERATION LAN PARTY // COMMANDER // ${TEXT.eventDate} ${TEXT.eventTime}` }),
      h('h1', { class: 'title title--xl', text: 'MISSION OPS' }),
      h('p', { class: 'subtitle', text: 'ATTENDANCE // CHECK-IN // HOLD-SCREEN' }),
      el.tiles),
    h('section', { class: 'card' }, h('h2', { class: 'section-title', text: 'HOLD-SCREEN' }), el.hold),
    h('section', { class: 'card' },
      h('h2', { class: 'section-title' }, 'OPERATORS // ANWESENHEIT ', el.count),
      h('p', { class: 'field__hint', text: 'Check-in macht nur der Commander: Operator vor Ort? → EINCHECKEN. „Online“ = in den letzten 2–3 Minuten auf der Seite.' }),
      h('div', { class: 'ops-bulk' }, checkAll, checkNone),
      el.list),
    h('section', { class: 'card' },
      h('h2', { class: 'section-title', text: 'ACCOUNT VORAB ANLEGEN' }),
      h('p', { class: 'field__hint', text: 'Für Gäste ohne eigenes Handy-Login: Account anlegen und Name + Passwort weitergeben. Jeder kann sich auch selbst unter LOGIN registrieren.' }),
      createForm),
    h('nav', { class: 'ops-links', 'aria-label': 'Weitere Bereiche' },
      h('a', { class: 'btn btn--ghost', href: './host.html' }, 'MISSION CONTROL (QUIZ) ▸'),
      h('a', { class: 'btn btn--ghost', href: './counter.html' }, 'GAME COUNTER ▸'),
      h('a', { class: 'btn btn--ghost', href: './bracket.html' }, 'BRACKET ▸')),
    coordLine('MISSION OPS'));

  sync = createSync({
    fetchState: () => rpc('ops_state', { p_token: getToken() }),
    onState: (s) => { st = s; render(); },
    onError: (e) => {
      if (e.code === 'HOST_UNAUTHORIZED') { clearToken(); renderLocked(errorText(e.code)); }
      else toast(errorText(e.code), 'error');
    },
    onConnection: (ok) => setNetBanner(!ok),
    onLink: (l) => setLinkLed(l === 'offline' ? 'offline' : 'fallback'),
    fallbackIntervalMs: 3000,
  });
  sync.refresh();
}

// ---------------------------------------------------------------------
function ago(ms, now) {
  if (!ms) return 'NOCH NIE ONLINE';
  const d = Math.max(0, now - ms);
  if (d < ONLINE_MS) return 'ONLINE';
  const min = Math.round(d / 60000);
  if (min < 60) return `VOR ${min} MIN`;
  const hrs = Math.round(min / 60);
  return hrs < 24 ? `VOR ${hrs} STD` : `VOR ${Math.round(hrs / 24)} TG`;
}

function clock(ms) {
  return ms ? new Date(ms).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : '';
}

function tile(label, value, sub = '', cls = '') {
  return h('div', { class: `ops-tile ${cls}` },
    h('span', { class: 'ops-tile__label', text: label }),
    h('span', { class: 'ops-tile__value', text: value }),
    sub ? h('span', { class: 'ops-tile__sub', text: sub }) : null);
}

function render() {
  if (!st) return;
  const now = st.server_now_ms;
  const accs = st.accounts;
  const players = accs.filter((a) => !a.commander);
  const total = players.length;
  const onSite = players.filter((a) => a.checked_in).length;
  const online = accs.filter((a) => a.last_seen_ms && now - a.last_seen_ms < ONLINE_MS).length;
  const site = st.site;
  const holdText = !site.hold_enabled ? 'AUS' : site.open ? 'FREIGEGEBEN' : 'AKTIV';

  mount(el.tiles,
    tile('ON SITE', `${onSite} / ${total}`, onSite === total && total ? 'ALLE DA' : `${total - onSite} AUSSTEHEND`, onSite === total && total ? 'is-ok' : 'is-hot'),
    tile('ONLINE', String(online), 'GERADE AUF DER SEITE'),
    tile('QUIZ', st.quiz ? st.quiz.code : '—', st.quiz ? `${QUIZ_STATUS[st.quiz.status] || st.quiz.status} // ${st.quiz.player_count} SPIELER` : 'KEINE OFFENE MISSION'),
    tile('HOLD-SCREEN', holdText, site.hold_enabled && !site.open ? 'SEITE GESPERRT' : 'SEITE OFFEN', site.hold_enabled && !site.open ? 'is-hot' : ''));

  // Hold-Screen-Steuerung
  const toggle = h('button', { type: 'button', class: `btn ${site.hold_enabled ? 'btn--ghost' : 'btn--primary'}` }, site.hold_enabled ? 'HOLD-SCREEN AUSSCHALTEN' : 'HOLD-SCREEN AKTIVIEREN');
  toggle.addEventListener('click', () => act((t) => rpc('ops_set_hold', { p_token: t, p_enabled: !site.hold_enabled }), site.hold_enabled ? 'HOLD-SCREEN AUS' : 'HOLD-SCREEN AKTIV'));
  const release = site.hold_enabled && !site.open ? h('button', { type: 'button', class: 'btn btn--primary' }, 'MISSION JETZT FREIGEBEN') : null;
  if (release) release.addEventListener('click', async () => {
    if (await confirmDialog({ title: 'JETZT FREIGEBEN?', text: `Erst ${onSite} von ${total} sind eingecheckt. Trotzdem für alle freigeben?`, confirmLabel: 'FREIGEBEN' })) {
      act((t) => rpc('ops_release', { p_token: t }), 'MISSION FREIGEGEBEN');
    }
  });
  mount(el.hold,
    h('p', { class: 'lead', text: !site.hold_enabled
      ? 'Aus: Die Webseite ist für alle offen (Login, Quiz, Stats, Bracket).'
      : site.open
        ? 'Freigegeben: Alle waren eingecheckt (oder du hast freigegeben) – die Webseite ist offen.'
        : `Aktiv: Start-Bildschirm für alle. Niemand kann sich einloggen, dem Quiz beitreten oder Stats eintragen, bis alle ${total} Operatoren eingecheckt sind (${onSite}/${total}).` }),
    h('p', { class: 'field__hint', text: 'Gesperrt: Startseite, Login, Quiz, Game Counter und Bracket – auch serverseitig. Nur du als Commander (Account havoc) kommst durch. Wer nicht kommt: Account löschen oder MISSION JETZT FREIGEBEN.' }),
    h('div', { class: 'ops-bulk' }, toggle, release));

  // Anwesenheitsliste
  el.count.textContent = `${onSite}/${total}`;
  mount(el.list, accs.length ? accs.map((a) => {
    const seen = ago(a.last_seen_ms, now);
    const check = a.commander
      ? h('span', { class: 'ops-check is-cmd' }, 'COMMANDER')
      : h('button', { type: 'button', class: `ops-check${a.checked_in ? ' is-in' : ''}`, 'aria-pressed': a.checked_in ? 'true' : 'false' },
          a.checked_in ? '✓ ON SITE' : 'EINCHECKEN');
    if (!a.commander) check.addEventListener('click', () => act((t) => rpc('ops_set_checkin', { p_token: t, p_account_id: a.id, p_checked: !a.checked_in })));
    const pw = h('button', { type: 'button', class: 'btn btn--tiny' }, 'PASSWORT');
    pw.addEventListener('click', () => resetPassword(a));
    const del = h('button', { type: 'button', class: 'chip__remove', 'aria-label': `${a.username} löschen`, title: 'Account löschen' }, '×');
    del.addEventListener('click', async () => {
      if (await confirmDialog({ title: `${a.username} LÖSCHEN?`, text: 'Account, Login und eingetragene CS-Stats werden gelöscht.', confirmLabel: 'LÖSCHEN', danger: true })) {
        act((t) => rpc('ops_delete_account', { p_token: t, p_account_id: a.id }), `${a.username} GELÖSCHT`);
      }
    });
    return h('li', { class: `ops-row${a.checked_in ? ' is-in' : ''}` },
      check,
      h('div', { class: 'ops-row__who' },
        h('span', { class: 'ops-row__name', text: a.username }),
        h('span', { class: 'ops-badges' },
          a.in_roster ? h('span', { class: 'ops-badge', text: 'TEAM' }) : null,
          a.in_tournament ? h('span', { class: 'ops-badge', text: 'BRACKET' }) : null,
          a.in_quiz ? h('span', { class: 'ops-badge', text: 'QUIZ' }) : null,
          a.pending_stats ? h('span', { class: 'ops-badge is-warn', text: `${a.pending_stats} STATS OFFEN` }) : null,
          a.locked ? h('span', { class: 'ops-badge is-warn', text: 'LOGIN GESPERRT' }) : null)),
      h('span', { class: `ops-row__seen${seen === 'ONLINE' ? ' is-online' : ''}` }, h('span', { class: 'led', 'aria-hidden': 'true' }), seen),
      h('span', { class: 'ops-row__time', text: a.checked_in ? `SEIT ${clock(a.checked_in_at_ms)}` : '' }),
      h('span', { class: 'ops-row__actions' }, a.commander ? null : pw, a.commander ? null : del));
  }) : h('li', { class: 'muted', text: 'Noch keine Operatoren registriert. Unten Accounts anlegen oder die Spieler registrieren sich selbst unter LOGIN.' }));
}

// ---------------------------------------------------------------------
async function act(fn, successText = '') {
  if (busy) return false;
  const token = getToken();
  if (!token) { renderLocked(); return false; }
  busy = true;
  try {
    st = await fn(token);
    render();
    if (successText) toast(successText);
    return true;
  } catch (e) {
    if (e.code === 'HOST_UNAUTHORIZED') { clearToken(); renderLocked(errorText(e.code)); }
    else toast(errorText(e.code), 'error');
    return false;
  } finally {
    busy = false;
  }
}

function resetPassword(account) {
  const input = h('input', { id: 'ops-newpw', class: 'input', maxlength: '64', autocomplete: 'off' });
  const save = h('button', { type: 'submit', class: 'btn btn--primary' }, 'SPEICHERN');
  const cancel = h('button', { type: 'button', class: 'btn btn--ghost' }, 'ABBRECHEN');
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'ops-newpw', class: 'field__label' }, 'NEUES PASSWORT (MIN. 4)'), input),
    h('div', { class: 'dialog__actions' }, cancel, save));
  const dialog = h('dialog', { class: 'dialog' },
    h('div', { class: 'dialog__stripes', 'aria-hidden': 'true' }),
    h('h2', { class: 'dialog__title', text: `PASSWORT: ${account.username}` }),
    h('p', { class: 'dialog__text', text: 'Alte Logins dieses Operators werden abgemeldet.' }),
    form);
  cancel.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (input.value.length < 4) { input.focus(); return; }
    if (await act((t) => rpc('ops_reset_password', { p_token: t, p_account_id: account.id, p_password: input.value }), 'PASSWORT GEÄNDERT')) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}

init();
