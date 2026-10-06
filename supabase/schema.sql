-- =====================================================================
--  OPERATION LAN-PARTY // CS2 EINSATZPRÜFUNG
--  Supabase / PostgreSQL – komplettes Datenbankschema
-- =====================================================================
--
--  AUSFÜHREN
--    Supabase Dashboard → SQL Editor → "New query" → gesamten Inhalt
--    dieser Datei einfügen → "Run".
--
--  DANACH (einmalig, eigene Abfrage im SQL Editor):
--    select public.set_commander_password('DEIN-GEHEIMES-PASSWORT');
--
--  MEHRFACH AUSFÜHRBAR
--    Das Script ist idempotent: Es legt nur an, was fehlt, ersetzt die
--    Funktionen durch die aktuelle Version und aktualisiert die Fragen.
--    Es löscht KEINE Spieldaten.
--    Einzige DROP-Befehle: "DROP POLICY IF EXISTS" (die Policies werden
--    direkt danach identisch neu angelegt).
--
--  SICHERHEITSMODELL (Kurzfassung, Details im README)
--    * Der Browser kennt nur den öffentlichen anon/publishable Key.
--    * Direkt lesbar (für Realtime) sind nur die Tabellen "games" und
--      "players" – und zwar NUR lesend.
--    * Alle Schreibzugriffe laufen über die RPC-Funktionen weiter unten
--      (SECURITY DEFINER). Sie prüfen Spielstatus, Deadline, Spieler-Token
--      bzw. Host-Session und berechnen Punkte ausschließlich serverseitig.
--    * Fragen inkl. richtiger Antwort, Antworten, Tokens, Host-Sessions
--      und das Commander-Passwort sind für den Browser nicht lesbar.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;


-- =====================================================================
-- 1. TABELLEN
-- =====================================================================

-- Spielregeln (eine Zeile). Neue Missionen übernehmen diese Werte.
-- Ändern z. B.:  update public.game_rules set question_duration_s = 30;
create table if not exists public.game_rules (
  id                  int primary key default 1 check (id = 1),
  question_duration_s int not null default 20  check (question_duration_s between 5 and 120),
  base_points         int not null default 100 check (base_points between 0 and 10000),
  bonus_per_second    int not null default 5   check (bonus_per_second between 0 and 1000),
  lead_in_ms          int not null default 3000 check (lead_in_ms between 0 and 10000),
  grace_ms            int not null default 750  check (grace_ms between 0 and 5000),
  max_players         int not null default 64   check (max_players between 1 and 500)
);
insert into public.game_rules (id) values (1) on conflict (id) do nothing;

-- Commander-Passwort (bcrypt-Hash, eine Zeile)
create table if not exists public.commander_config (
  id            int primary key default 1 check (id = 1),
  password_hash text not null,
  updated_at    timestamptz not null default now()
);

-- Host-Sessions (nur der SHA-256-Hash des Tokens wird gespeichert)
create table if not exists public.host_sessions (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Login-Versuche (Brute-Force-Bremse)
create table if not exists public.login_attempts (
  id           bigint generated always as identity primary key,
  attempted_at timestamptz not null default now(),
  success      boolean not null
);
create index if not exists login_attempts_time_idx on public.login_attempts (attempted_at);

-- Missionen / Spielsessions
create table if not exists public.games (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique check (code ~ '^[1-9][0-9]{5}$'),
  status              text not null default 'lobby'
                      check (status in ('lobby','question','results','phase_break','finished','aborted')),
  current_question    int  not null default 0 check (current_question >= 0),
  phase               int  not null default 1 check (phase in (1, 2)),
  question_started_at timestamptz,
  question_ends_at    timestamptz,
  state_version       bigint not null default 1,
  duration_s          int not null check (duration_s between 5 and 120),
  base_points         int not null,
  bonus_per_second    int not null,
  lead_in_ms          int not null,
  grace_ms            int not null,
  max_players         int not null,
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists games_created_at_idx on public.games (created_at desc);

-- Spieler (Operatoren)
create table if not exists public.players (
  id                  uuid primary key default gen_random_uuid(),
  game_id             uuid not null references public.games (id) on delete cascade,
  callsign            text not null check (char_length(callsign) between 2 and 24),
  callsign_normalized text not null,
  score               int  not null default 0,
  correct_time_ms     bigint not null default 0,   -- Tie-Breaker: Summe der Antwortzeiten richtiger Antworten
  answered_question   int  not null default 0,
  joined_at           timestamptz not null default now(),
  last_seen           timestamptz not null default now(),
  constraint players_unique_callsign unique (game_id, callsign_normalized)
);
create index if not exists players_game_idx on public.players (game_id);
-- für Installationen einer früheren Version dieses Scripts
alter table public.players add column if not exists correct_time_ms bigint not null default 0;

-- Geheime Spieler-Tokens (getrennt, damit die öffentliche players-Tabelle
-- keinerlei Geheimnisse enthält)
create table if not exists public.player_tokens (
  player_id  uuid primary key references public.players (id) on delete cascade,
  token_hash text not null unique
);

-- Fragen inkl. Antwortschlüssel – für den Browser NICHT lesbar
create table if not exists public.questions (
  question_index int primary key check (question_index between 1 and 200),
  phase          int  not null check (phase in (1, 2)),
  question_text  text not null,
  option_a       text not null,
  option_b       text not null,
  option_c       text not null,
  option_d       text not null,
  correct_option char(1) not null check (correct_option in ('A','B','C','D'))
);

-- Abgegebene Antworten – für den Browser NICHT lesbar
create table if not exists public.answers (
  id               uuid primary key default gen_random_uuid(),
  game_id          uuid not null references public.games (id) on delete cascade,
  player_id        uuid not null references public.players (id) on delete cascade,
  question_index   int  not null,
  selected_option  char(1) not null check (selected_option in ('A','B','C','D')),
  is_correct       boolean not null,
  response_time_ms int not null check (response_time_ms >= 0),
  points           int not null check (points >= 0),
  created_at       timestamptz not null default now(),
  constraint answers_one_per_question unique (player_id, game_id, question_index)
);
create index if not exists answers_game_q_idx on public.answers (game_id, question_index);


-- =====================================================================
-- 2. FRAGEN (werden bei jedem Ausführen aktualisiert)
--    Spalten: Nummer, Phase, Frage, A, B, C, D, richtige Option
-- =====================================================================

insert into public.questions
  (question_index, phase, question_text, option_a, option_b, option_c, option_d, correct_option)
values
  -- PHASE I – REKRUTENPRÜFUNG
  (1, 1, 'Welche Waffe ist exklusiv für die Terroristen-Seite kaufbar?',
      'M4A1-S', 'AK-47', 'FAMAS', 'AUG', 'B'),
  (2, 1, 'Wie hoch ist das reguläre maximale Guthaben eines Spielers?',
      '10.000 $', '12.000 $', '16.000 $', '20.000 $', 'C'),
  (3, 1, 'Welche Ausrüstung beschleunigt das Entschärfen des C4?',
      'Defuse Kit', 'Tactical Shield', 'Zeus x27', 'Rescue Kit', 'A'),
  (4, 1, 'Welche Granate verursacht direkten Explosionsschaden?',
      'Smoke Grenade', 'Flashbang', 'Decoy Grenade', 'HE Grenade', 'D'),
  (5, 1, 'Welche ikonische Wüstenmap besitzt Bombsite A und B?',
      'Nuke', 'Vertigo', 'Dust II', 'Office', 'C'),
  (6, 1, 'Welche Utility erzeugt eine Rauchwand?',
      'Molotov', 'Smoke Grenade', 'Flashbang', 'Decoy', 'B'),
  (7, 1, 'Welche Waffe ist für extrem hohen Einzelschussschaden und Scope bekannt?',
      'P90', 'AWP', 'Nova', 'MAC-10', 'B'),
  (8, 1, 'Was passiert typischerweise mit der Genauigkeit vieler Waffen beim Laufen?',
      'Sie steigt', 'Sie nimmt ab', 'Sie bleibt identisch', 'Rückstoß verschwindet', 'B'),
  (9, 1, 'Wie können CTs nach einem erfolgreichen Bomb-Plant noch gewinnen?',
      'Durch rechtzeitiges Entschärfen', 'Durch Waffen-Drop', 'Durch Spawn-Wechsel', 'Gar nicht mehr', 'A'),
  (10, 1, 'Kann ein CT die AK-47 regulär direkt in seinem Kaufmenü kaufen?',
      'Ja', 'Nein', 'Nur mit Defuse Kit', 'Nur in Overtime', 'B'),
  -- PHASE II – VETERANENPRÜFUNG
  (11, 2, 'Welche Waffenkategorie bietet bei vielen Waffen hohe Kill-Belohnungen?',
      'Sniper', 'Maschinenpistolen', 'Rifles', 'Schwere Pistolen', 'B'),
  (12, 2, 'Wie heißt auf Dust II der lange Zugang über Long Doors zur A-Site?',
      'Long A', 'Connector', 'Ramp B', 'Short B', 'A'),
  (13, 2, 'Welche Utility kann einen CS2-Smoke durch ihre Explosion vorübergehend aufreißen?',
      'Flashbang', 'Decoy', 'HE Grenade', 'Molotov', 'C'),
  (14, 2, 'Wie lange dauert ein Defuse MIT Kit?',
      '3 Sekunden', '5 Sekunden', '7 Sekunden', '10 Sekunden', 'B'),
  (15, 2, 'Was ist das Hauptziel eines taktischen „Save“?',
      'Ausrüstung für die nächste Runde retten', 'Uhr beschleunigen', 'Bombe automatisch entschärfen', 'Spawn wählen', 'A'),
  (16, 2, 'Was können Schüsse mit einem volumetrischen CS2-Smoke machen?',
      'Kurzzeitig kleine Sichtöffnungen erzeugen', 'Ihn permanent löschen', 'Ihn einfrieren', 'Nichts', 'A'),
  (17, 2, 'Was bedeutet „Wallbang“?',
      'Granate abprallen lassen', 'Durch eine durchdringbare Oberfläche schießen', 'Wand mit Messer treffen', 'Smoke an die Wand werfen', 'B'),
  (18, 2, 'Was beschreibt „Default spielen“ am ehesten?',
      'Kontrolliert verteilen, Informationen und Map-Kontrolle sammeln', 'Sofort als Fünfer-Rush angreifen', 'Nur Pistolen kaufen', 'Bombe im Spawn lassen', 'A'),
  (19, 2, 'Kann eine HE-Explosion einen Smoke vorübergehend verdrängen?',
      'Wahr', 'Falsch', 'Nur auf Dust II', 'Nur als CT', 'A'),
  (20, 2, 'Wie lange dauert ein Defuse OHNE Kit?',
      '5 Sekunden', '7 Sekunden', '10 Sekunden', '12 Sekunden', 'C')
on conflict (question_index) do update set
  phase          = excluded.phase,
  question_text  = excluded.question_text,
  option_a       = excluded.option_a,
  option_b       = excluded.option_b,
  option_c       = excluded.option_c,
  option_d       = excluded.option_d,
  correct_option = excluded.correct_option;


-- =====================================================================
-- 3. INTERNE HILFSFUNKTIONEN (für den Browser NICHT aufrufbar)
-- =====================================================================

create or replace function public._sha256(p text)
returns text language sql immutable set search_path = ''
as $$ select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex') $$;

-- 244 Bit Zufall aus zwei kryptografisch erzeugten UUIDs
create or replace function public._new_token()
returns text language sql volatile set search_path = ''
as $$ select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;

create or replace function public._ms(p timestamptz)
returns bigint language sql immutable set search_path = ''
as $$ select case when p is null then null else floor(extract(epoch from p) * 1000)::bigint end $$;

-- Callsign säubern: Unicode normalisieren, Leerraum zusammenfassen, trimmen
create or replace function public._clean_callsign(p text)
returns text language sql stable set search_path = ''
as $$
  select btrim(regexp_replace(normalize(coalesce(p, ''), NFC),
               '[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+', ' ', 'g'))
$$;

-- Host-Token prüfen
create or replace function public._require_host(p_token text)
returns void language plpgsql stable set search_path = ''
as $$
begin
  if p_token is null or not exists (
       select 1 from public.host_sessions
        where token_hash = public._sha256(p_token) and expires_at > now()) then
    raise exception 'HOST_UNAUTHORIZED';
  end if;
end $$;

-- Spieler-Token prüfen, liefert den Spieler
create or replace function public._player_auth(p_player_id uuid, p_token text)
returns public.players language plpgsql stable set search_path = ''
as $$
declare v public.players;
begin
  select p.* into v
    from public.players p
    join public.player_tokens t on t.player_id = p.id
   where p.id = p_player_id and t.token_hash = public._sha256(p_token);
  if not found then
    raise exception 'PLAYER_NOT_FOUND';
  end if;
  return v;
end $$;

-- Höchstpunktzahl einer Mission. Eine Antwort kommt immer NACH dem Start
-- an, deshalb bleiben höchstens (Dauer − 1) volle Sekunden übrig.
create or replace function public._max_score(g public.games)
returns int language sql stable set search_path = ''
as $$
  select (select count(*)::int from public.questions)
         * (g.base_points + greatest(g.duration_s - 1, 0) * g.bonus_per_second)
$$;

-- Öffentliche Spielinfos als JSON (Zeiten als Epoch-Millisekunden)
create or replace function public._game_json(g public.games)
returns jsonb language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'id',               g.id,
    'code',             g.code,
    'status',           g.status,
    'current_question', g.current_question,
    'phase',            g.phase,
    'state_version',    g.state_version,
    'total_questions',  (select count(*) from public.questions),
    'phase_first',      (select min(question_index) from public.questions where phase = g.phase),
    'phase_last',       (select max(question_index) from public.questions where phase = g.phase),
    'duration_s',       g.duration_s,
    'base_points',      g.base_points,
    'bonus_per_second', g.bonus_per_second,
    'grace_ms',         g.grace_ms,
    'max_score',        public._max_score(g),
    'started_at_ms',    public._ms(g.question_started_at),
    'ends_at_ms',       public._ms(g.question_ends_at),
    'server_now_ms',    public._ms(clock_timestamp())
  )
$$;

-- Frage OHNE Lösung als JSON
create or replace function public._question_json(p_index int)
returns jsonb language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'index',   q.question_index,
    'phase',   q.phase,
    'text',    q.question_text,
    'options', jsonb_build_object('A', q.option_a, 'B', q.option_b, 'C', q.option_c, 'D', q.option_d))
  from public.questions q where q.question_index = p_index
