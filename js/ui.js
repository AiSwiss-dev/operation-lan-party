// =====================================================================
//  Gemeinsame UI-Bausteine für Spieler- und Host-Seite
// =====================================================================

import { h, mount } from './utils.js';

// ---------------------------------------------------------------------
// Verbindungsanzeige "VERBINDUNG ZUM HQ VERLOREN / RECONNECTING..."
// ---------------------------------------------------------------------
export function setNetBanner(offline) {
  const banner = document.getElementById('net-banner');
  if (!banner) return;
  banner.hidden = !offline;
  document.body.classList.toggle('is-offline', !!offline);
}

// LED im Header: Realtime live (grün) / Fallback (orange) / offline (rot)
export function setLinkLed(state) {
  const led = document.getElementById('link-led');
  if (!led) return;
  led.dataset.state = state;
  const text = { live: 'LIVE', fallback: 'SYNC', offline: 'OFFLINE' }[state] || '';
  led.setAttribute('title', text);
  const label = led.querySelector('.led__label');
  if (label) label.textContent = text;
}

// ---------------------------------------------------------------------
// Fehlende / falsche Konfiguration
// ---------------------------------------------------------------------
export function renderConfigError(container, status) {
  const messages = {
    missing: ['KONFIGURATION FEHLT', 'Die Datei js/config.js wurde nicht gefunden. Kopiere config.example.js nach js/config.js und trage Supabase-URL und anon/publishable Key ein (siehe README).'],
    placeholder: ['KONFIGURATION UNVOLLSTÄNDIG', 'In js/config.js stehen noch die Platzhalter. Trage deine Supabase-URL und den anon/publishable Key ein.'],
    url: ['SUPABASE-URL UNGÜLTIG', 'SUPABASE_URL muss mit https:// beginnen, z. B. https://abcdefgh.supabase.co'],
    secret: ['SICHERHEITSALARM: SECRET KEY IM BROWSER', 'In js/config.js steht ein service_role- bzw. secret-Key. Dieser Key darf NIEMALS im Browser stehen. Ersetze ihn sofort durch den anon/publishable Key und erneuere den Secret Key im Supabase-Dashboard.'],
  };
  const [title, text] = messages[status.reason] || messages.missing;
  mount(container,
    h('section', { class: 'card card--alert', role: 'alert' },
      h('div', { class: 'stripes', 'aria-hidden': 'true' }),
      h('p', { class: 'eyebrow', text: 'SYSTEM // FEHLER' }),
      h('h1', { class: 'title title--md', text: title }),
      h('p', { class: 'lead', text })));
}

// ---------------------------------------------------------------------
// Countdown – rechnet immer aus Serverzeitpunkten
// ---------------------------------------------------------------------
export function createCountdown({ size = 'md' } = {}) {
  const value = h('span', { class: 'countdown__value', text: '--' });
  const label = h('span', { class: 'countdown__label', text: 'SEK' });
  const fill = h('i', { class: 'countdown__fill' });
  const node = h('div', { class: `countdown countdown--${size}`, role: 'timer', 'aria-label': 'Verbleibende Zeit' },
    h('div', { class: 'countdown__face' }, value, label),
    h('div', { class: 'countdown__bar', 'aria-hidden': 'true' }, fill));

  let last = '';

  // Gibt { phase: 'lead'|'open'|'expired', secs } zurück
  function update(game, now) {
    const start = game.started_at_ms;
    const end = game.ends_at_ms;
    const total = game.duration_s * 1000;
    let phase;
    let secs;
    if (!start || !end) {
      phase = 'expired';
      secs = 0;
    } else if (now < start) {
      phase = 'lead';
      secs = Math.max(1, Math.ceil((start - now) / 1000));
    } else if (now < end) {
      phase = 'open';
      secs = Math.min(game.duration_s, Math.max(0, Math.ceil((end - now) / 1000)));
    } else {
      phase = 'expired';
      secs = 0;
    }

    const level = phase === 'lead' ? 'lead'
      : phase === 'expired' ? 'expired'
      : secs <= 5 ? 'critical'
      : secs <= 10 ? 'urgent' : 'normal';
    const key = `${phase}:${secs}:${level}`;
    if (key !== last) {
      last = key;
      node.dataset.level = level;
      value.textContent = phase === 'expired' ? '0' : String(secs);
      label.textContent = phase === 'lead' ? 'GET READY' : phase === 'expired' ? 'TIME EXPIRED' : 'SEK';
      node.setAttribute('aria-valuetext', phase === 'expired' ? 'Zeit abgelaufen' : `${secs} Sekunden`);
    }
    const frac = phase === 'lead' ? 1 : phase === 'open' ? Math.max(0, Math.min(1, (end - now) / total)) : 0;
    fill.style.setProperty('transform', `scaleX(${frac.toFixed(4)})`);
    return { phase, secs };
  }

  return { node, update };
}

// ---------------------------------------------------------------------
// Fortschritt: 20 Segmente, Phasen optisch getrennt
// ---------------------------------------------------------------------
export function progressBar(game) {
  const total = game.total_questions || 0;
  const current = game.current_question || 0;
  const done = (i) => i < current || (i === current && game.status !== 'question');
  // letzte Frage von Phase I (zwischen den Phasen kommt eine Lücke)
  const boundary = game.phase === 1 ? game.phase_last : (game.phase_first || 1) - 1;
  const segments = [];
  for (let i = 1; i <= total; i++) {
    segments.push(h('span', {
      class: `progress__seg${done(i) ? ' is-done' : ''}${i === current && game.status === 'question' ? ' is-current' : ''}${i === boundary && i < total ? ' is-phase-end' : ''}`,
    }));
  }
  return h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(current), 'aria-label': `Frage ${current} von ${total}` }, segments);
}

// ---------------------------------------------------------------------
// Deko: Koordinaten-Zeile (rein optisch)
// ---------------------------------------------------------------------
export function coordLine(extra = '') {
  return h('p', { class: 'coords', 'aria-hidden': 'true' },
    `GRID 47°22'N // 008°32'E${extra ? ` // ${extra}` : ''}`);
}

export function stamp(text = 'CLASSIFIED') {
  return h('span', { class: 'stamp', 'aria-hidden': 'true', text });
}
