// =====================================================================
//  Commander-Zugang für Game Counter und Bracket
//  Gleiches Passwort und gleiche Sitzung wie MISSION CONTROL: Wer auf
//  host.html eingeloggt ist, kann hier direkt bearbeiten (und umgekehrt).
// =====================================================================

import { rpc } from './supabase-client.js';
import { h, storage, errorText } from './utils.js';

const TOKEN_KEY = 'olp.host';

export function getToken() {
  const saved = storage.get(TOKEN_KEY);
  return saved && saved.token ? saved.token : null;
}

export function clearToken() {
  storage.remove(TOKEN_KEY);
}

// true = gültige Commander-Sitzung vorhanden
export async function checkCommander() {
  const token = getToken();
  if (!token) return false;
  try {
    const info = await rpc('host_session_info', { p_token: token });
    if (!info.valid) { clearToken(); return false; }
    return true;
  } catch (e) {
    return !!e.network; // offline: Sitzung vorerst behalten
  }
}

// Login-Dialog. Ergebnis: true, wenn eingeloggt.
export function commanderLogin() {
  return new Promise((resolve) => {
    const input = h('input', { id: 'cmd-password', type: 'password', class: 'input', autocomplete: 'current-password', 'aria-describedby': 'cmd-error' });
    const error = h('p', { id: 'cmd-error', class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, 'LOGIN');
    const cancel = h('button', { type: 'button', class: 'btn btn--ghost' }, 'ABBRECHEN');
    const form = h('form', { class: 'form', novalidate: true },
      h('div', { class: 'field' }, h('label', { for: 'cmd-password', class: 'field__label' }, 'COMMANDER-PASSWORT'), input),
      error,
      h('div', { class: 'dialog__actions' }, cancel, submit));
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'cmd-title' },
      h('div', { class: 'dialog__stripes', 'aria-hidden': 'true' }),
      h('h2', { id: 'cmd-title', class: 'dialog__title', text: 'COMMANDER LOGIN' }),
      h('p', { class: 'dialog__text', text: 'Zum Bearbeiten – gleiches Passwort wie in MISSION CONTROL.' }),
      form);
    let result = false;
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!input.value) { error.textContent = 'PASSWORT EINGEBEN'; return; }
      submit.disabled = true;
      error.textContent = '';
      try {
        const res = await rpc('host_login', { p_password: input.value });
        if (!res.ok) { error.textContent = errorText(res.error); input.select(); return; }
        storage.set(TOKEN_KEY, { token: res.token, expiresAt: res.expires_at_ms });
        result = true;
        dialog.close();
      } catch (e) {
        error.textContent = errorText(e.code);
      } finally {
        submit.disabled = false;
      }
    });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    document.body.append(dialog);
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    input.focus();
  });
}

export async function commanderLogout() {
  const token = getToken();
  try { if (token) await rpc('host_logout', { p_token: token }); } catch { /* egal */ }
  clearToken();
}