$$;

-- Frage starten (mit kurzem "GET READY"-Vorlauf, damit alle Geräte
-- die Frage gleichzeitig freischalten)
create or replace function public._start_question(p_game_id uuid, p_index int)
returns void language plpgsql set search_path = ''
as $$
declare v_start timestamptz;
begin
  select clock_timestamp() + make_interval(secs => g.lead_in_ms / 1000.0)
    into v_start from public.games g where g.id = p_game_id;
  update public.games g
     set status              = 'question',
         current_question    = p_index,
         phase               = (select q.phase from public.questions q where q.question_index = p_index),
         question_started_at = v_start,
         question_ends_at    = v_start + make_interval(secs => g.duration_s),
         state_version       = g.state_version + 1,
         updated_at          = now()
   where g.id = p_game_id;
end $$;

-- Was ist der nächste logische Host-Schritt?
create or replace function public._next_action(g public.games)
returns text language plpgsql stable set search_path = ''
as $$
declare v_next int; v_next_phase int;
begin
  if g.status = 'lobby' then return 'start'; end if;
  if g.status = 'question' then return 'reveal'; end if;
  if g.status = 'phase_break' then return 'start_phase'; end if;
  if g.status = 'results' then
    select question_index, phase into v_next, v_next_phase
      from public.questions where question_index > g.current_question
     order by question_index limit 1;
    if v_next is null then return 'final'; end if;
    if v_next_phase <> g.phase then return 'phase_break'; end if;
    return 'next';
  end if;
  return 'none';
end $$;

-- Kompletter Host-Zustand
create or replace function public._host_state(p_game_id uuid)
returns jsonb language plpgsql stable set search_path = ''
as $$
declare
  g public.games;
  v_players jsonb;
  v_count int;
  v_answers int;
  v_reveal boolean;
  v_dist jsonb;
  v_correct text;
begin
  select * into g from public.games where id = p_game_id;
  if not found then raise exception 'MISSION_NOT_FOUND'; end if;

  select count(*) into v_count from public.players where game_id = g.id;
  select count(*) into v_answers from public.answers
   where game_id = g.id and question_index = g.current_question;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'callsign', p.callsign, 'score', p.score, 'time_ms', p.correct_time_ms,
           'answered', (p.answered_question = g.current_question and g.current_question > 0),
           'joined_at_ms', public._ms(p.joined_at))
           order by p.score desc, p.correct_time_ms, p.joined_at), '[]'::jsonb)
    into v_players from public.players p where p.game_id = g.id;

  v_reveal := g.status in ('results', 'phase_break', 'finished');
  if v_reveal and g.current_question > 0 then
    select correct_option into v_correct from public.questions where question_index = g.current_question;
    select jsonb_build_object(
             'A', count(*) filter (where selected_option = 'A'),
             'B', count(*) filter (where selected_option = 'B'),
             'C', count(*) filter (where selected_option = 'C'),
             'D', count(*) filter (where selected_option = 'D'))
      into v_dist from public.answers
     where game_id = g.id and question_index = g.current_question;
  end if;

  return jsonb_build_object(
    'game',           public._game_json(g),
    'players',        v_players,
    'player_count',   v_count,
    'answers_count',  v_answers,
    'all_answered',   (v_count > 0 and v_answers >= v_count),
    'question',       case when g.current_question > 0 then public._question_json(g.current_question) end,
    'correct_option', v_correct,
    'distribution',   v_dist,
    'next_action',    public._next_action(g)
  );
end $$;


-- =====================================================================
-- 4. ÖFFENTLICHE RPC-FUNKTIONEN – SPIELER
-- =====================================================================

-- Serverzeit für die Uhr-Synchronisation (Epoch-Millisekunden).
-- Bewusst ohne interne Hilfsfunktion: läuft mit den Rechten des Aufrufers (anon).
create or replace function public.server_time()
returns bigint language sql volatile set search_path = ''
as $$ select floor(extract(epoch from clock_timestamp()) * 1000)::bigint $$;

