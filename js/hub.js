// =====================================================================
//  STARTSEITE (index.html) – Auswahl Quiz / Game Counter / Bracket
//  Alte Quiz-Links (…/?game=483921) werden automatisch zum Quiz
//  weitergeleitet, damit bereits gedruckte QR-Codes weiter funktionieren.
// =====================================================================

import { startHeartbeat } from './account.js';
import { initGate } from './gate.js';

const params = new URLSearchParams(window.location.search);
if (params.has('game')) {
  window.location.replace(`./quiz.html${window.location.search}`);
} else {
  startHeartbeat();
  initGate();
}
