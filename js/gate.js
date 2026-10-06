// =====================================================================
//  HOLD-SCREEN (Start-Bildschirm)
//  Solange der Hold aktiv ist und nicht alle Operatoren eingecheckt sind,
//  ist die Webseite für alle gesperrt: kein Login, kein Quiz, keine Stats,
//  kein Bracket. Der Server lehnt diese Aktionen ebenfalls ab.
//  Einchecken macht nur der Commander (MISSION OPS). Sind alle da, wird die
//  Seite live auf allen Geräten freigegeben.
//  Der Commander (Account "havoc" oder Commander-Passwort) hat KEINEN Hold –
//  er sieht und benutzt die Seite ganz normal.
// =====================================================================

import { configStatus, rpc, watchTables } from './supabase-client.js';
import { h, mount, storage, errorText } from './utils.js';
import { createSync } from './sync.js';
import { setAccount, getAccount } from './account.js';
import { TEXT } from './questions.js';

let overlay = null;
let wasHeld = false;
let isCommander = false;

function build() {
  overlay = h('div', { id: 'hold', class: 'hold', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'hold-title', hidden: true });
  document.body.append(overlay);
}

// Commander = gültige Commander-Sitzung ODER eingeloggt mit dem Commander-Account
async function commanderSession() {
  const saved = storage.get('olp.host');
  if (saved && saved.token) {
    try {
      if ((await rpc('host_session_info', { p_token: saved.token })).valid) return true;
    } catch { /* weiter prüfen */ }
  }
  const acc = getAccount();
  if (acc) {
    try {
      if ((await rpc('account_me', { p_token: acc.token, p_touch: false })).commander) return true;
    } catch { /* kein Commander */ }
  }
  return false;
}

function commanderDialog() {
  const user = h('input', { id: 'hold-user', class: 'input', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', value: 'havoc' });
  const pass = h('input', { id: 'hold-pass', type: 'password', class: 'input', autocomplete: 'current-password' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, 'LOGIN');
  const cancel = h('button', { type: 'button', class: 'btn btn--ghost' }, 'ABBRECHEN');
  const form = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'hold-user', class: 'field__label' }, 'COMMANDER-ACCOUNT'), user),
    h('div', { class: 'field' }, h('label', { for: 'hold-pass', class: 'field__label' }, 'PASSWORT'), pass),
    error,
    h('div', { class: 'dialog__actions' }, cancel, submit));
  const dialog = h('dialog', { class: 'dialog' },
    h('div', { class: 'dialog__stripes', 'aria-hidden': 'true' }),
    h('h2', { class: 'dialog__title', text: 'COMMANDER LOGIN' }),
    h('p', { class: 'dialog__text', text: 'Während des Check-ins hat nur der Commander Zugang.' }),
    form);
  cancel.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    try {
      const res = await rpc('account_login', { p_username: user.value, p_password: pass.value });
      if (!res.ok) {
        error.textContent = res.error === 'SITE_ON_HOLD' ? 'WÄHREND DES CHECK-INS NUR FÜR DEN COMMANDER' : res.error === 'LOGIN_FAILED' ? 'LOGIN FEHLGESCHLAGEN' : errorText(res.error);
        return;
      }
      if (!res.commander) { error.textContent = 'WÄHREND DES CHECK-INS NUR FÜR DEN COMMANDER'; return; }
      setAccount(res.token, res.username, true);
      storage.set('olp.host', { token: res.host_token });
      window.location.reload();
    } catch (e) {
      error.textContent = errorText(e.code);
    } finally {
      submit.disabled = false;
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  pass.focus();
}

// Einsatzbeginn (H-Hour) aus Datum/Uhrzeit in questions.js
function hHour() {
  const [d, m, y] = TEXT.eventDate.split('.').map(Number);
  const [hh, mm] = TEXT.eventTime.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0).getTime();
}

function pad(n) { return String(n).padStart(2, '0'); }

function tMinus() {
  const diff = hHour() - Date.now();
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const rest = abs % 86400000;
  const t = `${pad(Math.floor(rest / 3600000))}:${pad(Math.floor((rest % 3600000) / 60000))}:${pad(Math.floor((rest % 60000) / 1000))}`;
  return `${diff >= 0 ? 'T-MINUS' : 'T-PLUS'} ${days ? `${days}D ` : ''}${t}`;
}

