// =====================================================================
//  STARTSEITE (index.html) – Auswahl Quiz / Game Counter / Bracket
//  Alte Quiz-Links (…/?game=483921) werden automatisch zum Quiz
//  weitergeleitet, damit bereits gedruckte QR-Codes weiter funktionieren.
// =====================================================================

import { startHeartbeat, getAccount } from './account.js';
import { initGate, commanderSession } from './gate.js';
import { configStatus } from './supabase-client.js';

const params = new URLSearchParams(window.location.search);
if (params.has('game')) {
  window.location.replace(`./quiz.html${window.location.search}`);
} else if (configStatus.ok && !getAccount() && !(await commanderSession())) {
  // Start der Seite = OPERATOR LOGIN
  window.location.replace('./login.html');
} else {
  startHeartbeat();
  initGate();
  // Der Commander ist MISSION CONTROL: Quiz-Kachel führt direkt dorthin
  const acc = getAccount();
  if (!(acc && acc.commander)) {
    // Commander-Bereiche nur für den Commander anzeigen
    document.querySelectorAll('.hub-tile__sub, .hub-link--cmd').forEach((el) => el.remove());
  }
  const quiz = document.querySelector('.hub-tile__main[href="./quiz.html"]');
  if (acc && acc.commander && quiz) {
    quiz.setAttribute('href', './host.html');
    quiz.querySelector('.hub-tile__text').textContent = 'Du hast das Quiz erstellt: Mission starten, Fragen steuern, Ranking zeigen.';
    quiz.querySelector('.hub-tile__cta').textContent = 'MISSION CONTROL ÖFFNEN ▸';
    const sub = quiz.parentElement.querySelector('.hub-tile__sub');
    if (sub) sub.remove();
  }
}
