// =====================================================================
//  HOLD-SCREEN
//  Aktiviert der Commander den Hold-Screen (MISSION OPS), sehen alle einen
//  STANDBY-Bildschirm, bis er alle Operatoren eingecheckt hat – dann wird
//  die Seite live auf allen Geräten freigegeben.
//  Hinweis: Das ist eine Sperre der Oberfläche (Party-Modus), keine
//  Zugriffssperre der Daten.
// =====================================================================

import { configStatus, rpc, watchTables } from './supabase-client.js';
import { h, mount } from './utils.js';
import { createSync } from './sync.js';
import { getAccount } from './account.js';
import { TEXT } from './questions.js';

let overlay = null;
let wasHeld = false;

function build() {
  overlay = h('div', { id: 'hold', class: 'hold', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'hold-title', hidden: true });
  document.body.append(overlay);
}

function render(s) {
  const a = getAccount();
  const pct = s.total ? Math.round((s.checked_in / s.total) * 100) : 0;
  const here = window.location.pathname.split('/').pop() || 'index.html';
  const loginHref = `./login.html?return=${encodeURIComponent(here + window.location.search)}`;
  mount(overlay,
    h('div', { class: 'stripes hold__stripes', 'aria-hidden': 'true' }),
    h('div', { class: 'hold__inner' },
      h('span', { class: 'stamp hold__stamp', 'aria-hidden': 'true', text: 'STANDBY' }),
      h('p', { class: 'eyebrow', text: `${TEXT.org} // ${TEXT.eventDate} // ${TEXT.eventTime}` }),
      h('h1', { id: 'hold-title', class: 'title title--xl' }, 'OPERATION', h('br'), 'LAN-PARTY'),
      h('p', { class: 'subtitle', text: 'MISSION BRIEFING // WARTE AUF CHECK-IN' }),
      h('div', { class: 'radar hold__radar', 'aria-hidden': 'true' }),
      h('p', { class: 'hold__count' }, h('b', { text: String(s.checked_in) }), ` / ${s.total} OPERATORS ON SITE`),
      h('div', { class: 'hold__bar', 'aria-hidden': 'true' }, h('i', { style: { width: `${pct}%` } })),
      s.operators.length
        ? h('ul', { class: 'hold__ops', 'aria-label': 'Operatoren' }, s.operators.map((o) => h('li', { class: `hold__op${o.checked_in ? ' is-in' : ''}` },
            h('span', { class: 'hold__led', 'aria-hidden': 'true' }),
            h('span', { class: 'hold__name', text: o.username }),
            h('span', { class: 'hold__state', text: o.checked_in ? 'ON SITE' : 'AUSSTEHEND' }))))
        : h('p', { class: 'muted', text: 'Noch keine Operatoren registriert.' }),
      h('p', { class: 'hold__hint', text: 'Der Commander checkt alle Operatoren ein. Sobald alle da sind, wird die Mission automatisch freigegeben.' }),
      h('a', { class: 'btn btn--primary', href: loginHref }, a ? `PROFIL: ${a.username}` : 'LOGIN / REGISTRIEREN')),
    h('div', { class: 'stripes hold__stripes', 'aria-hidden': 'true' }));
}

function apply(s) {
  if (!s) return;
  if (!s.open) {
    wasHeld = true;
    render(s);
    overlay.hidden = false;
    overlay.classList.remove('is-unlocking');
    document.body.classList.add('is-held');
    return;
  }
  if (wasHeld && !overlay.hidden) {
    // Freigabe: kurz "MISSION UNLOCKED" zeigen, dann ausblenden
    mount(overlay, h('div', { class: 'hold__inner hold__unlocked' },
      h('p', { class: 'eyebrow', text: 'ALL OPERATORS ON SITE' }),
      h('h1', { class: 'title title--xl', text: 'MISSION UNLOCKED' })));
    overlay.classList.add('is-unlocking');
    setTimeout(() => { overlay.hidden = true; document.body.classList.remove('is-held'); }, 1800);
  } else {
    overlay.hidden = true;
    document.body.classList.remove('is-held');
  }
  wasHeld = false;
}

export function initGate() {
  if (!configStatus.ok) return;
  build();
  const sync = createSync({ fetchState: () => rpc('site_status'), onState: apply, liveIntervalMs: 10000, fallbackIntervalMs: 4000 });
  watchTables(['site_state'], { onChange: () => sync.realtimeEvent(), onLive: (live) => sync.setSubscribed(live) });
  sync.refresh();
}
