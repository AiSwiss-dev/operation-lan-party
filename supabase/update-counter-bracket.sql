-- =====================================================================
--  OPERATION LAN-PARTY – UPDATE: Game Counter + Bracket/Turnier
--  Nur die NEUEN Teile. Voraussetzung: schema.sql wurde schon einmal
--  ausgeführt (nutzt die vorhandenen Hilfsfunktionen und das Commander-Login).
--  Supabase → SQL Editor → New query → alles einfügen → Run.
--  Kann gefahrlos mehrfach ausgeführt werden. Einzige DROP-Befehle: das
--  alte, ersetzte 5-Slot-Bracket (siehe Abschnitt 10).
-- =====================================================================

-- =====================================================================
-- 9. GAME COUNTER – Team-Bilanz (5er-Team, CS2 Competitive)
--     Unabhängig vom Quiz. Öffentlich lesbar (Live-Anzeige),
--     ändern nur mit Commander-Login.
-- =====================================================================

-- Team (eine Zeile): Name + 5 Operatoren
create table if not exists public.counter_team (
  id         int primary key default 1 check (id = 1),
  name       text not null default 'NJORGIBICEPS SQUAD' check (char_length(name) between 1 and 32),
  roster     text[] not null default array['', '', '', '', '']::text[],
  updated_at timestamptz not null default now()
);
insert into public.counter_team (id) values (1) on conflict (id) do nothing;

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
-- RLS + Rechte für Counter und Turnier
-- ---------------------------------------------------------------------
alter table public.counter_team    enable row level security;
alter table public.counter_matches enable row level security;
alter table public.tournament      enable row level security;

revoke all on table public.counter_team, public.counter_matches, public.tournament
from public, anon, authenticated;
grant select on table public.counter_team, public.counter_matches, public.tournament
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

revoke all on function
  public._clean_label(text, int),
  public.counter_state(), public.counter_set_team(text, text, text[]),
  public.counter_add_match(text, text, text, int, int), public.counter_delete_match(text, bigint),
  public.counter_reset(text),
  public.tournament_state(), public.tournament_set_players(text, text[]), public.tournament_draw(text),
  public.tournament_save_scores(text, int[], int[]), public.tournament_clear_scores(text)
from public, anon, authenticated;

grant execute on function
  public.counter_state(), public.counter_set_team(text, text, text[]),
  public.counter_add_match(text, text, text, int, int), public.counter_delete_match(text, bigint),
  public.counter_reset(text),
  public.tournament_state(), public.tournament_set_players(text, text[]), public.tournament_draw(text),
  public.tournament_save_scores(text, int[], int[]), public.tournament_clear_scores(text)
to anon, authenticated;

-- Realtime für Counter und Turnier
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['counter_team', 'counter_matches', 'tournament'] loop
      if not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;


-- Kontrolle: beide Werte sollten 1 sein
select (select count(*) from public.counter_team) as counter_bereit,
       (select count(*) from public.tournament)   as turnier_bereit;
