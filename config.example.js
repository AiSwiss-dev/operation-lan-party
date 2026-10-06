// =====================================================================
//  OPERATION LAN PARTY – Konfiguration (Vorlage)
// =====================================================================
//
//  1. Diese Datei kopieren nach:   js/config.js
//  2. Die zwei Werte unten eintragen (Supabase → Project Settings → API).
//
//  Beim Veröffentlichen über GitHub Actions wird js/config.js automatisch
//  aus den Repository-Variablen SUPABASE_URL und SUPABASE_ANON_KEY erzeugt
//  (siehe README). js/config.js selbst steht in .gitignore.
//
//  WICHTIG
//  * Der anon/publishable Key ist ÖFFENTLICH. Er darf im Browser stehen.
//    Die Sicherheit kommt aus Row Level Security und den Server-Funktionen.
//  * NIEMALS den "service_role"- bzw. "secret"-Key hier eintragen!
//    (Die App verweigert den Start, wenn sie so einen Key erkennt.)
//
//  COMMANDER_PASSWORD?
//  Gibt es hier absichtlich NICHT. Ein Passwort in einer JavaScript-Datei
//  kann jeder Gast im Browser lesen – es wäre kein Geheimnis.
//  Das Commander-Passwort wird stattdessen verschlüsselt (bcrypt) in der
//  Datenbank gespeichert und serverseitig geprüft:
//
//      select public.set_commander_password('DEIN-GEHEIMES-PASSWORT');
//
//  (einmal im Supabase SQL Editor ausführen – siehe README)
// =====================================================================

export const CONFIG = {
  // z. B. "https://abcdefghijklmnop.supabase.co"
  SUPABASE_URL: "https://DEIN-PROJEKT.supabase.co",

  // "anon public" Key (eyJ…) oder neuer "publishable" Key (sb_publishable_…)
  SUPABASE_ANON_KEY: "DEIN-ANON-ODER-PUBLISHABLE-KEY",
};
