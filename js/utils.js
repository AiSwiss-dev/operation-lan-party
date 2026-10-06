// =====================================================================
//  Allgemeine Helfer: DOM-Bau (immer als Text, nie als HTML), lokaler
//  Speicher, Fehlertexte, Ranglisten.
// =====================================================================

// Element erzeugen. Kinder sind Strings (→ Textknoten) oder Nodes.
// Es wird NIE innerHTML verwendet, dadurch ist HTML-/Script-Injection über
// Callsigns oder Fragen ausgeschlossen.
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') for (const [k, v] of Object.entries(value)) node.style.setProperty(k, v);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(container, ...children) {
  container.replaceChildren();
  append(container, children);
}

export const $ = (selector, root = document) => root.querySelector(selector);

// localStorage kann (privater Modus, blockierte Website-Daten) fehlen
// oder werfen – deshalb alles in try/catch.
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* egal */ }
  },
  remove(key) {
    try { window.localStorage.removeItem(key); } catch { /* egal */ }
  },
};

// Fehlercodes vom Server → verständliche Meldungen
const ERRORS = {
  MISSION_CODE_INVALID: 'MISSION CODE UNGÜLTIG',
  MISSION_NOT_FOUND: 'MISSION CODE UNGÜLTIG – KEINE MISSION GEFUNDEN',
  MISSION_ALREADY_STARTED: 'MISSION BEREITS GESTARTET',
  MISSION_CLOSED: 'MISSION BEREITS BEENDET',
  MISSION_FULL: 'MISSION VOLL – KEINE PLÄTZE MEHR FREI',
  CALLSIGN_LENGTH: 'CALLSIGN MUSS 2–24 ZEICHEN HABEN',
  CALLSIGN_CHARS: 'CALLSIGN ENTHÄLT UNGÜLTIGE ZEICHEN',
  CALLSIGN_TAKEN: 'CALLSIGN BEREITS VERGEBEN',
  PLAYER_NOT_FOUND: 'OPERATOR NICHT GEFUNDEN – BITTE NEU BEITRETEN',
  QUESTION_NOT_ACTIVE: 'FRAGE NICHT MEHR AKTIV',
  QUESTION_NOT_STARTED: 'FRAGE NOCH NICHT FREIGEGEBEN',
  TIME_EXPIRED: 'TIME EXPIRED',
  OPTION_INVALID: 'UNGÜLTIGE ANTWORT',
  HOST_UNAUTHORIZED: 'COMMANDER-SITZUNG ABGELAUFEN – BITTE NEU EINLOGGEN',
  LOGIN_FAILED: 'ZUGANG VERWEIGERT – PASSWORT FALSCH',
  LOGIN_LOCKED: 'ZU VIELE FEHLVERSUCHE – BITTE 10 MINUTEN WARTEN',
  COMMANDER_PASSWORD_NOT_SET: 'KEIN COMMANDER-PASSWORT GESETZT (SIEHE README)',
  NO_PLAYERS: 'NOCH KEINE OPERATOREN IN DER LOBBY',
  NO_QUESTIONS: 'KEINE FRAGEN IN DER DATENBANK (SCHEMA.SQL AUSFÜHREN)',
  CODE_GENERATION_FAILED: 'MISSION CODE KONNTE NICHT ERZEUGT WERDEN',
  NETWORK: 'VERBINDUNG ZUM HQ VERLOREN',
  CONFIG_KEY: 'SUPABASE-KEY UNGÜLTIG – JS/CONFIG.JS PRÜFEN',
  SETUP: 'HQ NICHT EINGERICHTET – SCHEMA.SQL IN SUPABASE AUSFÜHREN (SIEHE README)',
  NAME_LENGTH: 'NAME ZU LANG ODER LEER',
  NAME_CHARS: 'NAME ENTHÄLT UNGÜLTIGE ZEICHEN',
  TEAM_INVALID: 'TEAM UNGÜLTIG',
  SCORE_INVALID: 'SCORE UNGÜLTIG – BEIDE WERTE 0–99 EINTRAGEN',
  RESULT_INVALID: 'ERGEBNIS WÄHLEN: SIEG, NIEDERLAGE ODER UNENTSCHIEDEN',
  BRACKET_INVALID: 'BRACKET UNGÜLTIG – SCORES 0–99',
  NAME_TAKEN: 'NAME DOPPELT – JEDEN OPERATOR NUR EINMAL EINTRAGEN',
  PLAYERS_COUNT: '4–8 OPERATOREN EINTRAGEN',
  NOT_DRAWN: 'ZUERST AUSLOSEN',
  ACCOUNT_UNAUTHORIZED: 'LOGIN ABGELAUFEN – BITTE NEU EINLOGGEN',
  PASSWORD_INVALID: 'PASSWORT: 4–64 ZEICHEN',
  NOT_IN_TEAM: 'NICHT IM 5ER-TEAM',
  STATS_INVALID: 'STATS UNGÜLTIG',
  NO_ACTIVE_MISSION: 'KEINE OFFENE MISSION',
  LIMIT_REACHED: 'LIMIT ERREICHT',
};