-- Mission beitreten
create or replace function public.join_game(p_code text, p_callsign text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_game     public.games;
  v_code     text := btrim(coalesce(p_code, ''));
  v_callsign text := public._clean_callsign(p_callsign);
  v_norm     text;
  v_count    int;
  v_id       uuid;
  v_token    text := public._new_token();
begin
  if v_code !~ '^[0-9]{6}$' then raise exception 'MISSION_CODE_INVALID'; end if;

  -- FOR SHARE: ein gleichzeitiges "Mission starten" wartet, bis der Beitritt fertig ist
  select * into v_game from public.games where code = v_code for share;
  if not found then raise exception 'MISSION_NOT_FOUND'; end if;
  if v_game.status in ('finished', 'aborted') then raise exception 'MISSION_CLOSED'; end if;
  if v_game.status <> 'lobby' then raise exception 'MISSION_ALREADY_STARTED'; end if;

  if char_length(v_callsign) < 2 or char_length(v_callsign) > 24 then
    raise exception 'CALLSIGN_LENGTH';
  end if;
  -- Steuerzeichen, unsichtbare Zeichen und spitze Klammern sind nicht erlaubt
  if v_callsign ~ '[\u0001-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF<>]' then
    raise exception 'CALLSIGN_CHARS';
  end if;
  v_norm := lower(normalize(v_callsign, NFKC));

  select count(*) into v_count from public.players where game_id = v_game.id;
  if v_count >= v_game.max_players then raise exception 'MISSION_FULL'; end if;

  begin
    insert into public.players (game_id, callsign, callsign_normalized)
    values (v_game.id, v_callsign, v_norm)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'CALLSIGN_TAKEN';
  end;

  insert into public.player_tokens (player_id, token_hash) values (v_id, public._sha256(v_token));

  return jsonb_build_object(
    'player_id', v_id, 'player_token', v_token,
    'game_id', v_game.id, 'code', v_game.code, 'callsign', v_callsign);
end $$;

-- Kompletter Zustand aus Sicht eines Spielers (für Start, Reload, Realtime)
create or replace function public.get_player_state(p_player_id uuid, p_token text, p_touch boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  me       public.players;
  g        public.games;
  a        public.answers;
  v_reveal boolean;
  v_answer jsonb;
  v_correct text;
begin
  me := public._player_auth(p_player_id, p_token);
  if p_touch then
    update public.players set last_seen = now() where id = me.id;
  end if;
  select * into g from public.games where id = me.game_id;

  v_reveal := g.status in ('results', 'phase_break', 'finished');

  if g.current_question > 0 then
    select * into a from public.answers
     where game_id = g.id and player_id = me.id and question_index = g.current_question;
    if a.id is not null then
      v_answer := jsonb_build_object('question_index', a.question_index, 'selected_option', a.selected_option);
      if v_reveal then
        v_answer := v_answer || jsonb_build_object('is_correct', a.is_correct, 'points', a.points);
      end if;
    end if;
    if v_reveal then
      select correct_option into v_correct from public.questions where question_index = g.current_question;
    end if;
  end if;

  return jsonb_build_object(
    'game', public._game_json(g),
    'me', jsonb_build_object(
      'player_id', me.id,
      'callsign',  me.callsign,
      'score',     me.score,
      'position',  (select count(*) + 1 from public.players
                     where game_id = g.id
                       and (score > me.score or (score = me.score and correct_time_ms < me.correct_time_ms)))),
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                  'callsign', p.callsign, 'score', p.score, 'time_ms', p.correct_time_ms, 'is_me', p.id = me.id,
                  'answered', (p.answered_question = g.current_question and g.current_question > 0))
                  order by p.score desc, p.correct_time_ms, p.joined_at), '[]'::jsonb)
                from public.players p where p.game_id = g.id),
    'question', case when g.current_question > 0 and g.status in ('question', 'results')
                     then public._question_json(g.current_question) end,
    'answer', v_answer,
    'correct_option', v_correct
  );
end $$;

