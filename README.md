# OPERATION LAN-PARTY // CS2 EINSATZPRÜFUNG

Multiplayer-Quiz für die LAN-Party / den Geburtstag von **njorgiBiceps** am **14.11.2026, 14:00 Uhr**.

Die Startseite bietet drei Bereiche: **01 QUIZ**, **02 GAME COUNTER** (Team-Bilanz + CS-Stats eures 5er-Teams) und **03 BRACKET** (1v1-Turnier) – siehe [Game Counter & Bracket](#game-counter--bracket). Dazu kommen ein **Operator-Login** für alle Bereiche und **MISSION OPS** (Anwesenheit, Hold-Screen) für den Commander – siehe [Login, Mission Ops & Hold-Screen](#login-mission-ops--hold-screen).

Der Host (du) zeigt **MISSION CONTROL** auf PC, TV oder Beamer. Die Gäste scannen einen QR-Code, wählen einen Callsign und spielen auf dem Smartphone mit – ohne App, einfach im Browser. 20 Counter-Strike-2-Fragen in zwei Phasen, synchronisierter Countdown, Punkte live, Zwischenranking, Siegerpodium, **TOP OPERATOR**, **MISSION ACCOMPLISHED**.

---

## Inhalt

1. [Was ist OPERATION LAN-PARTY?](#1-was-ist-operation-lan-party)
2. [Die Komponenten](#2-die-komponenten)
3. [Einrichtung Schritt für Schritt](#3-einrichtung-schritt-für-schritt)
4. [Am Partytag](#4-am-partytag)
5. [Lokal testen](#5-lokal-testen)
6. [Anpassungen](#6-anpassungen)
7. [Sicherheitsmodell](#7-sicherheitsmodell)
8. [Test vor der LAN (Checkliste)](#8-test-vor-der-lan-checkliste)
9. [Fehlerbehebung](#9-fehlerbehebung)
10. [Technische Entscheidungen](#10-technische-entscheidungen)
11. [Datenschutz & Lizenzen](#11-datenschutz--lizenzen)

---

## 1. Was ist OPERATION LAN-PARTY?

Eine Quiz-Web-App im Stil einer taktischen Special-Operations-Mission:

| Schritt | Host (PC/TV) | Spieler (Smartphone) |
|---|---|---|
| 1 | `host.html` öffnen → **COMMANDER LOGIN** → **NEUE MISSION** | – |
| 2 | Mission Code + QR-Code werden angezeigt | QR-Code scannen (Code ist vorausgefüllt) |
| 3 | Spieler erscheinen live in der Lobby | Callsign eingeben → **MISSION BEITRETEN** → „WAITING FOR COMMANDER“ |
| 4 | **MISSION STARTEN** | Alle bekommen gleichzeitig Frage 1 |
| 5 | Countdown (20 s), Antwortzähler | Antwort wählen → **ANTWORT BESTÄTIGEN** → „ANSWER LOCKED“ |
| 6 | **ERGEBNIS ANZEIGEN** | „TARGET ELIMINATED +165 PTS“ oder „TARGET MISSED 0 PTS“ |
| 7 | **NÄCHSTE FRAGE** … bis Frage 10 | … |
| 8 | **ZWISCHENRANKING** („PHASE I COMPLETE“) → **PHASE II STARTEN** | „PHASE I COMPLETE“, eigener Platz |
| 9 | Fragen 11–20 („VETERANENPRÜFUNG“) | … |
| 10 | **FINALE ANZEIGEN** → Podium, TOP OPERATOR, Rangliste, CSV-Export | „MISSION ACCOMPLISHED“, Platz, Rang |

**Punkte:** richtige Antwort = 100 Punkte + 5 Punkte pro verbleibender voller Sekunde. Falsch oder keine Antwort = 0.
Beispiel: 15 Sekunden übrig → 100 + 15 × 5 = **175 Punkte**. Da eine Antwort immer erst *nach* dem Start ankommt, bleiben höchstens 19 volle Sekunden → maximal **195 Punkte pro Frage**, **3.900 Punkte insgesamt**.

**Gleichstand:** Haben zwei Spieler gleich viele Punkte, liegt vorne, wer für seine richtigen Antworten insgesamt weniger Zeit gebraucht hat (Spalte „ZEIT“ im Finale).

**Ränge** (Anteil an 3.900 Punkten):

| Anteil | Rang | ab Punkten |
|---|---|---|
| 0–29 % | REKRUT | 0 |
| 30–49 % | OPERATOR | 1.170 |
| 50–69 % | VETERAN | 1.950 |
| 70–87 % | ELITE OPERATOR | 2.730 |
| 88–100 % | GLOBAL ELITE | 3.432 |

---

## 2. Die Komponenten

```
 Smartphones / PC                    GitHub Pages                      Supabase
 ┌──────────────┐   lädt Webseite   ┌────────────────┐               ┌───────────────────────┐
 │ index.html   │ ◀──────────────── │ HTML/CSS/JS    │               │ PostgreSQL-Datenbank  │
 │ host.html    │                   │ (statisch)     │               │  + Server-Funktionen  │
 └──────┬───────┘                   └────────────────┘               │  + Realtime           │
        │        Spielaktionen (RPC) + Live-Updates (Realtime)       │  + Row Level Security │
        └───────────────────────────────────────────────────────────▶└───────────────────────┘
```

* **Frontend – GitHub Pages:** Die Webseite (HTML, CSS, JavaScript). Kostenlos gehostet, kein Server nötig, kein Build-Schritt.
* **Backend – Supabase:** Datenbank für Missionen, Spieler, Antworten, Punkte. Alle Spielregeln (Deadline, richtig/falsch, Punkte, „nur eine Antwort“) laufen **in der Datenbank** – nicht auf dem Handy. Realtime sorgt dafür, dass alle Geräte sofort sehen, was passiert.

### Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Startseite: Auswahl Quiz / Game Counter / Bracket |
| `quiz.html` | Quiz – Spieler-Seite (Smartphone) |
| `host.html` | Quiz – MISSION CONTROL (PC/TV/Beamer) |
| `counter.html` + `js/counter.js` | Game Counter (Team-Bilanz) |
| `bracket.html` + `js/bracket.js` | 1v1-Bracket |
| `js/commander.js` | Commander-Login für Counter und Bracket |
| `login.html` + `js/login.js`, `js/account.js` | Operator-Login, Registrierung, Profil |
| `commander.html` + `js/ops.js` | MISSION OPS: Anwesenheit/Check-in, Accounts, Hold-Screen |
| `js/gate.js` | Hold-Screen (STANDBY bis alle eingecheckt sind) |
| `js/stats.js` | CS-Stats: Leaderboard, Match-Scoreboard, Eingabe |
| `css/style.css` | Komplettes Design (Farben ganz oben) |
| `js/player.js` | Logik der Spieler-Seite |
| `js/host.js` | Logik von MISSION CONTROL |
| `js/supabase-client.js` | Verbindung zu Supabase, Realtime |
| `js/sync.js` | Nachladen, Reconnect, Fallback bei Verbindungsproblemen |
| `js/clock.js` | Uhr-Synchronisation mit dem Server (Countdown auf allen Geräten gleich) |
| `js/questions.js` | Phasen-Namen, Rang-Schwellen, Event-Texte |
| `js/ui.js`, `js/utils.js` | Gemeinsame Bausteine (Countdown, Fortschritt, Hilfsfunktionen) |
| `js/audio.js` | Effekte (Web Audio API), Titelmusik + synchronisierte Bombe |
| `sounds/` | Titelmusik und Bombe (je .webm + .m4a) |
| `js/qr.js` | QR-Code-Erzeugung |
| `js/vendor/` | Mitgelieferte Bibliotheken (supabase-js 2.117.2, qrcode-generator 2.0.4) – kein CDN nötig |
| `config.example.js` | Vorlage für `js/config.js` |
| `supabase/schema.sql` | Komplettes Datenbankschema inkl. der 20 Fragen |
| `.github/workflows/pages.yml` | Automatische Veröffentlichung auf GitHub Pages |
| `tests/` | Automatische Tests (optional, siehe Abschnitt 10) |

---

## 3. Einrichtung Schritt für Schritt

Du brauchst: einen **GitHub**-Account, einen **Supabase**-Account (beide kostenlos) und **Git** auf deinem PC.

### Schritt 1 – Supabase-Projekt erstellen

1. Auf <https://supabase.com> gehen → **Start your project** → mit GitHub oder E-Mail anmelden.
2. **New project** klicken.
3. Name: z. B. `operation-lan-party`, ein Datenbank-Passwort vergeben (gut aufheben, wird für das Spiel aber nicht gebraucht), Region: **Central EU (Frankfurt)** oder **Zurich**, falls angeboten.
4. **Create new project** – ca. 1–2 Minuten warten, bis das Projekt bereit ist.

### Schritt 2 – Datenbank einrichten (`schema.sql`)

1. Im Supabase-Projekt links auf **SQL Editor** klicken.
2. **New query** (bzw. „+“).
3. Die Datei `supabase/schema.sql` mit einem Texteditor öffnen, **alles** kopieren und in den SQL Editor einfügen.
4. Unten rechts **Run** klicken.
5. Ganz unten erscheint eine Ergebniszeile: `fragen = 20`, `phase_1 = 10`, `phase_2 = 10`, `commander_passwort_gesetzt = 0`, `counter_bereit = 1`, `turnier_bereit = 1`.
   → Das ist richtig. Das Passwort kommt im nächsten Schritt.

> Das Script darf jederzeit erneut ausgeführt werden (z. B. nach dem Ändern von Fragen). Es löscht keine Spieldaten.

**Kontrolle:** Links auf **Table Editor** → es sollten die Tabellen `games`, `players`, `questions`, `answers`, `player_tokens`, `host_sessions`, `commander_config`, `login_attempts`, `game_rules` sowie für Counter/Turnier `counter_team`, `counter_matches`, `tournament` sichtbar sein. Bei allen steht „RLS enabled“ (Row Level Security aktiv) – das ist gewollt.

### Schritt 3 – Commander-Passwort setzen

Im SQL Editor eine **neue** Abfrage öffnen und (mit deinem eigenen Passwort, mindestens 8 Zeichen) ausführen:

```sql
select public.set_commander_password('MeinGeheimesLanPasswort!');
```

Antwort: `Commander-Passwort gesetzt. …` – fertig. Das Passwort wird nur verschlüsselt (bcrypt) gespeichert. Mit dem gleichen Befehl kannst du es jederzeit ändern (alle bestehenden Host-Logins werden dabei abgemeldet).

### Schritt 4 – Realtime prüfen

`schema.sql` schaltet Realtime für die Tabellen `games`, `players`, `counter_team`, `counter_matches` und `tournament` automatisch ein. Kontrolle:

* Links **Database** → **Publications** → Zeile `supabase_realtime` → dort müssen `games` und `players` aktiviert sein.
* Alternativ im **Table Editor** bei `games` bzw. `players`: Schalter/Hinweis „Realtime on“.

Falls dort nichts aktiv ist: die beiden Tabellen in der Publication `supabase_realtime` anhaken.
(Ohne Realtime funktioniert das Spiel trotzdem – die Geräte laden dann alle 2,5 Sekunden nach.)

### Schritt 5 – Project URL und anon/publishable Key finden

Im Supabase-Projekt oben auf **Connect** klicken – oder links **Project Settings** (Zahnrad):

* **Project URL** – unter *Data API* bzw. im Connect-Dialog, z. B. `https://abcdefghijklmnop.supabase.co`
* **Key** – unter *API Keys*:
  * entweder der **publishable key** (beginnt mit `sb_publishable_…`)
  * oder (Reiter *Legacy API Keys*) der **anon public** Key (beginnt mit `eyJ…`)

Beide funktionieren. **Niemals** den `service_role`- oder `secret`-Key (`sb_secret_…`) verwenden! Die App und der GitHub-Workflow verweigern den Start, wenn so ein Key auftaucht.

> Der anon/publishable Key ist öffentlich und darf im Browser sichtbar sein. Die Sicherheit kommt aus den Datenbank-Regeln (Row Level Security) und den Server-Funktionen – siehe [Sicherheitsmodell](#7-sicherheitsmodell).

### Schritt 6 – Konfiguration für den lokalen Test

1. Datei `config.example.js` kopieren und als `js/config.js` speichern (also in den Ordner `js`).
2. Die zwei Werte eintragen:

```js
export const CONFIG = {
  SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_xxxxxxxxxxxxxxxx",
};
```

`js/config.js` steht in `.gitignore` und wird **nicht** zu GitHub hochgeladen. Für GitHub Pages trägst du dieselben Werte in Schritt 8 als Repository-Variablen ein.

> **Warum gibt es kein `COMMANDER_PASSWORD` in der Konfiguration?** Alles, was in einer JavaScript-Datei steht, kann jeder Gast im Browser lesen (Rechtsklick → Quelltext). Ein Passwort dort wäre kein Geheimnis. Deshalb liegt das Commander-Passwort verschlüsselt in der Datenbank und wird serverseitig geprüft (Schritt 3).

Jetzt kannst du lokal testen → [Abschnitt 5](#5-lokal-testen).

### Schritt 7 – GitHub-Repository erstellen und Projekt hochladen

1. Auf <https://github.com> einloggen → oben rechts **+** → **New repository**.
2. Repository name: `operation-lan-party`, **Public** (für kostenloses GitHub Pages), *ohne* README/.gitignore anlegen → **Create repository**.
3. Auf deinem PC im Projektordner (`operation-lan-party`) ein Terminal öffnen (Windows: Ordner öffnen → in die Adresszeile `cmd` tippen → Enter) und ausführen:

```bash
git init
git add .
git commit -m "Initial Operation LAN Party"
git branch -M main
git remote add origin https://github.com/DEIN-GITHUB-NAME/operation-lan-party.git
git push -u origin main
```

Was die Befehle tun:

| Befehl | Bedeutung |
|---|---|
| `git init` | macht den Ordner zu einem Git-Projekt |
| `git add .` | merkt alle Dateien für den nächsten Speicherpunkt vor (`js/config.js` wird dank `.gitignore` ausgelassen) |
| `git commit -m "…"` | erstellt den Speicherpunkt mit Beschreibung |
| `git branch -M main` | nennt den Hauptzweig `main` |
| `git remote add origin …` | verbindet den Ordner mit deinem GitHub-Repository |
| `git push -u origin main` | lädt alles zu GitHub hoch |

Beim ersten `git push` fragt Git evtl. nach einer Anmeldung bei GitHub (Browserfenster). Spätere Änderungen hochladen:

```bash
git add .
git commit -m "Fragen angepasst"
git push
```

### Schritt 8 – Repository-Variablen anlegen

Damit GitHub die Datei `js/config.js` beim Veröffentlichen selbst erzeugt:

1. Im Repository auf **Settings** → links **Secrets and variables** → **Actions**.
2. Reiter **Variables** → **New repository variable**:
   * Name `SUPABASE_URL` → Wert: deine Project URL
   * Name `SUPABASE_ANON_KEY` → Wert: dein anon/publishable Key
3. Jeweils **Add variable**.

(Es sind bewusst *Variables* und keine *Secrets*: Die Werte landen sowieso öffentlich im Browser.)

### Schritt 9 – GitHub Pages aktivieren

1. Im Repository **Settings** → links **Pages**.
2. Bei **Build and deployment → Source** die Option **GitHub Actions** wählen.
3. Oben auf **Actions** klicken → Workflow **GitHub Pages veröffentlichen** → **Run workflow** (oder einfach erneut pushen).
4. Nach ca. 1 Minute ist der Lauf grün. Die Adresse steht im Lauf und unter Settings → Pages:

```
https://DEIN-GITHUB-NAME.github.io/operation-lan-party/
```

> Der Workflow bricht mit einer verständlichen Fehlermeldung ab, wenn die Variablen fehlen oder versehentlich ein Secret Key eingetragen wurde.

**Alternative ohne Actions:** Source „Deploy from a branch“ (main, / root) geht auch – dann musst du aber `js/config.js` mit committen (Zeile `js/config.js` aus `.gitignore` entfernen). Das ist unbedenklich, da nur öffentliche Werte drinstehen.

### Schritt 10 – Die beiden Adressen

| Wer | Adresse |
|---|---|
| Startseite | `https://DEIN-GITHUB-NAME.github.io/operation-lan-party/` |
| Quiz – Spieler | `https://DEIN-GITHUB-NAME.github.io/operation-lan-party/quiz.html` (oder QR-Code scannen) |
| Quiz – Host | `https://DEIN-GITHUB-NAME.github.io/operation-lan-party/host.html` |
| Game Counter | `https://DEIN-GITHUB-NAME.github.io/operation-lan-party/counter.html` |
| Bracket | `https://DEIN-GITHUB-NAME.github.io/operation-lan-party/bracket.html` |
| Login / Profil | `https://DEIN-GITHUB-NAME.github.io/operation-lan-party/login.html` |
| Mission Ops (Commander) | `https://DEIN-GITHUB-NAME.github.io/operation-lan-party/commander.html` |

Alte Links der Form `…/operation-lan-party/?game=CODE` werden automatisch zum Quiz weitergeleitet.

Der QR-Code wird automatisch aus der Adresse von `host.html` berechnet – du musst nirgends deinen GitHub-Namen eintragen. Alle Pfade sind relativ, die App funktioniert deshalb auch im Unterordner `/operation-lan-party/`.

---

## 4. Am Partytag

### Host (MISSION CONTROL)

1. PC/TV/Beamer: `https://DEIN-GITHUB-NAME.github.io/operation-lan-party/host.html` öffnen.
2. **COMMANDER LOGIN** mit dem Passwort aus Schritt 3.
3. **NEUE MISSION** → 6-stelliger Mission Code + großer QR-Code erscheinen.
4. Optional **VOLLBILD** und **SOUND ON** (Sound erst nach einem Klick möglich – Browser-Regel).
5. Gäste scannen den QR-Code. Jeder Beitritt erscheint sofort in der Lobby. Tippfehler oder Troll-Namen kannst du mit dem **×** neben dem Namen entfernen (nur in der Lobby).
6. **MISSION STARTEN** – ab jetzt kann niemand mehr neu beitreten („MISSION BEREITS GESTARTET“).
7. Pro Frage: 3 s „GET READY“, dann 20 s Antwortzeit. Du siehst „ANTWORTEN 7 / 10“ und wer schon geantwortet hat.
   * Wenn alle geantwortet haben: „ALLE ANTWORTEN EINGEGANGEN“
   * Nach Ablauf: „ZEIT ABGELAUFEN“
   * Vorzeitig beenden: **ANTWORTEN SCHLIESSEN**
8. **ERGEBNIS ANZEIGEN** → Lösung + Verteilung der Antworten, Spieler sehen ihr Ergebnis, Punkte werden gutgeschrieben.
9. **NÄCHSTE FRAGE** … nach Frage 10: **ZWISCHENRANKING** → **PHASE II STARTEN**.
10. Nach Frage 20: **FINALE ANZEIGEN** → Podium mit TOP OPERATOR, komplette Rangliste mit Rang.
11. Optional **ERGEBNIS EXPORTIEREN** (CSV: Platz; Callsign; Punkte; Rang) und **NEUE MISSION** für eine Revanche (neuer Code).

Der aktuell sinnvolle Button leuchtet orange. Buttons, die gerade nicht erlaubt sind, sind ausgegraut. Doppelklicks sind ungefährlich – der Server führt jeden Schritt nur einmal aus.

**MISSION ZURÜCKSETZEN** (mit Sicherheitsabfrage „MISSION WIRKLICH ZURÜCKSETZEN?“) schließt die Mission; alle Spieler sehen „MISSION ABGEBROCHEN“. Die Daten bleiben archiviert in der Datenbank.

**Browser neu geladen / PC abgestürzt?** Einfach `host.html` wieder öffnen – die laufende Mission wird automatisch wiederhergestellt (Login bleibt 48 Stunden gültig).

### Spieler

1. QR-Code scannen **oder** `https://DEIN-GITHUB-NAME.github.io/operation-lan-party/` öffnen → **QUIZ** → Mission Code eintippen.
2. Callsign (2–24 Zeichen) eingeben → **MISSION BEITRETEN**.
3. Warten bis der Commander startet, dann Antwort antippen → **ANTWORT BESTÄTIGEN**.

Reload, Display-Sperre oder kurzer WLAN-Ausfall sind kein Problem: Die Seite merkt sich den Spieler und landet wieder an der richtigen Stelle. Eine bereits abgegebene Antwort bleibt gesperrt.

### Game Counter & Bracket

Beide Bereiche sind unabhängig vom Quiz, laufen aber über dieselbe Supabase-Datenbank: Alle Geräte sehen Änderungen **live**. **Bearbeiten kann nur der Commander** – mit demselben Passwort wie MISSION CONTROL (oben rechts **COMMANDER LOGIN**; wer auf `host.html` eingeloggt ist, ist hier automatisch eingeloggt). **BEARBEITEN: AN/AUS** blendet die Eingabefelder aus, z. B. für die TV-Ansicht.

**02 GAME COUNTER – Bilanz eures 5er-Teams (CS2 Competitive)**

* Unter **TEAM & OPERATOREN BEARBEITEN** Teamname und die 5 Operatoren eintragen → **TEAM SPEICHERN**.
* Nach jedem Match: optional Map und Score (Runden, z. B. `13 : 9`) eintragen, dann **+ SIEG**, **+ NIEDERLAGE** oder **+ UNENTSCHIEDEN**. Mit Score wird das Ergebnis automatisch bestimmt (nur der passende Button ist aktiv).
* Anzeige: WINS / LOSSES / TIES, Winrate, aktuelle Serie, Form der letzten 10 Matches, Bilanz pro Map, Match-Log.
* Falsch eingetragen? Im Match-Log mit **×** löschen. **BILANZ ZURÜCKSETZEN** löscht alle Matches (Team bleibt).

**03 BRACKET – 1v1-Turnier für 4–8 Operatoren (Standard: 5)**

1. **Setup:** Commander trägt die Operatoren vorab ein → **SPIELER SPEICHERN** (alle sehen „OPERATORS REGISTERED“).
2. **AUSLOSEN & STARTEN:** Der Server lost zufällig die **Qualifikation**: Jeder spielt **genau 2 Duelle** (Ring: A–B, B–C, …, E–A; bei 5 Spielern 5 Duelle). Die Reihenfolge ist so gewählt, dass niemand zweimal direkt hintereinander spielt.
3. **Rangliste Quali:** Sieg 3 Punkte, Unentschieden 1, Niederlage 0 – bei Gleichstand zählt die Rundendifferenz, dann die gewonnenen Runden. **Top 4 → Halbfinale**, ab Platz 5 ausgeschieden.
4. **Playoffs:** HF 1 = Platz 1 vs Platz 4, HF 2 = Platz 2 vs Platz 3 → **FINALE** → **CHAMPION / TOP OPERATOR**.
5. **Lower Bracket:** Die Verlierer der Halbfinals spielen das **SPIEL UM PLATZ 3**. Unten rechts steht der **Endstand** (1.–4. aus den Playoffs, ab 5. aus der Quali).

* Scores einfach in die Felder tippen – wird sofort gespeichert; der höhere Score gewinnt, Ranglisten und Playoffs aktualisieren sich automatisch. Playoff-Felder sind gesperrt, bis die Gegner feststehen.
* **NEU AUSLOSEN** (neue Paarungen, Resultate weg), **RESULTATE LÖSCHEN** (Paarungen bleiben), **SPIELER ÄNDERN** (zurück zum Setup).
* Auf TV/Beamer passt alles auf einen Bildschirm (1920×1080), auf dem Handy untereinander.

> Neu dazugekommen? Dann im SQL Editor einmal `supabase/update-counter-bracket.sql` ausführen (oder `schema.sql` erneut komplett) – das legt die Tabellen für Counter, CS-Stats, Turnier, Accounts und Hold-Screen an. Quiz-Daten und Passwort bleiben erhalten.

### Login, Mission Ops & Hold-Screen

**Operator-Login (`login.html`)** – ein Account (Benutzername + Passwort) gilt für alles:

* **Quiz:** Eingeloggt erscheint auf der Quiz-Seite **ALS [NAME] BEITRETEN** – ohne QR-Code und ohne Mission Code, Callsign = Benutzername. Funktioniert auch auf mehreren Geräten und zum Wiedereinsteigen in eine laufende Mission. Gäste ohne Account nutzen weiter QR-Code bzw. Code + Callsign.
* **Game Counter:** Der Commander trägt das 5er-Team mit den **Benutzernamen** ein (Vorschläge aus den Accounts). Nach jedem Match trägt **jeder Spieler seine eigenen Stats** ein: Kills, Assists, Deaths, HS %, ADR, MVPs (**MEINE STATS EINTRAGEN** bzw. Banner oben). Daraus entstehen das **Squad Leaderboard** (sortierbar: K/D, ADR, HS % …) und ein **Scoreboard pro Match** (**STATS 3/5 ▾**).
* **Bracket:** Beim Setup Accounts antippen oder **EINGECHECKTE ÜBERNEHMEN**; der eigene Name ist grün markiert.
* **Profil:** Check-in-Status, aktuelle Quiz-Mission, eigene CS-Stats + offene Matches, Bracket-Teilnahme.
* Accounts kann jeder selbst anlegen (**NEU HIER? ACCOUNT ERSTELLEN**) oder der Commander vorab in MISSION OPS. Nach 8 falschen Passwörtern ist der Login 5 Minuten gesperrt; der Commander kann Passwörter zurücksetzen.

**MISSION OPS (`commander.html`, nur Commander)**

* **Anwesenheit:** Liste aller Operatoren mit **EINCHECKEN / ✓ ON SITE**, ONLINE-Anzeige (in den letzten 2–3 Minuten auf der Seite), Badges TEAM / BRACKET / QUIZ / STATS OFFEN. **Einchecken kann nur der Commander.** **ALLE EINCHECKEN / ALLE AUSCHECKEN** für alle auf einmal.
* Accounts **vorab anlegen**, **Passwort zurücksetzen**, **löschen**.
* Überblick: ON SITE x/y, Online, laufende Quiz-Mission, Hold-Screen-Status.

**Hold-Screen**

* In MISSION OPS **HOLD-SCREEN AKTIVIEREN** → Startseite, Quiz, Game Counter und Bracket zeigen allen den **STANDBY**-Bildschirm (z. B. **3 / 10 OPERATORS ON SITE** mit Namensliste).
* Sobald der Commander **alle** registrierten Operatoren eingecheckt hat, wird die Seite **automatisch und live auf allen Geräten freigegeben** (**MISSION UNLOCKED**). Danach bleibt sie offen, auch wenn jemand ausgecheckt wird.
* **MISSION JETZT FREIGEBEN** gibt sofort frei (z. B. wenn jemand nicht kommt – oder dessen Account löschen).
* Login, MISSION CONTROL und MISSION OPS bleiben während des Holds erreichbar.
* Hinweis: Der Hold-Screen ist eine Sperre der Oberfläche für die Party, keine Datensperre.

---

## 5. Lokal testen

Die Seiten nutzen JavaScript-Module. Diese funktionieren **nicht**, wenn man `index.html` einfach per Doppelklick (`file://`) öffnet. Du brauchst einen kleinen lokalen Webserver. Python reicht:

```bash
# im Projektordner (dort wo index.html liegt)
python -m http.server 8000
# (macOS/Linux ggf.: python3 -m http.server 8000)
```

Dann im Browser:

* Startseite: <http://localhost:8000/>
* Quiz – Spieler: <http://localhost:8000/quiz.html>
* Quiz – Host: <http://localhost:8000/host.html>
* Game Counter / Bracket: <http://localhost:8000/counter.html>, <http://localhost:8000/bracket.html>

Voraussetzung: `js/config.js` ist angelegt (Schritt 6) und `schema.sql` wurde in Supabase ausgeführt.

**Mit echten Handys im WLAN testen:** Unter `localhost` können Handys den PC nicht erreichen (die App zeigt dann einen Hinweis neben dem QR-Code). Öffne `host.html` stattdessen über die IP-Adresse des PCs, z. B. `http://192.168.1.50:8000/host.html` (IP unter Windows: `ipconfig` → „IPv4-Adresse“). Der QR-Code zeigt dann automatisch auf diese Adresse. Windows fragt evtl., ob Python im Netzwerk erlaubt werden soll → „Privates Netzwerk“ erlauben.

Zum Testen mit mehreren Spielern auf einem PC: mehrere Browser oder Inkognito-Fenster verwenden (jedes Fenster = eigener Spieler).

---

## 6. Anpassungen

### Fragen und Antworten ändern

Die Fragen stehen in **`supabase/schema.sql`**, Abschnitt **„2. FRAGEN“**:

```sql
(1, 1, 'Welche Waffe ist exklusiv für die Terroristen-Seite kaufbar?',
    'M4A1-S', 'AK-47', 'FAMAS', 'AUG', 'B'),
-- Nummer, Phase, Frage, A, B, C, D, richtige Option
```

Ändern → die **ganze** Datei erneut im Supabase SQL Editor ausführen. Fertig – keine Änderung an der Webseite nötig.

* Apostroph in einem Text: doppelt schreiben, z. B. `'Rock''n''Roll'`.
* Phase 1 = REKRUTENPRÜFUNG, Phase 2 = VETERANENPRÜFUNG. Das Zwischenranking kommt automatisch nach der letzten Frage von Phase 1.
* Mehr oder weniger Fragen gehen auch (Nummern fortlaufend, Phase 1 vor Phase 2). Zum Entfernen einer Frage zusätzlich ausführen: `delete from public.questions where question_index = 20;`

> Warum stehen die Fragen nicht in `js/questions.js`? Dann könnte jeder Spieler die richtigen Antworten im Browser nachlesen. So schickt der Server jedem Handy nur die aktuelle Frage – die Lösung erst nach **ERGEBNIS ANZEIGEN**.

### Timer und Punkte ändern

Im Supabase SQL Editor, z. B.:

```sql
update public.game_rules set
  question_duration_s = 30,   -- Sekunden pro Frage (Standard 20)
  base_points         = 100,  -- Punkte für richtige Antwort
  bonus_per_second    = 5,    -- Bonus pro verbleibender voller Sekunde
  lead_in_ms          = 3000, -- "GET READY"-Vorlauf in Millisekunden
  grace_ms            = 750,  -- Kulanz für Netzwerklatenz nach Ablauf
  max_players         = 64;   -- maximale Spieler pro Mission
```

Gilt für jede **neue** Mission (laufende Missionen behalten ihre Werte). Maximalpunktzahl und Ränge passen sich automatisch an.

### Rang-Schwellen ändern

`js/questions.js` → Liste `RANKS` (Prozent der Maximalpunktzahl). Danach speichern und – für GitHub Pages – pushen.

### Farben ändern

`css/style.css` → ganz oben im Block `:root`, z. B. `--orange: #f08a24;` oder `--dust: #c9b68f;`.

### Texte ändern

* Titel, Veranstalter, Datum, Uhrzeit: `js/questions.js` → `TEXT` und `PHASES`
* Meldungen (z. B. „CALLSIGN BEREITS VERGEBEN“): `js/utils.js` → `ERRORS`
* Bildschirm-Texte: direkt in `js/player.js` bzw. `js/host.js` (Suche nach dem Text)

### Sounds ändern

**Titelmusik und Bombe** (Dateien im Ordner `sounds/`):

| Datei | Wann | Wo |
|---|---|---|
| `titelmusic.webm` / `.m4a` | in Schleife in der **Lobby**, auf dem **Ergebnis-Screen** nach jeder Frage, im **Zwischenranking** und im **Finale**. Blendet aus, sobald eine Frage startet, und setzt danach dort fort, wo sie aufgehört hat (neue Mission = von vorn) | MISSION CONTROL + Handys |
| `bombsound.webm` / `.m4a` | während der Antwortzeit. Synchronisiert auf die Serverzeit: die **Explosion kommt genau bei 0** – auf allen Geräten gleichzeitig. **ANTWORTEN SCHLIESSEN** springt direkt zur Explosion, **ERGEBNIS ANZEIGEN** vor Ablauf blendet aus | MISSION CONTROL + Handys |

* Welches Gerät was abspielt: `js/questions.js` → `SOUND_SETUP`. Standard: großer Bildschirm **und** Handys. Handys still schalten: `player: { music: false, bomb: false }`.
* iPhone/Android geben Ton erst nach einem Tippen frei (das Tippen auf **MISSION BEITRETEN** reicht). Nach einem Neuladen erscheint unten ein Button **TIPPEN FÜR SOUND**. Beim iPhone ggf. den Lautlos-Schalter prüfen (ab iOS 17 wird er für das Quiz übergangen).
* Lautstärke und Explosionszeitpunkt: `js/questions.js` → `SOUND_FILES` (`volume` 0–1, `explosionAt` = Sekunde der Explosion in der Datei).
* Eigene Dateien: gleiche Namen verwenden, jeweils als `.webm` (Chrome/Edge/Firefox) **und** `.m4a` (Safari/iPhone). Umwandeln z. B. mit ffmpeg: `ffmpeg -i neu.mp3 -c:a libopus -b:a 128k sounds/titelmusic.webm` und `ffmpeg -i neu.mp3 -c:a aac -b:a 160k sounds/titelmusic.m4a`.
* Die Originale liegen in `M:\Quiz\sounds` (Bombe für die App um +6 dB angehoben, mit Limiter).
* Hinweis: Die Dateien werden mit der Webseite öffentlich ausgeliefert (GitHub Pages). Nur Dateien verwenden, die du verwenden darfst.

**Kurze Effekte** (Lock, Richtig, Falsch, Ticks): `js/audio.js` → Objekt `sfx`. Jeder Effekt besteht aus Tönen (`freq` = Tonhöhe in Hz, `dur` = Dauer in Sekunden, `vol` = Lautstärke) und ist selbst erzeugt. Läuft die Bombe, entfallen die synthetischen Countdown-Ticks auf diesem Gerät.

Ein-/Ausschalten per **SOUND ON/OFF** (wird pro Gerät gemerkt). Browser erlauben Ton erst nach einem Klick auf die Seite – nach einem Reload von MISSION CONTROL also einmal irgendwo hinklicken.

### Commander-Zugang ändern

```sql
select public.set_commander_password('NeuesPasswort123');
```

Alle bestehenden Host-Logins werden dabei abgemeldet. Nach 15 falschen Passwörtern innerhalb von 10 Minuten wird der Login für einige Minuten gesperrt („ZU VIELE FEHLVERSUCHE“). Die Sperre gilt für alle Geräte – ein bereits eingeloggter Host-PC bleibt aber eingeloggt. **Tipp:** Am Partytag schon vor dem Eintreffen der Gäste auf dem Host-PC einloggen.

---

## 7. Sicherheitsmodell

**Grundsatz:** Alles im Browser ist öffentlich. Deshalb entscheidet ausschließlich die Datenbank.

| Bedrohung | Schutz |
|---|---|
| Spieler liest die richtige Antwort vorab | Tabelle `questions` ist für den Browser gesperrt (RLS ohne Policy + keine Rechte). Die Lösung liefert nur `get_player_state`, und zwar erst nach der Freigabe durch den Host. |
| Spieler setzt eigenen Score / „is_correct“ | Kein Schreibrecht auf Tabellen. `submit_answer` nimmt nur Spieler, Token, Frage und Option entgegen – richtig/falsch, Zeit und Punkte berechnet der Server. |
| Doppelte Antwort (Reload, 2. Tab, API-Aufruf) | `UNIQUE(player_id, game_id, question_index)` + Prüfung in `submit_answer`. Die erste Antwort zählt. |
| Antwort nach Ablauf | Server prüft `question_ends_at` mit eigener Uhr (750 ms Kulanz für Netzlatenz, Bonus dann 0). |
| Antworten im Namen anderer | Jeder Spieler hat ein geheimes Token (nur als SHA-256-Hash gespeichert, getrennt von der öffentlichen Spielertabelle). |
| Fremde Antworten lesen | Tabelle `answers` ist gesperrt. Öffentlich ist nur, *ob* jemand geantwortet hat. |
| Mission steuern ohne Host | Alle Host-Funktionen verlangen ein Host-Session-Token. Dieses gibt es nur nach `host_login` mit dem bcrypt-geprüften Passwort. Brute-Force-Bremse: 15 Fehlversuche / 10 Min. |
| Richtigkeit vor der Freigabe erraten (z. B. über Live-Punkte) | Punkte werden erst beim **ERGEBNIS ANZEIGEN** gutgeschrieben; `submit_answer` antwortet nur „LOCKED“. |
| Doppelklick / gleichzeitige Aktionen | `host_advance` erwartet den aktuellen Zustand; Zeilensperren (`FOR UPDATE` / `FOR SHARE`) verhindern Rennen zwischen „Ergebnis anzeigen“ und eingehenden Antworten bzw. „Starten“ und Beitritten. |
| HTML/Script im Callsign (XSS) | Callsigns werden nie als HTML eingefügt (nur `textContent`). Zusätzlich lehnt der Server `<`, `>`, Steuer- und unsichtbare Zeichen ab. Content-Security-Policy erlaubt nur eigene Skripte. |
| Service-Role-Key im Browser | Wird von App und Workflow erkannt und blockiert. |
| Manipulierte Uhr am Handy | Countdown basiert auf der Serverzeit (Messung des Versatzes), Deadline prüft der Server. |

**Accounts:** Passwörter nur als bcrypt-Hash, Tabellen `accounts`/`account_sessions` für den Browser komplett gesperrt; Login-Sperre nach 8 Fehlversuchen; CS-Stats kann nur der eingeloggte Spieler selbst eintragen (und nur, wenn er im 5er-Team ist); Check-in nur mit Commander-Token.

**Was öffentlich lesbar ist:** Tabelle `games` (Code, Status, aktuelle Frage, Zeiten) und `players` (Callsign, Punkte, ob geantwortet), außerdem Game Counter, CS-Stats, Turnier und der Hold-Status – sowie die Liste der Benutzernamen (ohne Passwörter). Das ist für Lobby-Liste und Realtime nötig und enthält keine Geheimnisse. Wer den anon Key nutzt, könnte theoretisch Mission Codes auflisten und einer Lobby beitreten – für eine private Party unkritisch; der Host kann Fremde in der Lobby entfernen.

**Grenzen:** Ein Spieler mit zwei Handys kann zwei Callsigns anlegen. Das ist bei einem Party-Quiz ohne Konten nicht zu verhindern – der Host sieht aber alle Namen in der Lobby.

---

## 8. Test vor der LAN (Checkliste)

Mindestens **ein paar Tage vorher** (kostenlose Supabase-Projekte pausieren nach ca. 1 Woche ohne Nutzung – vorher einmal das Dashboard öffnen bzw. testen; ein pausiertes Projekt im Dashboard mit **Restore** wieder starten):

- [ ] `https://DEIN-GITHUB-NAME.github.io/operation-lan-party/host.html` öffnet MISSION CONTROL (kein „KONFIGURATION FEHLT“)
- [ ] Commander Login klappt, falsches Passwort wird abgelehnt
- [ ] **NEUE MISSION** zeigt Code + QR-Code, LED oben rechts zeigt **LIVE** (grün)
- [ ] Handy 1 (iPhone/Safari) scannt den QR-Code → Code ist vorausgefüllt → Callsign → Lobby
- [ ] Handy 2 (Android/Chrome) gibt den Code **manuell** ein → Lobby
- [ ] Beide Namen erscheinen sofort auf dem Host und auf beiden Handys
- [ ] Gleicher Callsign in anderer Schreibweise (z. B. `rushb` statt `RushB`) → „CALLSIGN BEREITS VERGEBEN“
- [ ] **MISSION STARTEN** → beide Handys zeigen gleichzeitig „GET READY“ und dann Frage 1, Countdowns laufen synchron mit dem Host
- [ ] Handy 1 antwortet → „ANSWER LOCKED“; Seite neu laden → bleibt „ANSWER LOCKED“
- [ ] Handy 2 antwortet nicht → nach 0 „TIME EXPIRED“
- [ ] **ERGEBNIS ANZEIGEN** → Handy 1 „TARGET ELIMINATED +xxx PTS“, Handy 2 „TIME EXPIRED 0 PTS“
- [ ] Ein drittes Gerät versucht nach dem Start beizutreten → „MISSION BEREITS GESTARTET“
- [ ] Handy kurz in den Flugmodus → „VERBINDUNG ZUM HQ VERLOREN / RECONNECTING…“ → wieder online → Spiel geht weiter
- [ ] Host-Seite neu laden → Mission ist wieder da
- [ ] Bis Frage 10 durchklicken → **ZWISCHENRANKING** → **PHASE II STARTEN**
- [ ] Bis Frage 20 → **FINALE ANZEIGEN** → Podium mit TOP OPERATOR, Handys zeigen „MISSION ACCOMPLISHED“
- [ ] Sound am TV hörbar (einmal auf die Seite klicken, SOUND ON)
- [ ] Ranking und QR-Code aus einigen Metern Entfernung lesbar (Browser-Zoom bei Bedarf mit Strg + / Strg −)
- [ ] Danach **MISSION ZURÜCKSETZEN** oder **NEUE MISSION** für den echten Start

---

## 9. Fehlerbehebung

| Meldung / Problem | Lösung |
|---|---|
| „KONFIGURATION FEHLT“ | Lokal: `js/config.js` fehlt (Schritt 6). GitHub Pages: Variablen fehlen (Schritt 8) → Workflow erneut laufen lassen. |
| „KONFIGURATION UNVOLLSTÄNDIG“ | In `js/config.js` stehen noch Platzhalter. |
| „SICHERHEITSALARM: SECRET KEY IM BROWSER“ | Falscher Key eingetragen. Durch anon/publishable Key ersetzen und im Supabase-Dashboard den Secret Key erneuern. |
| „HQ NICHT EINGERICHTET“ | `schema.sql` wurde nicht (vollständig) ausgeführt → Schritt 2 wiederholen. |
| „SUPABASE-KEY UNGÜLTIG“ | Key falsch kopiert (Leerzeichen?) oder Projekt pausiert. |
| „KEIN COMMANDER-PASSWORT GESETZT“ | Schritt 3 ausführen. |
| „ZU VIELE FEHLVERSUCHE“ | 10 Minuten warten. |
| LED zeigt **SYNC** (orange) statt **LIVE** | Realtime nicht aktiv → Schritt 4. Das Spiel funktioniert trotzdem (Nachladen alle 2,5 s). |
| Seite ist weiß / lädt nicht (lokal) | Nicht per Doppelklick öffnen, sondern über `python -m http.server` (Abschnitt 5). |
| Handys erreichen den lokalen Test nicht | Host über die PC-IP statt `localhost` öffnen, Windows-Firewall für Python erlauben, Handy im selben WLAN. |
| Kein Ton | Einmal auf die Seite klicken/tippen (Browser-Regel), SOUND ON prüfen, beim iPhone den Stummschalter prüfen. |
| Mission hängt / falscher Stand | Seite neu laden – der Zustand kommt immer frisch aus der Datenbank. |
| GitHub Pages zeigt 404 | Settings → Pages → Source „GitHub Actions“; Actions-Lauf grün? Adresse mit `/operation-lan-party/` am Ende. |

---

## 10. Technische Entscheidungen

* **Kein Framework, kein Build:** Vanilla JavaScript mit ES-Modulen. GitHub Pages liefert die Dateien direkt aus.
* **Bibliotheken lokal statt CDN:** `supabase-js` (2.117.2, als eine Datei gebündelt) und `qrcode-generator` (2.0.4) liegen in `js/vendor/`. Kein externer Server außer Supabase nötig, keine Versionsüberraschungen am Partytag.
* **Spiellogik in PostgreSQL-Funktionen (RPC):** atomar, mit Zeilensperren, nicht manipulierbar. Der Browser stellt nur dar.
* **Realtime nur als Auslöser:** Ein Realtime-Event sagt „es hat sich etwas geändert“, der Client lädt dann den vollständigen Zustand per RPC. Doppelte, verspätete oder verlorene Events können dadurch keinen falschen Zustand erzeugen (zusätzlich Versionsnummer `state_version`).
* **Fallback:** Ohne Realtime-Verbindung lädt jedes Gerät alle 2,5 s nach, mit Realtime alle 15 s zur Sicherheit. Bei Netzwerkfehlern: Meldung + Wiederholung mit wachsender Pause, der letzte Stand bleibt sichtbar.
* **Timer:** Der Server setzt `question_started_at` / `question_ends_at`. Jedes Gerät misst beim Start mehrfach den Versatz zur Serveruhr (Laufzeit / 2 = Latenz) und rechnet den Countdown daraus – mit `performance.now()`, also unabhängig von der Handy-Uhr. 3 s „GET READY“-Vorlauf, damit alle gleichzeitig starten.
* **Spieler-Identität:** Beim Beitritt gibt der Server eine Player-ID + geheimes Token zurück, gespeichert im `localStorage` des Handys (pro Mission Code). Reload/zweiter Tab = derselbe Spieler.
* **Host-Identität:** Passwort → Session-Token (48 h), im `localStorage` des Host-PCs. Die zuletzt geöffnete Mission wird gemerkt.
* **Spätes Beitreten:** nach **MISSION STARTEN** gesperrt („MISSION BEREITS GESTARTET“). Bereits beigetretene Spieler können jederzeit zurückkehren.
* **Zurücksetzen:** setzt den Status auf `aborted` (archivieren statt löschen).

### Getestet

* Accounts, Quiz-Login, CS-Stats, Mission Ops, Hold-Screen: **58 Datenbank-Prüfungen** (Rechte, kein Selbst-Check-in, Login-Sperre, Mehrgeräte-Beitritt, nur Team-Spieler dürfen Stats eintragen, automatische Freigabe) und **34 Browser-Prüfungen** (Registrierung → Commander checkt ein → Hold-Screen gibt live frei → Quiz ohne Code → Stats durch die Spieler → Leaderboard → Bracket-Übernahme).
* Game Counter + Bracket: **55 Datenbank-Prüfungen** (Rechte, Validierung, Score→Ergebnis, Auslosung für 4–8 Spieler: jeder genau 2×, keine Doppel-Paarung, niemand zweimal hintereinander) und **42 Browser-Prüfungen** (Startseite, Commander + Live-Zuschauer, Quali-Rangliste, Halbfinale 1–4/2–3, Platz 3, Endstand, TV-Darstellung 1920×1080 ohne Scrollen).
* `schema.sql` mit echtem PostgreSQL (PGlite) als `anon`-Rolle: **154 Prüfungen** – RLS, Rechte, Deadline + Kulanz, Doppelantwort, Punkte (175 bei 15 s, max. 195), Phasenwechsel, Finale, Brute-Force-Sperre, Manipulationsversuche, mehrfaches Ausführen des Scripts.
* Kompletter Ablauf im echten Browser (Chrome headless), App unter dem Unterpfad `/operation-lan-party/` wie bei GitHub Pages, Server-Funktionen aus dem echten `schema.sql`: Host + 10 Spieler, alle 20 Fragen, QR-Code-Dekodierung, doppelter/HTML-Callsign, Reload, zweiter Tab, direkter API-Doppel-Submit, Doppelklicks, spätes Beitreten, Kicken, Verbindungsabbruch + Reconnect, Host-Reload, Zwischenranking, Finale, Tie-Breaker, CSV-Export, Reset; Darstellung bei 320/375/390/430/768 px sowie 1280×720, 1600×900, 1920×1080. **105 Prüfungen mit nachgebildetem Supabase-Realtime** (Event-Laufzeit ~0,2 s) und **100 Prüfungen mit blockiertem Realtime** (reiner Fallback).
* Fehlerseiten bei fehlender/falscher Konfiguration inkl. Secret-Key-Erkennung.
* Nicht automatisiert testbar ohne deine Zugangsdaten: das echte Supabase-Projekt und echte iPhone/Android-Geräte → bitte die [Checkliste](#8-test-vor-der-lan-checkliste) durchgehen.

### Tests selbst ausführen (optional, für Entwickler)

Voraussetzung: [Node.js](https://nodejs.org) 20+ und Google Chrome. Die Tests brauchen **kein** Supabase-Konto.

```bash
cd tests
npm install
npm test            # SQL + Konfigurations-Fehlerseiten + kompletter Browser-Durchlauf
npm run sql         # nur Datenbank
RT=0 npm run e2e    # Browser-Durchlauf ohne Realtime (macOS/Linux; Windows PowerShell: $env:RT=0; npm run e2e)
```

Screenshots landen in `tests/screenshots/`. Der Ordner `tests/` wird nicht auf GitHub Pages veröffentlicht.

---

## 11. Datenschutz & Lizenzen

* Gespeichert wird nur der **Callsign** (kein Name, keine E-Mail, kein Konto). Keine Tracker, keine Werbung, keine Analytics, keine externen Schriften.
* Alte Missionen kannst du in Supabase löschen: `delete from public.games;` (löscht alle Missionen samt Spielern und Antworten – Fragen bleiben).
* Eigenes Design, keine Valve-/CS2-Grafiken oder -Logos. Die Audiodateien in `sounds/` wurden vom Veranstalter hinzugefügt. „Counter-Strike“ ist eine Marke der Valve Corporation; dieses Projekt ist ein privates Fan-Quiz ohne Verbindung zu Valve.
* Mitgelieferte Bibliotheken: [supabase-js](https://github.com/supabase/supabase-js) (MIT), [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) von Kazuhiko Arase (MIT). „QR Code“ ist eine Marke der DENSO WAVE INCORPORATED.
