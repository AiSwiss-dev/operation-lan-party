// =====================================================================
//  Operator-Account (Login) – gemeinsam für alle Seiten
//  Ein Login gilt überall: Quiz (Callsign = Benutzername, Beitritt ohne
//  QR/Code), Game Counter (eigene CS-Stats eintragen) und Bracket.
// =====================================================================

import { rpc, configStatus } from './supabase-client.js';
import { storage } from './utils.js';

const KEY = 'olp.account';

export function getAccount() {
  const a = storage.get(KEY);
  return a && a.token ? a : null;
}

export function setAccount(token, username, commander = false) {
  storage.set(KEY, { token, username, commander: !!commander });
  renderAccountLink();
}

export function clearAccount() {
  storage.remove(KEY);
  renderAccountLink();
}

export function norm(name) {
  return String(name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isMe(name) {
  const a = getAccount();
  return !!(a && name && norm(name) === norm(a.username));
}

// Profil laden (aktualisiert gleichzeitig "online"). null = nicht eingeloggt.
export async function fetchMe(touch = true) {
  const a = getAccount();
  if (!a || !configStatus.ok) return null;
  try {
    const me = await rpc('account_me', { p_token: a.token, p_touch: touch });
    if (me.username !== a.username || !!me.commander !== !!a.commander) setAccount(a.token, me.username, me.commander);
    return me;
  } catch (e) {
    if (e.code === 'ACCOUNT_UNAUTHORIZED') clearAccount();
    if (e.network) return { offline: true, username: a.username };
    return null;
  }
}

// Link oben rechts: "LOGIN" bzw. Benutzername → login.html
export function renderAccountLink() {
  const link = document.getElementById('account-link');
  if (!link) return;
  const a = getAccount();
  link.textContent = a ? `◉ ${a.username}` : 'LOGIN';
  link.classList.toggle('is-logged-in', !!a);
  const here = window.location.pathname.split('/').pop() || 'index.html';
  link.href = here === 'login.html' ? './login.html' : `./login.html?return=${encodeURIComponent(here + window.location.search)}`;
  link.setAttribute('aria-label', a ? `Profil von ${a.username}` : 'Login');
}

// Alle 60 s "online" melden, solange eingeloggt
let heartbeat = null;
export function startHeartbeat() {
  renderAccountLink();
  if (heartbeat || !configStatus.ok) return;
  fetchMe(true);
  heartbeat = setInterval(() => { if (getAccount()) fetchMe(true); }, 60000);
}