let clockTimer = null;
function startClock() {
  clearInterval(clockTimer);
  const tick = () => {
    const now = new Date();
    const clock = overlay && overlay.querySelector('[data-hold-clock]');
    const tm = overlay && overlay.querySelector('[data-hold-tminus]');
    if (clock) clock.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} LCL`;
    if (tm) tm.textContent = tMinus();
  };
  tick();
  clockTimer = setInterval(tick, 1000);
}

// feste, aber "zufällig" wirkende Radar-Position pro Operator
function blipPos(name, i, n) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const angle = ((i / Math.max(1, n)) * 360 + (hash % 40)) * (Math.PI / 180);
  const r = 22 + (hash % 22);
  return { left: `${50 + Math.cos(angle) * r}%`, top: `${50 + Math.sin(angle) * r}%` };
}

function render(s) {
  const cmdBtn = h('button', { type: 'button', class: 'btn btn--tiny hold__cmd' }, 'COMMANDER');
  cmdBtn.addEventListener('click', commanderDialog);
  const segs = Math.max(1, s.total);
  const objectives = [
    ['01', 'QUIZ', 'CS2 EINSATZPRÜFUNG'],
    ['02', 'GAME COUNTER', '5-MAN SQUAD // CS-STATS'],
    ['03', 'BRACKET', '1v1 TACTICAL DUEL'],
  ];
  mount(overlay,
    h('div', { class: 'hold__scan', 'aria-hidden': 'true' }),
    h('header', { class: 'hold__hud' },
      h('span', { class: 'hold__hud-brand' }, h('span', { class: 'topbar__mark', 'aria-hidden': 'true', text: '◢◤' }), ' OPERATION LAN PARTY'),
      h('span', { class: 'hold__hud-mid', text: 'CLASSIFIED // EYES ONLY // GRID 47°22\'N 008°32\'E' }),
      h('span', { class: 'hold__hud-clock', 'data-hold-clock': '' })),
    h('div', { class: 'stripes hold__stripes', 'aria-hidden': 'true' }),
    h('main', { class: 'hold__grid' },
      // Missionsziele
      h('section', { class: 'hold__panel hold__panel--obj', 'aria-label': 'Missionsziele' },
        h('p', { class: 'hold__panel-title', text: 'MISSION OBJECTIVES' }),
        h('ol', { class: 'hold__obj' }, objectives.map(([no, name, sub]) => h('li', {},
          h('span', { class: 'hold__obj-no', text: no }),
          h('span', { class: 'hold__obj-text' }, h('b', { text: name }), h('small', { text: sub })),
          h('span', { class: 'hold__obj-lock', text: 'LOCKED' })))),
        h('p', { class: 'hold__panel-note', text: 'Alle Bereiche werden freigeschaltet, sobald der Commander jeden Operator eingecheckt hat.' })),
      // Mitte
      h('section', { class: 'hold__core' },
        h('p', { class: 'hold__status' }, h('span', { class: 'hold__blink', 'aria-hidden': 'true' }), 'STATUS: HOLDING POSITION'),
        h('h1', { id: 'hold-title', class: 'hold__title' }, 'OPERATION', h('br'), h('span', { text: 'ON HOLD' })),
        h('p', { class: 'hold__sub', text: 'AWAITING ALL OPERATORS // CHECK-IN BY COMMAND' }),
        h('div', { class: 'hold__radar', 'aria-hidden': 'true' },
          h('span', { class: 'hold__radar-sweep' }),
          s.operators.map((o, i) => h('span', { class: `hold__blip${o.checked_in ? ' is-in' : ''}`, style: blipPos(o.username, i, s.operators.length), title: o.username }))),
        h('p', { class: 'hold__count' }, h('b', { text: String(s.checked_in) }), ` / ${s.total} OPERATORS ON SITE`),
        h('div', { class: 'hold__segs', 'aria-hidden': 'true' },
          Array.from({ length: segs }, (_, i) => h('span', { class: i < s.checked_in ? 'is-in' : '' })))),
      // Anwesenheit
      h('section', { class: 'hold__panel hold__panel--roster', 'aria-label': 'Anwesenheit' },
        h('p', { class: 'hold__panel-title', text: 'ROSTER // ATTENDANCE' }),
        s.operators.length
          ? h('ul', { class: 'hold__ops' }, s.operators.map((o) => h('li', { class: `hold__op${o.checked_in ? ' is-in' : ''}` },
              h('span', { class: 'hold__led', 'aria-hidden': 'true' }),
              h('span', { class: 'hold__name', text: o.username }),
              h('span', { class: 'hold__state', text: o.checked_in ? 'ON SITE' : 'EN ROUTE' }))))
          : h('p', { class: 'hold__panel-note', text: 'Der Commander registriert die Operatoren …' }))),
    h('div', { class: 'stripes hold__stripes', 'aria-hidden': 'true' }),
    h('footer', { class: 'hold__hud hold__hud--bottom' },
      h('span', {}, `H-HOUR ${TEXT.eventDate} ${TEXT.eventTime} // `, h('b', { 'data-hold-tminus': '' })),
      h('span', { class: 'hold__comms' }, h('span', { class: 'led led--ok', 'aria-hidden': 'true' }), 'COMMS: LIVE'),
      cmdBtn));
  startClock();
}

function apply(s) {
  if (!s) return;
  if (isCommander) {            // Commander: nie ein Hold
    overlay.hidden = true;
    document.body.classList.remove('is-held');
    return;
  }
  if (!s.open) {
    wasHeld = true;
    render(s);
    overlay.hidden = false;
    overlay.classList.remove('is-unlocking');
    document.body.classList.add('is-held');
    return;
  }
  if (wasHeld && !overlay.hidden) {
    mount(overlay, h('div', { class: 'hold__inner hold__unlocked' },
      h('p', { class: 'hold__status', text: 'ALL OPERATORS ON SITE // GREEN LIGHT' }),
      h('h1', { class: 'hold__title' }, 'MISSION', h('br'), h('span', { text: 'UNLOCKED' }))));
    overlay.classList.add('is-unlocking');
    clearInterval(clockTimer);
    setTimeout(() => { overlay.hidden = true; document.body.classList.remove('is-held'); }, 1800);
  } else {
    overlay.hidden = true;
    document.body.classList.remove('is-held');
  }
  wasHeld = false;
}

export async function initGate() {
  if (!configStatus.ok) return;
  build();
  isCommander = await commanderSession();
  const sync = createSync({ fetchState: () => rpc('site_status'), onState: apply, liveIntervalMs: 10000, fallbackIntervalMs: 4000 });
  watchTables(['site_state'], { onChange: () => sync.realtimeEvent(), onLive: (live) => sync.setSubscribed(live) });
  sync.refresh();
}