-- Antwort abgeben. Der Client sendet NUR Spieler, Token, Frage und Option.
-- Richtig/falsch, Antwortzeit und Punkte bestimmt ausschließlich der Server.
create or replace function public.submit_answer(p_player_id uuid, p_token text, p_question_index int, p_option text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  me          public.players;
  g           public.games;
  v_opt       text := upper(btrim(coalesce(p_option, '')));
  v_now       timestamptz;
  v_correct   text;
  v_remaining int;
  v_is_correct boolean;
  v_points    int;
  v_rt        int;
  v_id        uuid;
  v_existing  text;
begin
  me := public._player_auth(p_player_id, p_token);
  if v_opt not in ('A', 'B', 'C', 'D') then raise exception 'OPTION_INVALID'; end if;

  -- FOR SHARE: "Ergebnis anzeigen" (FOR UPDATE) wartet, bis laufende Antworten gespeichert sind
  select * into g from public.games where id = me.game_id for share;
  if g.status <> 'question' or g.current_question <> p_question_index then
    raise exception 'QUESTION_NOT_ACTIVE';
  end if;

  v_now := clock_timestamp();
  if v_now < g.question_started_at then raise exception 'QUESTION_NOT_STARTED'; end if;
  -- kleine Kulanz für Netzwerklatenz; Bonus ist nach der Deadline ohnehin 0
  if v_now > g.question_ends_at + make_interval(secs => g.grace_ms / 1000.0) then
    raise exception 'TIME_EXPIRED';
  end if;

  select selected_option into v_existing from public.answers
   where player_id = me.id and game_id = g.id and question_index = p_question_index;
  if found then
    return jsonb_build_object('status', 'ALREADY_LOCKED', 'question_index', p_question_index, 'selected_option', v_existing);
  end if;

  select correct_option into v_correct from public.questions where question_index = p_question_index;
  v_is_correct := (v_opt = v_correct);
  -- verbleibende VOLLE Sekunden, begrenzt auf 0 … (Dauer − 1)
  v_remaining := greatest(0, least(g.duration_s - 1,
                   floor(extract(epoch from (g.question_ends_at - v_now)))::int));
  v_points := case when v_is_correct then g.base_points + v_remaining * g.bonus_per_second else 0 end;
  v_rt := greatest(0, round(extract(epoch from (v_now - g.question_started_at)) * 1000)::int);

  insert into public.answers (game_id, player_id, question_index, selected_option, is_correct, response_time_ms, points)
  values (g.id, me.id, p_question_index, v_opt, v_is_correct, v_rt, v_points)
  on conflict on constraint answers_one_per_question do nothing
  returning id into v_id;

  if v_id is null then
    -- gleichzeitiger zweiter Tab hat gewonnen
    select selected_option into v_existing from public.answers
     where player_id = me.id and game_id = g.id and question_index = p_question_index;
    return jsonb_build_object('status', 'ALREADY_LOCKED', 'question_index', p_question_index, 'selected_option', v_existing);
  end if;

  update public.players
     set answered_question = greatest(answered_question, p_question_index), last_seen = v_now
   where id = me.id;

  -- Bewusst OHNE richtig/falsch: das Ergebnis gibt der Commander frei.
  return jsonb_build_object('status', 'LOCKED', 'question_index', p_question_index, 'selected_option', v_opt);
end $$;

-- Lobby verlassen (nur vor dem Start)
create or replace function public.leave_game(p_player_id uuid, p_token text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare me public.players; v_status text;
begin
  me := public._player_auth(p_player_id, p_token);
  select status into v_status from public.games where id = me.game_id for share;
  if v_status <> 'lobby' then raise exception 'MISSION_ALREADY_STARTED'; end if;
  delete from public.players where id = me.id;
  return jsonb_build_object('ok', true);
end $$;


-- =====================================================================
-- 5. ÖFFENTLICHE RPC-FUNKTIONEN – COMMANDER (alle mit Host-Token)
-- =====================================================================

-- Login. Gibt bei falschem Passwort {ok:false} zurück (kein Fehler),
-- damit der Fehlversuch gespeichert bleibt.
create or replace function public.host_login(p_password text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_hash  text;
  v_fails int;
  v_token text;
  v_exp   timestamptz := now() + interval '48 hours';
begin
  delete from public.login_attempts where attempted_at < now() - interval '1 day';
  select count(*) into v_fails from public.login_attempts
   where not success and attempted_at > now() - interval '10 minutes';
  if v_fails >= 15 then
    return jsonb_build_object('ok', false, 'error', 'LOGIN_LOCKED');
  end if;

  select password_hash into v_hash from public.commander_config where id = 1;
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'COMMANDER_PASSWORD_NOT_SET');
  end if;

  if p_password is null or extensions.crypt(p_password, v_hash) <> v_hash then
    insert into public.login_attempts (success) values (false);
    return jsonb_build_object('ok', false, 'error', 'LOGIN_FAILED');
  end if;

  insert into public.login_attempts (success) values (true);
  delete from public.host_sessions where expires_at < now();
  v_token := public._new_token();
  insert into public.host_sessions (token_hash, expires_at) values (public._sha256(v_token), v_exp);
  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at_ms', public._ms(v_exp));
end $$;

create or replace function public.host_logout(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  delete from public.host_sessions where token_hash = public._sha256(p_token);
  return jsonb_build_object('ok', true);
end $$;

-- Session prüfen + letzte offene Mission (für Host-Reload)
create or replace function public.host_session_info(p_token text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_exp timestamptz; g public.games;
begin
  select expires_at into v_exp from public.host_sessions
   where token_hash = public._sha256(p_token) and expires_at > now();
  if v_exp is null then return jsonb_build_object('valid', false); end if;
  select * into g from public.games
   where status not in ('finished', 'aborted') and created_at > now() - interval '2 days'
   order by created_at desc limit 1;
  return jsonb_build_object(
    'valid', true,
    'expires_at_ms', public._ms(v_exp),
    'active_game', case when g.id is null then null
                        else jsonb_build_object('id', g.id, 'code', g.code, 'status', g.status,
                                                'current_question', g.current_question) end);
end $$;

-- Neue Mission mit eindeutigem 6-stelligem Code
create or replace function public.host_create_game(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_session text := public._sha256(p_token);
  r         public.game_rules;
  g         public.games;
  v_code    text;
  v_tries   int := 0;
begin
  perform public._require_host(p_token);
  -- Doppelklick-Schutz: Aufrufe derselben Session nacheinander abarbeiten …
  perform pg_advisory_xact_lock(hashtextextended('olp-create-' || v_session, 0));
  -- … und eine gerade erst erstellte, leere Mission wiederverwenden
  select * into g from public.games
   where created_by = v_session and status = 'lobby' and created_at > now() - interval '10 seconds'
     and not exists (select 1 from public.players p where p.game_id = games.id)
   order by created_at desc limit 1;
  if found then return public._host_state(g.id); end if;

  select * into r from public.game_rules where id = 1;
  loop
    v_code := (100000 + floor(random() * 900000))::int::text;
    begin
      insert into public.games (code, duration_s, base_points, bonus_per_second, lead_in_ms, grace_ms, max_players, created_by)
      values (v_code, r.question_duration_s, r.base_points, r.bonus_per_second, r.lead_in_ms, r.grace_ms, r.max_players, v_session)
      returning * into g;
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 25 then raise exception 'CODE_GENERATION_FAILED'; end if;
    end;
  end loop;
  return public._host_state(g.id);
end $$;

create or replace function public.host_get_state(p_token text, p_game_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  return public._host_state(p_game_id);
end $$;

-- Zentraler, idempotenter Fortschritt. Der Client sagt, von welchem Zustand
-- er ausgeht. Stimmt der nicht mehr (z. B. Doppelklick), passiert nichts.
--   lobby       → Frage 1          (MISSION STARTEN)
--   question    → results          (ERGEBNIS ANZEIGEN, Punkte werden gutgeschrieben)
--   results     → nächste Frage    (NÄCHSTE FRAGE)
--               → phase_break      (ZWISCHENRANKING, nach letzter Frage von Phase I)
--               → finished         (FINALE ANZEIGEN, nach letzter Frage)
--   phase_break → erste Frage Phase II (PHASE II STARTEN)
create or replace function public.host_advance(p_token text, p_game_id uuid, p_expected_status text, p_expected_question int)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  g        public.games;
  v_action text;
  v_next   int;
begin
  perform public._require_host(p_token);
  select * into g from public.games where id = p_game_id for update;
  if not found then raise exception 'MISSION_NOT_FOUND'; end if;

  if g.status <> p_expected_status or g.current_question <> p_expected_question then
    return public._host_state(g.id) || jsonb_build_object('changed', false);
  end if;

  v_action := public._next_action(g);

  if v_action = 'start' then
    if not exists (select 1 from public.players where game_id = g.id) then
      raise exception 'NO_PLAYERS';
    end if;
    select min(question_index) into v_next from public.questions;
    if v_next is null then raise exception 'NO_QUESTIONS'; end if;
    perform public._start_question(g.id, v_next);

  elsif v_action = 'reveal' then
    update public.games
       set status = 'results',
           question_ends_at = least(question_ends_at, clock_timestamp()),
           state_version = state_version + 1,
           updated_at = now()
     where id = g.id;
    -- Punkte (und Tie-Breaker-Zeit) dieser Frage gutschreiben – genau einmal,
    -- da der Statuswechsel unter Zeilensperre passiert
    update public.players p
       set score = p.score + a.points,
           correct_time_ms = p.correct_time_ms + case when a.is_correct then a.response_time_ms else 0 end
      from public.answers a
     where a.game_id = g.id and a.question_index = g.current_question
       and a.player_id = p.id;

  elsif v_action in ('next', 'start_phase') then
    select min(question_index) into v_next from public.questions where question_index > g.current_question;
    perform public._start_question(g.id, v_next);

  elsif v_action = 'phase_break' then
    update public.games set status = 'phase_break', state_version = state_version + 1, updated_at = now()
     where id = g.id;

  elsif v_action = 'final' then
    update public.games set status = 'finished', state_version = state_version + 1, updated_at = now()
     where id = g.id;

  else
    raise exception 'MISSION_CLOSED';
  end if;

  return public._host_state(g.id) || jsonb_build_object('changed', true);
end $$;

-- Antworten vorzeitig schließen
create or replace function public.host_close_answers(p_token text, p_game_id uuid, p_question_index int)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  update public.games
     set question_ends_at = greatest(question_started_at, clock_timestamp()),
         state_version = state_version + 1,
         updated_at = now()
   where id = p_game_id and status = 'question' and current_question = p_question_index
     and question_ends_at > clock_timestamp();
  return public._host_state(p_game_id);
end $$;

-- Mission zurücksetzen = schließen/archivieren (Daten bleiben zur Kontrolle erhalten)
create or replace function public.host_reset_game(p_token text, p_game_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  update public.games
     set status = 'aborted', state_version = state_version + 1, updated_at = now()
   where id = p_game_id and status <> 'aborted';
  return public._host_state(p_game_id);
end $$;

-- Spieler aus der Lobby entfernen (z. B. Tippfehler im Callsign)
create or replace function public.host_remove_player(p_token text, p_player_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare v_game uuid; v_status text;
begin
  perform public._require_host(p_token);
  select p.game_id, g.status into v_game, v_status
    from public.players p join public.games g on g.id = p.game_id
   where p.id = p_player_id;
  if v_game is null then raise exception 'PLAYER_NOT_FOUND'; end if;
  if v_status <> 'lobby' then raise exception 'MISSION_ALREADY_STARTED'; end if;
  delete from public.players where id = p_player_id;
  return public._host_state(v_game);
end $$;


-- =====================================================================
-- 6. ADMIN-FUNKTION (nur im SQL Editor ausführbar, NICHT aus dem Browser)
-- =====================================================================

create or replace function public.set_commander_password(p_password text)
returns text language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_password is null or char_length(p_password) < 8 then
    raise exception 'Das Commander-Passwort muss mindestens 8 Zeichen lang sein.';
  end if;
  if upper(p_password) in ('DEIN-GEHEIMES-PASSWORT', 'PASSWORT', 'PASSWORD', '12345678') then
    raise exception 'Bitte ein eigenes Passwort wählen, nicht den Platzhalter.';
  end if;
  insert into public.commander_config (id, password_hash)
  values (1, extensions.crypt(p_password, extensions.gen_salt('bf', 10)))
  on conflict (id) do update set password_hash = excluded.password_hash, updated_at = now();
  delete from public.host_sessions;   -- alte Logins ungültig machen
  return 'Commander-Passwort gesetzt. Bestehende Host-Logins wurden abgemeldet.';
end $$;


-- =====================================================================
-- 7. ROW LEVEL SECURITY + RECHTE
-- =====================================================================

alter table public.game_rules       enable row level security;
alter table public.commander_config enable row level security;
alter table public.host_sessions    enable row level security;
alter table public.login_attempts   enable row level security;
alter table public.games            enable row level security;
alter table public.players          enable row level security;
alter table public.player_tokens    enable row level security;
alter table public.questions        enable row level security;
alter table public.answers          enable row level security;

-- Zuerst alles entziehen …
revoke all on table
  public.game_rules, public.commander_config, public.host_sessions, public.login_attempts,
  public.games, public.players, public.player_tokens, public.questions, public.answers
from public, anon, authenticated;

-- … dann nur Lesen von games/players erlauben (für Lobby-Liste + Realtime).
grant usage on schema public to anon, authenticated;
grant select on table public.games, public.players to anon, authenticated;

drop policy if exists "games: lesen erlaubt" on public.games;
create policy "games: lesen erlaubt" on public.games
  for select to anon, authenticated using (true);

drop policy if exists "players: lesen erlaubt" on public.players;
create policy "players: lesen erlaubt" on public.players
  for select to anon, authenticated using (true);

-- Für alle anderen Tabellen gibt es bewusst KEINE Policy → kein Zugriff.

-- Funktionen: Standardmäßig darf in PostgreSQL jeder jede Funktion ausführen.
-- Das wird für ALLE Funktionen dieses Projekts entzogen …
revoke all on function
  public._sha256(text), public._new_token(), public._ms(timestamptz), public._clean_callsign(text),
  public._require_host(text), public._player_auth(uuid, text), public._max_score(public.games),
  public._game_json(public.games), public._question_json(int), public._start_question(uuid, int),
  public._next_action(public.games), public._host_state(uuid),
  public.server_time(), public.join_game(text, text), public.get_player_state(uuid, text, boolean),
  public.submit_answer(uuid, text, int, text), public.leave_game(uuid, text),
  public.host_login(text), public.host_logout(text), public.host_session_info(text),
  public.host_create_game(text), public.host_get_state(text, uuid),
  public.host_advance(text, uuid, text, int), public.host_close_answers(text, uuid, int),
  public.host_reset_game(text, uuid), public.host_remove_player(text, uuid),
  public.set_commander_password(text)
from public, anon, authenticated;

-- … und nur die öffentlichen RPCs wieder freigegeben.
grant execute on function
  public.server_time(), public.join_game(text, text), public.get_player_state(uuid, text, boolean),
  public.submit_answer(uuid, text, int, text), public.leave_game(uuid, text),
  public.host_login(text), public.host_logout(text), public.host_session_info(text),
  public.host_create_game(text), public.host_get_state(text, uuid),
  public.host_advance(text, uuid, text, int), public.host_close_answers(text, uuid, int),
  public.host_reset_game(text, uuid), public.host_remove_player(text, uuid)
to anon, authenticated;


-- =====================================================================
-- 8. REALTIME (games + players in die Supabase-Realtime-Publication)
-- =====================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games') then
      alter publication supabase_realtime add table public.games;
    end if;
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'players') then
      alter publication supabase_realtime add table public.players;
    end if;
  else
    raise notice 'Publication supabase_realtime nicht gefunden – Realtime bitte im Dashboard aktivieren (siehe README).';
  end if;
end $$;


-- =====================================================================
-- 9. GAME COUNTER – Team-Bilanz (5er-Team, CS2 Competitive)
--     Unabhängig vom Quiz. Öffentlich lesbar (Live-Anzeige),
--     ändern nur mit Commander-Login.
-- =====================================================================

-- Team (eine Zeile): Name + 5 Operatoren
create table if not exists public.counter_team (
  id         int primary key default 1 check (id = 1),
  name       text not null default 'LAN PARTY SQUAD' check (char_length(name) between 1 and 32),
  roster     text[] not null default array['', '', '', '', '']::text[],
  updated_at timestamptz not null default now()
);
insert into public.counter_team (id) values (1) on conflict (id) do nothing;
-- Branding: alten Standardnamen ersetzen, falls nie geändert
update public.counter_team set name = 'LAN PARTY SQUAD' where name = 'NJORGIBICEPS SQUAD';
alter table public.counter_team alter column name set default 'LAN PARTY SQUAD';

-- Jedes gespielte Match = eine Zeile
create table if not exists public.counter_matches (
  id         bigint generated always as identity primary key,
  result     char(1) not null check (result in ('W', 'L', 'T')),
  map        text check (map is null or char_length(map) between 1 and 24),
  score_us   int check (score_us is null or score_us between 0 and 99),
  score_them int check (score_them is null or score_them between 0 and 99),
  created_at timestamptz not null default now()
);
create index if not exists counter_matches_time_idx on public.counter_matches (created_at desc);


-- =====================================================================
-- 10. BRACKET / TURNIER (1v1)
--     1. Setup:  Spieler vorab eintragen (4–8)
--     2. Auslosung (Server, zufällig): Qualifikation als Ring –
--        jeder spielt genau 2 Duelle (5 Spieler = 5 Duelle)
--     3. Rangliste der Quali → Top 4 ins Halbfinale (1. vs 4., 2. vs 3.)
--     4. Finale + Spiel um Platz 3 (Lower Bracket)
--     Sieger/Ranglisten rechnet der Browser aus den Scores aus.
-- =====================================================================

-- ALT, ERSETZT: das frühere 5-Slot-Bracket (nur Testdaten) wird entfernt.
-- Diese DROP-Befehle betreffen ausschließlich das alte Bracket.
drop function if exists public.bracket_state();
drop function if exists public.bracket_save(text, text[], int[]);
drop function if exists public.bracket_reset(text, boolean);
drop table if exists public.bracket;

create table if not exists public.tournament (
  id          int primary key default 1 check (id = 1),
  players     text[] not null default array[]::text[],   -- 4–8 Callsigns
  pairs       int[]  not null default array[]::int[],    -- Quali-Paarungen flach: [a0, b0, a1, b1, …] (Index in players)
  qual_scores int[]  not null default array[]::int[],    -- Scores parallel zu pairs
  ko_scores   int[]  not null default array[null, null, null, null, null, null, null, null]::int[],
                                                          -- HF1 a/b, HF2 a/b, Platz 3 a/b, Finale a/b
  version     bigint not null default 1,
  updated_at  timestamptz not null default now()
);
insert into public.tournament (id) values (1) on conflict (id) do nothing;


-- =====================================================================
-- 11. OPERATOR-ACCOUNTS (Login für Quiz, Game Counter, Bracket)
--     Benutzername = Callsign im Quiz, Name im Bracket, Spieler in den
--     CS-Stats. Passwörter nur als bcrypt-Hash. Für den Browser NICHT lesbar.
-- =====================================================================

create table if not exists public.accounts (
  id                  uuid primary key default gen_random_uuid(),
  username            text not null check (char_length(username) between 2 and 24),
  username_normalized text not null unique,
  password_hash       text not null,
  checked_in          boolean not null default false,
  checked_in_at       timestamptz,
  failed_logins       int not null default 0,
  locked_until        timestamptz,
  created_at          timestamptz not null default now(),
  last_seen           timestamptz,
  is_commander        boolean not null default false
);
alter table public.accounts add column if not exists is_commander boolean not null default false;

create table if not exists public.account_sessions (
  token_hash text primary key,
  account_id uuid not null references public.accounts (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists account_sessions_account_idx on public.account_sessions (account_id);

-- Quiz-Spieler können zu einem Account gehören (Beitritt ohne QR/Code)
alter table public.players add column if not exists account_id uuid references public.accounts (id) on delete set null;
-- Mehrere Geräte pro Spieler erlauben (z. B. Handy + Laptop mit demselben Login)
alter table public.player_tokens drop constraint if exists player_tokens_pkey;
create index if not exists player_tokens_player_idx on public.player_tokens (player_id);

-- Hold-Screen (Start-Bildschirm): solange aktiv und nicht alle Operatoren
-- eingecheckt sind, ist die Webseite für alle gesperrt – kein Login, kein
-- Quiz-Beitritt, keine Stats. Nur der Commander kann arbeiten.
-- Standard bei neuer Einrichtung: AKTIV.
create table if not exists public.site_state (
  id           int primary key default 1 check (id = 1),
  hold_enabled boolean not null default true,
  released     boolean not null default false,
  updated_at   timestamptz not null default now()
);
insert into public.site_state (id) values (1) on conflict (id) do nothing;


-- =====================================================================
-- 12. CS-STATS pro Match (tragen die Spieler selbst ein)
-- =====================================================================

create table if not exists public.counter_stats (
  match_id   bigint not null references public.counter_matches (id) on delete cascade,
  account_id uuid not null references public.accounts (id) on delete cascade,
  kills      int not null check (kills between 0 and 200),
  deaths     int not null check (deaths between 0 and 200),
  assists    int not null check (assists between 0 and 200),
  hs_pct     int not null check (hs_pct between 0 and 100),
  adr        int not null check (adr between 0 and 999),
  mvps       int not null default 0 check (mvps between 0 and 50),
  updated_at timestamptz not null default now(),
  primary key (match_id, account_id)
);
create index if not exists counter_stats_account_idx on public.counter_stats (account_id);


-- ---------------------------------------------------------------------
-- Hilfsfunktion: Namen säubern + prüfen (intern)
-- ---------------------------------------------------------------------
create or replace function public._clean_label(p text, p_max int)
returns text language plpgsql stable set search_path = ''
as $$
declare v text := public._clean_callsign(p);
begin
  if char_length(v) < 1 or char_length(v) > p_max then raise exception 'NAME_LENGTH'; end if;
  if v ~ '[[:cntrl:]<>]' then raise exception 'NAME_CHARS'; end if;
  return v;
end $$;


-- ---------------------------------------------------------------------
-- GAME COUNTER – RPCs
-- ---------------------------------------------------------------------
create or replace function public.counter_state()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'team', (select jsonb_build_object('name', t.name, 'roster', to_jsonb(t.roster))
               from public.counter_team t where t.id = 1),
    'totals', (select jsonb_build_object(
                 'wins',   count(*) filter (where result = 'W'),
                 'losses', count(*) filter (where result = 'L'),
                 'ties',   count(*) filter (where result = 'T'))
               from public.counter_matches),
    'matches', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'result', m.result, 'map', m.map,
               'score_us', m.score_us, 'score_them', m.score_them,
               'at_ms', public._ms(m.created_at))
             order by m.id desc)
        from (select * from public.counter_matches order by id desc limit 200) m), '[]'::jsonb),
    'stats', coalesce((
      select jsonb_agg(jsonb_build_object(
               'match_id', s.match_id, 'player', a.username,
               'kills', s.kills, 'deaths', s.deaths, 'assists', s.assists,
               'hs', s.hs_pct, 'adr', s.adr, 'mvps', s.mvps)
             order by s.match_id desc, s.kills desc)
        from public.counter_stats s
        join public.accounts a on a.id = s.account_id
       where s.match_id in (select id from public.counter_matches order by id desc limit 200)), '[]'::jsonb),
    'server_now_ms', public._ms(clock_timestamp())
  )
$$;

create or replace function public.counter_set_team(p_token text, p_name text, p_roster text[])
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_roster text[] := array[]::text[];
  v_name   text;
begin
  perform public._require_host(p_token);
  if p_roster is null or cardinality(p_roster) <> 5 then raise exception 'TEAM_INVALID'; end if;
  foreach v_name in array p_roster loop
    if v_name is null or btrim(v_name) = '' then
      v_roster := v_roster || ''::text;
    else
      v_roster := v_roster || public._clean_label(v_name, 24);
    end if;
  end loop;
  insert into public.counter_team (id) values (1) on conflict (id) do nothing;
  update public.counter_team
     set name = public._clean_label(p_name, 32), roster = v_roster, updated_at = now()
   where id = 1;
  return public.counter_state();
end $$;

-- Ergebnis wird aus dem Score abgeleitet, wenn beide Werte angegeben sind
create or replace function public.counter_add_match(p_token text, p_result text, p_map text, p_score_us int, p_score_them int)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_result text := upper(btrim(coalesce(p_result, '')));
  v_map    text;
begin
  perform public._require_host(p_token);
  if (p_score_us is null) <> (p_score_them is null) then raise exception 'SCORE_INVALID'; end if;
  if p_score_us is not null then
    if p_score_us not between 0 and 99 or p_score_them not between 0 and 99 then raise exception 'SCORE_INVALID'; end if;
    v_result := case when p_score_us > p_score_them then 'W'
                     when p_score_us < p_score_them then 'L' else 'T' end;
  end if;
  if v_result not in ('W', 'L', 'T') then raise exception 'RESULT_INVALID'; end if;
  if p_map is not null and btrim(p_map) <> '' then v_map := public._clean_label(p_map, 24); end if;
  if (select count(*) from public.counter_matches) >= 1000 then raise exception 'LIMIT_REACHED'; end if;
  insert into public.counter_matches (result, map, score_us, score_them)
  values (v_result, v_map, p_score_us, p_score_them);
  return public.counter_state();
end $$;

create or replace function public.counter_delete_match(p_token text, p_id bigint)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  delete from public.counter_matches where id = p_id;
  return public.counter_state();
end $$;

create or replace function public.counter_reset(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  delete from public.counter_matches where true;
  return public.counter_state();
end $$;


-- ---------------------------------------------------------------------
-- BRACKET / TURNIER – RPCs
-- ---------------------------------------------------------------------
create or replace function public.tournament_state()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'players', to_jsonb(t.players), 'pairs', to_jsonb(t.pairs),
    'qual_scores', to_jsonb(t.qual_scores), 'ko_scores', to_jsonb(t.ko_scores),
    'version', t.version, 'updated_at_ms', public._ms(t.updated_at))
  from public.tournament t where t.id = 1
$$;

-- Spieler vorab eintragen (setzt Auslosung und Resultate zurück)
create or replace function public.tournament_set_players(p_token text, p_players text[])
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_players text[] := array[]::text[];
  v_norms   text[] := array[]::text[];
  v_name    text;
  v_clean   text;
begin
  perform public._require_host(p_token);
  if p_players is not null then
    foreach v_name in array p_players loop
      if v_name is not null and btrim(v_name) <> '' then
        v_clean := public._clean_label(v_name, 24);
        if lower(normalize(v_clean, NFKC)) = any (v_norms) then raise exception 'NAME_TAKEN'; end if;
        v_norms := v_norms || lower(normalize(v_clean, NFKC));
        v_players := v_players || v_clean;
      end if;
    end loop;
  end if;
  if cardinality(v_players) > 8 then raise exception 'PLAYERS_COUNT'; end if;
  insert into public.tournament (id) values (1) on conflict (id) do nothing;
  update public.tournament
     set players = v_players, pairs = array[]::int[], qual_scores = array[]::int[],
         ko_scores = array[null, null, null, null, null, null, null, null]::int[],
         version = version + 1, updated_at = now()
   where id = 1;
  return public.tournament_state();
end $$;

-- Zufällige Auslosung: Ring über die gemischten Spieler → jeder spielt 2×.
-- Reihenfolge: jedes zweite Duel zuerst, damit möglichst niemand zweimal
-- direkt hintereinander spielt.
create or replace function public.tournament_draw(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_players text[];
  v_n       int;
  v_perm    int[];
  v_pairs   int[] := array[]::int[];
  v_k       int;
begin
  perform public._require_host(p_token);
  select players into v_players from public.tournament where id = 1 for update;
  v_n := coalesce(cardinality(v_players), 0);
  if v_n < 4 or v_n > 8 then raise exception 'PLAYERS_COUNT'; end if;
  select array_agg(i - 1 order by random()) into v_perm from generate_subscripts(v_players, 1) as i;
  for v_k in select k from generate_series(0, v_n - 1) as k order by (k % 2), k loop
    v_pairs := v_pairs || v_perm[v_k + 1] || v_perm[((v_k + 1) % v_n) + 1];
  end loop;
  update public.tournament
     set pairs = v_pairs,
         qual_scores = array_fill(null::int, array[2 * v_n]),
         ko_scores = array[null, null, null, null, null, null, null, null]::int[],
         version = version + 1, updated_at = now()
   where id = 1;
  return public.tournament_state();
end $$;

create or replace function public.tournament_save_scores(p_token text, p_qual int[], p_ko int[])
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_pairs int[];
  v_score int;
begin
  perform public._require_host(p_token);
  select pairs into v_pairs from public.tournament where id = 1 for update;
  if cardinality(v_pairs) = 0 then raise exception 'NOT_DRAWN'; end if;
  if p_qual is null or cardinality(p_qual) <> cardinality(v_pairs) or p_ko is null or cardinality(p_ko) <> 8 then
    raise exception 'BRACKET_INVALID';
  end if;
  foreach v_score in array p_qual || p_ko loop
    if v_score is not null and (v_score < 0 or v_score > 99) then raise exception 'BRACKET_INVALID'; end if;
  end loop;
  update public.tournament
     set qual_scores = p_qual, ko_scores = p_ko, version = version + 1, updated_at = now()
   where id = 1;
  return public.tournament_state();
end $$;

-- Resultate löschen, Auslosung behalten
create or replace function public.tournament_clear_scores(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  update public.tournament
     set qual_scores = case when cardinality(pairs) = 0 then array[]::int[]
                            else array_fill(null::int, array[cardinality(pairs)]) end,
         ko_scores = array[null, null, null, null, null, null, null, null]::int[],
         version = version + 1, updated_at = now()
   where id = 1;
  return public.tournament_state();
end $$;


-- ---------------------------------------------------------------------
-- ACCOUNTS – interne Helfer
-- ---------------------------------------------------------------------
create or replace function public._norm(p text)
returns text language sql stable set search_path = ''
as $$ select lower(normalize(public._clean_callsign(p), NFKC)) $$;

create or replace function public._account_auth(p_token text)
returns public.accounts language plpgsql stable set search_path = ''
as $$
declare a public.accounts;
begin
  select acc.* into a
    from public.account_sessions s
    join public.accounts acc on acc.id = s.account_id
   where s.token_hash = public._sha256(p_token) and s.expires_at > now();
  if not found then raise exception 'ACCOUNT_UNAUTHORIZED'; end if;
  return a;
end $$;

create or replace function public._account_session(p_account_id uuid)
returns text language plpgsql volatile set search_path = ''
as $$
declare v_token text := public._new_token();
begin
  delete from public.account_sessions where expires_at < now();
  insert into public.account_sessions (token_hash, account_id, expires_at)
  values (public._sha256(v_token), p_account_id, now() + interval '30 days');
  return v_token;
end $$;

-- Ist ein Name im Team-Roster des Game Counters?
create or replace function public._in_roster(p_norm text)
returns boolean language sql stable set search_path = ''
as $$
  select exists (select 1 from public.counter_team t, unnest(t.roster) r
                  where t.id = 1 and r <> '' and public._norm(r) = p_norm)
$$;

create or replace function public._in_tournament(p_norm text)
returns boolean language sql stable set search_path = ''
as $$
  select exists (select 1 from public.tournament t, unnest(t.players) r
                  where t.id = 1 and public._norm(r) = p_norm)
$$;

-- Aktuelle Quiz-Mission (letzte offene der letzten 12 Stunden)
create or replace function public._active_game()
returns public.games language sql stable set search_path = ''
as $$
  select g.* from public.games g
   where g.status not in ('finished', 'aborted') and g.created_at > now() - interval '12 hours'
   order by g.created_at desc limit 1
$$;

-- Benutzername des Commander-Accounts (Passwort = Commander-Passwort)
create or replace function public._commander_username()
returns text language sql immutable set search_path = ''
as $$ select 'havoc'::text $$;

-- Ist die Webseite freigegeben (kein Hold-Screen)?
create or replace function public._site_open()
returns boolean language sql stable set search_path = ''
as $$ select coalesce((select (not hold_enabled) or released from public.site_state where id = 1), true) $$;

-- Commander-Account anlegen bzw. aktualisieren (gleiches Passwort wie MISSION CONTROL,
-- immer eingecheckt). Wird beim Setzen des Commander-Passworts aufgerufen.
create or replace function public._ensure_commander_account()
returns void language plpgsql volatile set search_path = ''
as $$
declare v_hash text;
begin
  select password_hash into v_hash from public.commander_config where id = 1;
  if v_hash is null then return; end if;
  insert into public.accounts (username, username_normalized, password_hash, is_commander, checked_in, checked_in_at)
  values (public._commander_username(), public._norm(public._commander_username()), v_hash, true, true, now())
  on conflict (username_normalized) do update
     set password_hash = excluded.password_hash, is_commander = true, checked_in = true,
         checked_in_at = coalesce(public.accounts.checked_in_at, now()), failed_logins = 0, locked_until = null;
end $$;

-- Gäste-Beitritt zum Quiz während des Holds verhindern (gilt auch für join_game)
create or replace function public._players_hold_guard()
returns trigger language plpgsql set search_path = ''
as $$
begin
  -- Der Commander ist MISSION CONTROL und spielt das Quiz nicht mit;
  -- sein Name ist als Callsign reserviert.
  if new.callsign_normalized = public._norm(public._commander_username()) then
    raise exception 'CALLSIGN_TAKEN';
  end if;
  if not public._site_open()
     and not exists (select 1 from public.accounts a where a.id = new.account_id and a.is_commander) then
    raise exception 'SITE_ON_HOLD';
  end if;
  return new;
end $$;
drop trigger if exists players_hold_guard on public.players;
create trigger players_hold_guard before insert on public.players
  for each row execute function public._players_hold_guard();

-- Hold-Screen automatisch freigeben, sobald alle Operatoren (ohne Commander)
-- eingecheckt sind
create or replace function public._refresh_site()
returns void language plpgsql volatile set search_path = ''
as $$
declare v_total int; v_checked int;
begin
  select count(*), count(*) filter (where checked_in) into v_total, v_checked
    from public.accounts where not is_commander;
  update public.site_state
     set released = released or (hold_enabled and v_total > 0 and v_checked = v_total),
         updated_at = now()
   where id = 1;
end $$;


-- ---------------------------------------------------------------------
-- ACCOUNTS – öffentliche RPCs
-- ---------------------------------------------------------------------
create or replace function public.account_register(p_username text, p_password text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare v_name text; v_id uuid;
begin
  if not public._site_open() then raise exception 'SITE_ON_HOLD'; end if;
  v_name := public._clean_label(p_username, 24);
  if char_length(v_name) < 2 then raise exception 'NAME_LENGTH'; end if;
  if p_password is null or char_length(p_password) < 4 or char_length(p_password) > 64 then
    raise exception 'PASSWORD_INVALID';
  end if;
  if (select count(*) from public.accounts) >= 100 then raise exception 'LIMIT_REACHED'; end if;
  begin
    insert into public.accounts (username, username_normalized, password_hash, last_seen)
    values (v_name, public._norm(v_name), extensions.crypt(p_password, extensions.gen_salt('bf', 8)), now())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'NAME_TAKEN';
  end;
  perform public._refresh_site();
  return jsonb_build_object('ok', true, 'token', public._account_session(v_id), 'username', v_name);
end $$;

-- Falsches Passwort → {ok:false} (kein Fehler, damit der Fehlversuch gezählt bleibt)
create or replace function public.account_login(p_username text, p_password text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare a public.accounts; v_host text;
begin
  select * into a from public.accounts where username_normalized = public._norm(p_username);
  if not found then return jsonb_build_object('ok', false, 'error', 'LOGIN_FAILED'); end if;
  if a.locked_until is not null and a.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'LOGIN_LOCKED');
  end if;
  if p_password is null or extensions.crypt(p_password, a.password_hash) <> a.password_hash then
    update public.accounts
       set failed_logins = failed_logins + 1,
           locked_until = case when failed_logins + 1 >= 8 then now() + interval '5 minutes' else null end
     where id = a.id;
    return jsonb_build_object('ok', false, 'error', 'LOGIN_FAILED');
  end if;
  update public.accounts set failed_logins = 0, locked_until = null, last_seen = now() where id = a.id;
  if not a.is_commander and not public._site_open() then
    return jsonb_build_object('ok', false, 'error', 'SITE_ON_HOLD');
  end if;
  if a.is_commander then
    v_host := public._new_token();
    delete from public.host_sessions where expires_at < now();
    insert into public.host_sessions (token_hash, expires_at) values (public._sha256(v_host), now() + interval '48 hours');
  end if;
  return jsonb_build_object('ok', true, 'token', public._account_session(a.id), 'username', a.username,
                            'commander', a.is_commander, 'host_token', v_host);
end $$;

create or replace function public.account_logout(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  delete from public.account_sessions where token_hash = public._sha256(p_token);
  return jsonb_build_object('ok', true);
end $$;

-- Profil: alles zu "mir" auf einen Blick (aktualisiert last_seen = online)
create or replace function public.account_me(p_token text, p_touch boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  a public.accounts;
  g public.games;
  v_roster boolean;
begin
  a := public._account_auth(p_token);
  if p_touch then update public.accounts set last_seen = now() where id = a.id; end if;
  g := public._active_game();
  v_roster := public._in_roster(a.username_normalized);
  return jsonb_build_object(
    'username', a.username,
    'commander', a.is_commander,
    'site_open', public._site_open(),
    'checked_in', a.checked_in,
    'created_at_ms', public._ms(a.created_at),
    'quiz', case when g.id is null then null else jsonb_build_object(
              'code', g.code, 'status', g.status, 'current_question', g.current_question,
              'joined', exists (select 1 from public.players p where p.game_id = g.id and p.account_id = a.id)) end,
    'team', jsonb_build_object(
              'in_roster', v_roster,
              'pending_stats', case when v_roster then
                 (select count(*) from public.counter_matches m
                   where not exists (select 1 from public.counter_stats s where s.match_id = m.id and s.account_id = a.id))
               else 0 end,
              'totals', (select jsonb_build_object(
                 'matches', count(*), 'kills', coalesce(sum(kills), 0), 'deaths', coalesce(sum(deaths), 0),
                 'assists', coalesce(sum(assists), 0), 'adr', coalesce(round(avg(adr)), 0), 'hs', coalesce(round(avg(hs_pct)), 0),
                 'mvps', coalesce(sum(mvps), 0))
                 from public.counter_stats s where s.account_id = a.id)),
    'tournament', jsonb_build_object('participant', public._in_tournament(a.username_normalized))
  );
end $$;

-- Einchecken macht ausschließlich der Commander (MISSION OPS → ops_set_checkin).
-- Eine frühere Selbst-Check-in-Funktion wird entfernt, falls vorhanden.
drop function if exists public.account_set_checkin(text, boolean);

-- Öffentliche Liste (nur Name + eingecheckt) für Bracket/Counter-Auswahl
create or replace function public.accounts_public()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('username', a.username, 'checked_in', a.checked_in)
                            order by a.username_normalized), '[]'::jsonb)
    from public.accounts a
$$;

-- Hold-Screen-Status (öffentlich)
create or replace function public.site_status()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'hold_enabled', s.hold_enabled,
    'released', s.released,
    'open', (not s.hold_enabled) or s.released,
    'total', (select count(*) from public.accounts where not is_commander),
    'checked_in', (select count(*) from public.accounts where checked_in and not is_commander),
    'operators', (select coalesce(jsonb_agg(jsonb_build_object('username', a.username, 'checked_in', a.checked_in)
                                            order by a.checked_in desc, a.username_normalized), '[]'::jsonb)
                    from public.accounts a where not a.is_commander))
  from public.site_state s where s.id = 1
$$;


-- ---------------------------------------------------------------------
-- QUIZ mit Login: Beitritt ohne QR/Code, Callsign = Benutzername
-- ---------------------------------------------------------------------
create or replace function public.join_game_account(p_token text, p_code text default null)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  a        public.accounts;
  g        public.games;
  v_code   text := btrim(coalesce(p_code, ''));
  v_player uuid;
  v_ptoken text := public._new_token();
begin
  a := public._account_auth(p_token);
  if a.is_commander then raise exception 'COMMANDER_NO_QUIZ'; end if;   -- der Commander ist MISSION CONTROL
  if not public._site_open() then raise exception 'SITE_ON_HOLD'; end if;
  if v_code <> '' then
    if v_code !~ '^[0-9]{6}$' then raise exception 'MISSION_CODE_INVALID'; end if;
    select * into g from public.games where code = v_code for share;
    if not found then raise exception 'MISSION_NOT_FOUND'; end if;
  else
    -- 1. laufende Mission, in der ich schon bin – 2. neueste Lobby
    select gg.* into g from public.games gg
     where gg.status not in ('finished', 'aborted') and gg.created_at > now() - interval '12 hours'
       and exists (select 1 from public.players p where p.game_id = gg.id and p.account_id = a.id)
     order by gg.created_at desc limit 1;
    if not found then
      select gg.* into g from public.games gg
       where gg.status = 'lobby' and gg.created_at > now() - interval '12 hours'
       order by gg.created_at desc limit 1;
    end if;
    if g.id is null then raise exception 'NO_ACTIVE_MISSION'; end if;
    perform 1 from public.games where id = g.id for share;
  end if;

  select id into v_player from public.players where game_id = g.id and account_id = a.id;
  if v_player is null then
    if g.status in ('finished', 'aborted') then raise exception 'MISSION_CLOSED'; end if;
    if g.status <> 'lobby' then raise exception 'MISSION_ALREADY_STARTED'; end if;
    if (select count(*) from public.players where game_id = g.id) >= g.max_players then raise exception 'MISSION_FULL'; end if;
    begin
      insert into public.players (game_id, callsign, callsign_normalized, account_id)
      values (g.id, a.username, a.username_normalized, a.id)
      returning id into v_player;
    exception when unique_violation then
      raise exception 'CALLSIGN_TAKEN';
    end;
  end if;
  insert into public.player_tokens (player_id, token_hash) values (v_player, public._sha256(v_ptoken));
  update public.accounts set last_seen = now() where id = a.id;
  return jsonb_build_object('player_id', v_player, 'player_token', v_ptoken,
                            'game_id', g.id, 'code', g.code, 'callsign', a.username);
end $$;


-- ---------------------------------------------------------------------
-- CS-STATS: jeder Spieler trägt seine eigene Zeile pro Match ein
-- ---------------------------------------------------------------------
create or replace function public.counter_submit_stats(
  p_token text, p_match_id bigint, p_kills int, p_deaths int, p_assists int, p_hs_pct int, p_adr int, p_mvps int)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare a public.accounts;
begin
  a := public._account_auth(p_token);
  if not a.is_commander and not public._site_open() then raise exception 'SITE_ON_HOLD'; end if;
  if not exists (select 1 from public.counter_matches where id = p_match_id) then raise exception 'NOT_FOUND'; end if;
  if not public._in_roster(a.username_normalized) then raise exception 'NOT_IN_TEAM'; end if;
  if p_kills is null or p_deaths is null or p_assists is null or p_hs_pct is null or p_adr is null
     or p_kills not between 0 and 200 or p_deaths not between 0 and 200 or p_assists not between 0 and 200
     or p_hs_pct not between 0 and 100 or p_adr not between 0 and 999 or coalesce(p_mvps, 0) not between 0 and 50 then
    raise exception 'STATS_INVALID';
  end if;
  insert into public.counter_stats (match_id, account_id, kills, deaths, assists, hs_pct, adr, mvps)
  values (p_match_id, a.id, p_kills, p_deaths, p_assists, p_hs_pct, p_adr, coalesce(p_mvps, 0))
  on conflict (match_id, account_id) do update
     set kills = excluded.kills, deaths = excluded.deaths, assists = excluded.assists,
         hs_pct = excluded.hs_pct, adr = excluded.adr, mvps = excluded.mvps, updated_at = now();
  update public.accounts set last_seen = now() where id = a.id;
  return public.counter_state();
end $$;


-- ---------------------------------------------------------------------
-- MISSION OPS (Commander): Anwesenheit, Accounts, Hold-Screen
-- ---------------------------------------------------------------------
create or replace function public.ops_state(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare g public.games;
begin
  perform public._require_host(p_token);
  g := public._active_game();
  return jsonb_build_object(
    'server_now_ms', public._ms(clock_timestamp()),
    'site', public.site_status(),
    'quiz', case when g.id is null then null else jsonb_build_object(
              'code', g.code, 'status', g.status, 'current_question', g.current_question,
              'player_count', (select count(*) from public.players where game_id = g.id)) end,
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'username', a.username, 'checked_in', a.checked_in, 'commander', a.is_commander,
        'checked_in_at_ms', public._ms(a.checked_in_at), 'last_seen_ms', public._ms(a.last_seen),
        'created_at_ms', public._ms(a.created_at), 'locked', a.locked_until is not null and a.locked_until > now(),
        'in_roster', public._in_roster(a.username_normalized),
        'in_tournament', public._in_tournament(a.username_normalized),
        'in_quiz', g.id is not null and exists (select 1 from public.players p where p.game_id = g.id and p.account_id = a.id),
        'pending_stats', case when public._in_roster(a.username_normalized) then
            (select count(*) from public.counter_matches m
              where not exists (select 1 from public.counter_stats s where s.match_id = m.id and s.account_id = a.id))
          else 0 end)
        order by a.username_normalized) from public.accounts a), '[]'::jsonb)
  );
end $$;

create or replace function public.ops_set_checkin(p_token text, p_account_id uuid, p_checked boolean)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  update public.accounts
     set checked_in = coalesce(p_checked, false),
         checked_in_at = case when coalesce(p_checked, false) then coalesce(checked_in_at, now()) else null end
   where id = p_account_id and not is_commander;
  perform public._refresh_site();
  return public.ops_state(p_token);
end $$;

-- Alle auf einmal ein- bzw. auschecken
create or replace function public.ops_checkin_all(p_token text, p_checked boolean)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  update public.accounts
     set checked_in = coalesce(p_checked, false),
         checked_in_at = case when coalesce(p_checked, false) then coalesce(checked_in_at, now()) else null end
   where not is_commander;
  perform public._refresh_site();
  return public.ops_state(p_token);
end $$;

-- Accounts vorab anlegen (z. B. für Gäste)
create or replace function public.ops_create_account(p_token text, p_username text, p_password text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare v_name text;
begin
  perform public._require_host(p_token);
  v_name := public._clean_label(p_username, 24);
  if char_length(v_name) < 2 then raise exception 'NAME_LENGTH'; end if;
  if p_password is null or char_length(p_password) < 4 or char_length(p_password) > 64 then raise exception 'PASSWORD_INVALID'; end if;
  if (select count(*) from public.accounts) >= 100 then raise exception 'LIMIT_REACHED'; end if;
  begin
    insert into public.accounts (username, username_normalized, password_hash)
    values (v_name, public._norm(v_name), extensions.crypt(p_password, extensions.gen_salt('bf', 8)));
  exception when unique_violation then
    raise exception 'NAME_TAKEN';
  end;
  perform public._refresh_site();
  return public.ops_state(p_token);
end $$;

create or replace function public.ops_reset_password(p_token text, p_account_id uuid, p_password text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  if p_password is null or char_length(p_password) < 4 or char_length(p_password) > 64 then raise exception 'PASSWORD_INVALID'; end if;
  if exists (select 1 from public.accounts where id = p_account_id and is_commander) then raise exception 'COMMANDER_ACCOUNT'; end if;
  update public.accounts
     set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 8)), failed_logins = 0, locked_until = null
   where id = p_account_id;
  delete from public.account_sessions where account_id = p_account_id;
  return public.ops_state(p_token);
end $$;

create or replace function public.ops_delete_account(p_token text, p_account_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  if exists (select 1 from public.accounts where id = p_account_id and is_commander) then raise exception 'COMMANDER_ACCOUNT'; end if;
  delete from public.accounts where id = p_account_id;
  perform public._refresh_site();
  return public.ops_state(p_token);
end $$;

-- Hold-Screen an/aus. Einschalten setzt die Freigabe zurück.
create or replace function public.ops_set_hold(p_token text, p_enabled boolean)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  update public.site_state
     set hold_enabled = coalesce(p_enabled, false), released = false, updated_at = now()
   where id = 1;
  perform public._refresh_site();
  return public.ops_state(p_token);
end $$;

-- Sofort freigeben (auch wenn noch nicht alle eingecheckt sind)
create or replace function public.ops_release(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  update public.site_state set released = true, updated_at = now() where id = 1;
  return public.ops_state(p_token);
end $$;



-- ---------------------------------------------------------------------
-- Commander-Passwort setzen (überschreibt die Version aus Abschnitt 6):
-- zusätzlich wird der Commander-Account "havoc" mit demselben Passwort
-- angelegt bzw. aktualisiert. Nur im SQL Editor ausführbar.
-- ---------------------------------------------------------------------
create or replace function public.set_commander_password(p_password text)
returns text language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_password is null or char_length(p_password) < 8 then
    raise exception 'Das Commander-Passwort muss mindestens 8 Zeichen lang sein.';
  end if;
  if upper(p_password) in ('DEIN-GEHEIMES-PASSWORT', 'PASSWORT', 'PASSWORD', '12345678') then
    raise exception 'Bitte ein eigenes Passwort wählen, nicht den Platzhalter.';
  end if;
  insert into public.commander_config (id, password_hash)
  values (1, extensions.crypt(p_password, extensions.gen_salt('bf', 10)))
  on conflict (id) do update set password_hash = excluded.password_hash, updated_at = now();
  delete from public.host_sessions;   -- alte Logins ungültig machen
  perform public._ensure_commander_account();
  delete from public.account_sessions s using public.accounts a where s.account_id = a.id and a.is_commander;
  return 'Commander-Passwort gesetzt (gilt auch für den Account havoc). Bestehende Commander-Logins wurden abgemeldet.';
end $$;

-- Commander-Account jetzt anlegen (falls das Commander-Passwort schon gesetzt ist)
select public._ensure_commander_account();

-- ---------------------------------------------------------------------
-- RLS + Rechte für Counter, Turnier, Accounts, Stats, Hold-Screen
-- ---------------------------------------------------------------------
alter table public.counter_team    enable row level security;
alter table public.counter_matches enable row level security;
alter table public.tournament      enable row level security;
alter table public.accounts        enable row level security;
alter table public.account_sessions enable row level security;
alter table public.counter_stats   enable row level security;
alter table public.site_state      enable row level security;

revoke all on table public.counter_team, public.counter_matches, public.tournament,
  public.accounts, public.account_sessions, public.counter_stats, public.site_state
from public, anon, authenticated;
-- öffentlich lesbar (Live-Anzeige): Counter, Turnier, Stats, Hold-Status.
-- accounts / account_sessions bleiben komplett gesperrt.
grant select on table public.counter_team, public.counter_matches, public.tournament,
  public.counter_stats, public.site_state
to anon, authenticated;

drop policy if exists "counter_team: lesen erlaubt" on public.counter_team;
create policy "counter_team: lesen erlaubt" on public.counter_team
  for select to anon, authenticated using (true);
drop policy if exists "counter_matches: lesen erlaubt" on public.counter_matches;
create policy "counter_matches: lesen erlaubt" on public.counter_matches
  for select to anon, authenticated using (true);
drop policy if exists "tournament: lesen erlaubt" on public.tournament;
create policy "tournament: lesen erlaubt" on public.tournament
  for select to anon, authenticated using (true);
drop policy if exists "counter_stats: lesen erlaubt" on public.counter_stats;
create policy "counter_stats: lesen erlaubt" on public.counter_stats
  for select to anon, authenticated using (true);
drop policy if exists "site_state: lesen erlaubt" on public.site_state;
create policy "site_state: lesen erlaubt" on public.site_state
  for select to anon, authenticated using (true);

revoke all on function
  public._clean_label(text, int),
  public._norm(text), public._account_auth(text), public._account_session(uuid),
  public._in_roster(text), public._in_tournament(text), public._active_game(), public._refresh_site(),
  public._commander_username(), public._site_open(), public._ensure_commander_account(), public._players_hold_guard(),
  public.set_commander_password(text),
  public.account_register(text, text), public.account_login(text, text), public.account_logout(text),
  public.account_me(text, boolean), public.accounts_public(),
  public.site_status(), public.join_game_account(text, text),
  public.counter_submit_stats(text, bigint, int, int, int, int, int, int),
  public.ops_state(text), public.ops_set_checkin(text, uuid, boolean), public.ops_checkin_all(text, boolean), public.ops_create_account(text, text, text),
  public.ops_reset_password(text, uuid, text), public.ops_delete_account(text, uuid),
  public.ops_set_hold(text, boolean), public.ops_release(text),
  public.counter_state(), public.counter_set_team(text, text, text[]),
  public.counter_add_match(text, text, text, int, int), public.counter_delete_match(text, bigint),
  public.counter_reset(text),
  public.tournament_state(), public.tournament_set_players(text, text[]), public.tournament_draw(text),
  public.tournament_save_scores(text, int[], int[]), public.tournament_clear_scores(text)
from public, anon, authenticated;

grant execute on function
  public.account_register(text, text), public.account_login(text, text), public.account_logout(text),
  public.account_me(text, boolean), public.accounts_public(),
  public.site_status(), public.join_game_account(text, text),
  public.counter_submit_stats(text, bigint, int, int, int, int, int, int),
  public.ops_state(text), public.ops_set_checkin(text, uuid, boolean), public.ops_checkin_all(text, boolean), public.ops_create_account(text, text, text),
  public.ops_reset_password(text, uuid, text), public.ops_delete_account(text, uuid),
  public.ops_set_hold(text, boolean), public.ops_release(text),
  public.counter_state(), public.counter_set_team(text, text, text[]),
  public.counter_add_match(text, text, text, int, int), public.counter_delete_match(text, bigint),
  public.counter_reset(text),
  public.tournament_state(), public.tournament_set_players(text, text[]), public.tournament_draw(text),
  public.tournament_save_scores(text, int[], int[]), public.tournament_clear_scores(text)
to anon, authenticated;

-- Realtime für Counter, Turnier, Stats und Hold-Screen
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['counter_team', 'counter_matches', 'tournament', 'counter_stats', 'site_state'] loop
      if not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;


-- =====================================================================
-- 13. KONTROLLE – sollte 20 Fragen anzeigen
-- =====================================================================

select
  (select count(*) from public.questions)                        as fragen,
  (select count(*) from public.questions where phase = 1)        as phase_1,
  (select count(*) from public.questions where phase = 2)        as phase_2,
  (select count(*) from public.commander_config)                 as commander_passwort_gesetzt,
  (select count(*) from public.counter_team)                     as counter_bereit,
  (select count(*) from public.tournament)                       as turnier_bereit,
  (select count(*) from public.site_state)                       as accounts_bereit;