export function errorText(code) {
  return ERRORS[code] || 'UNBEKANNTER FEHLER – BITTE ERNEUT VERSUCHEN';
}

// Platzierung: mehr Punkte zuerst; bei Gleichstand gewinnt die kleinere
// Gesamt-Antwortzeit der richtigen Antworten (time_ms, vom Server).
// Nur wenn beides gleich ist, wird der Platz geteilt (1, 1, 3, …).
export function withPositions(players) {
  const sorted = [...players].sort((a, b) => (b.score - a.score) || ((a.time_ms || 0) - (b.time_ms || 0)));
  let lastKey = null;
  let lastPos = 0;
  return sorted.map((p, i) => {
    const key = `${p.score}|${p.time_ms || 0}`;
    if (key !== lastKey) { lastPos = i + 1; lastKey = key; }
    return { ...p, position: lastPos };
  });
}

export function formatSeconds(ms) {
  return `${(Number(ms || 0) / 1000).toFixed(1).replace('.', ',')} s`;
}

export function formatPoints(n) {
  return Number(n || 0).toLocaleString('de-DE');
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function onlyDigits(value, max = 6) {
  return String(value || '').replace(/\D+/g, '').slice(0, max);
}

// Clientseitige Vorprüfung (der Server prüft trotzdem selbst)
export function cleanCallsign(value) {
  return String(value || '').normalize('NFC').replace(/[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ').trim();
}

export function callsignProblem(value) {
  const c = cleanCallsign(value);
  if ([...c].length < 2 || [...c].length > 24) return 'CALLSIGN_LENGTH';
  if (/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF<>]/.test(c)) return 'CALLSIGN_CHARS';
  return null;
}

// Ja/Nein-Abfrage mit <dialog>, Fallback auf window.confirm
export function confirmDialog({ title, text, confirmLabel = 'BESTÄTIGEN', cancelLabel = 'ABBRECHEN', danger = false }) {
  if (typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) {
    return Promise.resolve(window.confirm(`${title}\n\n${text || ''}`));
  }
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'dialog-title' },
      h('div', { class: 'dialog__stripes', 'aria-hidden': 'true' }),
      h('h2', { id: 'dialog-title', class: 'dialog__title', text: title }),
      text ? h('p', { class: 'dialog__text', text }) : null,
      h('div', { class: 'dialog__actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', value: 'cancel', onclick: () => dialog.close('cancel') }, cancelLabel),
        h('button', { type: 'button', class: danger ? 'btn btn--danger' : 'btn btn--primary', value: 'ok', onclick: () => dialog.close('ok') }, confirmLabel)));
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok');
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('.btn--ghost').focus();
  });
}

// Kleiner Toast für kurze Meldungen
let toastTimer = null;
export function toast(message, kind = 'info') {
  let node = document.getElementById('toast');
  if (!node) {
    node = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(node);
  }
  node.textContent = message;
  node.dataset.kind = kind;
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 3200);
}

export function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* egal */ }
}
