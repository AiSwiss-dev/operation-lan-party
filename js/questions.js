// =====================================================================
//  Phasen, Ränge und Anzeige-Texte
// =====================================================================
//
//  DIE FRAGEN SELBST stehen NICHT hier, sondern in supabase/schema.sql
//  (Abschnitt "2. FRAGEN"). Grund: Die richtigen Antworten dürfen nie an
//  die Smartphones ausgeliefert werden. Der Server schickt jedem Gerät nur
//  die aktuelle Frage mit den vier Antwortmöglichkeiten – die Lösung erst,
//  nachdem der Commander das Ergebnis freigegeben hat.
//
//  Punkte und Timer stehen ebenfalls in der Datenbank (Tabelle game_rules),
//  damit sie nicht vom Browser manipuliert werden können.
// =====================================================================

export const PHASES = {
  1: { label: 'PHASE I', name: 'REKRUTENPRÜFUNG' },
  2: { label: 'PHASE II', name: 'VETERANENPRÜFUNG' },
};

// Ränge nach Anteil an der maximal möglichen Punktzahl (in Prozent).
// Maximal möglich = Anzahl Fragen × (100 + 19 × 5) = 20 × 195 = 3900 Punkte.
// Reihenfolge: von oben nach unten, der erste passende Eintrag gewinnt.
export const RANKS = [
  { min: 88, title: 'GLOBAL ELITE' },
  { min: 70, title: 'ELITE OPERATOR' },
  { min: 50, title: 'VETERAN' },
  { min: 30, title: 'OPERATOR' },
  { min: 0, title: 'REKRUT' },
];

export const TEXT = {
  org: 'OPERATION LAN PARTY // SPECIAL OPERATIONS',
  title: 'OPERATION LAN PARTY',
  subtitle: 'CS2 EINSATZPRÜFUNG',
  commander: 'havoc',
  eventDate: '14.11.2026',
  eventTime: '14:00',
};

// Audiodateien im Ordner sounds/ – jeweils als .webm und .m4a vorhanden,
// der Browser nimmt automatisch das Format, das er abspielen kann.
//   volume       0 … 1
//   explosionAt  Sekunde in bombsound, an der die Explosion beginnt. Die Datei
//                wird so gestartet, dass dieser Moment genau auf 0 des
//                Countdowns fällt (bei 20 s Antwortzeit: Start ab Sekunde 0,95).
export const SOUND_FILES = {
  music: { base: './sounds/titelmusic', volume: 0.4, loop: true },
  bomb: { base: './sounds/bombsound', volume: 1.0, loop: false, explosionAt: 20.95, length: 25.7 },
};

// Welches Gerät spielt Musik und Bombe ab? Die kurzen Effekte (Lock,
// Richtig, Falsch …) laufen unabhängig davon auf allen Geräten.
// Die Bombe ist auf allen Geräten auf die Serverzeit synchronisiert.
// Musik: Lobby, Ergebnis nach jeder Frage, Zwischenranking und Finale.
export const SOUND_SETUP = {
  host: { music: true, bomb: true },   // MISSION CONTROL (PC/TV/Beamer)
  player: { music: true, bomb: true }, // Smartphones (false = Handy bleibt still)
};

export function phaseInfo(phase) {
  return PHASES[phase] || { label: `PHASE ${phase}`, name: '' };
}

export function rankFor(score, maxScore) {
  const pct = maxScore > 0 ? Math.max(0, Math.min(100, (score / maxScore) * 100)) : 0;
  const rank = RANKS.find((r) => pct >= r.min) || RANKS[RANKS.length - 1];
  return { title: rank.title, pct: Math.round(pct) };
}
