-- =====================================================================
--  OPERATION LAN-PARTY – UPDATE: Game Counter + Bracket
--  Nur die NEUEN Teile. Voraussetzung: schema.sql wurde schon einmal
--  ausgeführt (nutzt die vorhandenen Hilfsfunktionen und das Commander-Login).
--  Supabase → SQL Editor → New query → alles einfügen → Run.
--  Löscht keine Daten und kann gefahrlos mehrfach ausgeführt werden.
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
-- 10. BRACKET (1v1, 5 Operatoren, Single Elimination)
--     names[1..5]:  1+2 = Duel 01 (Vorrunde), 3 = Freilos in Duel 02,
--                   4+5 = Duel 03 (Halbfinale)
--     scores[1..8]: Duel 01 a/b, Duel 02 a/b, Duel 03 a/b, Duel 04 a/b
--     Sieger rücken im Browser automatisch nach (höherer Score gewinnt).
-- =====================================================================

create table if not exists public.bracket (
  id         int primary key default 1 check (id = 1),
  names      text[] not null default array['', '', '', '', '']::text[],
  scores     int[]  not null default array[null, null, null, null, null, null, null, null]::int[],
  version    bigint not null default 1,
  updated_at timestamptz not null default now()
);
insert into public.bracket (id) values (1) on conflict (id) do nothing;


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
-- BRACKET – RPCs
-- ---------------------------------------------------------------------
create or replace function public.bracket_state()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'names', to_jsonb(b.names), 'scores', to_jsonb(b.scores),
    'version', b.version, 'updated_at_ms', public._ms(b.updated_at))
  from public.bracket b where b.id = 1
$$;

create or replace function public.bracket_save(p_token text, p_names text[], p_scores int[])
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_names text[] := array[]::text[];
  v_name  text;
  v_score int;
begin
  perform public._require_host(p_token);
  if p_names is null or cardinality(p_names) <> 5 or p_scores is null or cardinality(p_scores) <> 8 then
    raise exception 'BRACKET_INVALID';
  end if;
  foreach v_name in array p_names loop
    if v_name is null or btrim(v_name) = '' then
      v_names := v_names || ''::text;
    else
      v_names := v_names || public._clean_label(v_name, 24);
    end if;
  end loop;
  foreach v_score in array p_scores loop
    if v_score is not null and (v_score < 0 or v_score > 99) then raise exception 'BRACKET_INVALID'; end if;
  end loop;
  insert into public.bracket (id) values (1) on conflict (id) do nothing;
  update public.bracket
     set names = v_names, scores = p_scores, version = version + 1, updated_at = now()
   where id = 1;
  return public.bracket_state();
end $$;

create or replace function public.bracket_reset(p_token text, p_keep_names boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform public._require_host(p_token);
  insert into public.bracket (id) values (1) on conflict (id) do nothing;
  update public.bracket
     set scores = array[null, null, null, null, null, null, null, null]::int[],
         names = case when p_keep_names then names else array['', '', '', '', '']::text[] end,
         version = version + 1, updated_at = now()
   where id = 1;
  return public.bracket_state();
end $$;


-- ---------------------------------------------------------------------
-- RLS + Rechte für Counter und Bracket
-- ---------------------------------------------------------------------
alter table public.counter_team    enable row level security;
alter table public.counter_matches enable row level security;
alter table public.bracket         enable row level security;

revoke all on table public.counter_team, public.counter_matches, public.bracket
from public, anon, authenticated;
grant select on table public.counter_team, public.counter_matches, public.bracket
to anon, authenticated;

drop policy if exists "counter_team: lesen erlaubt" on public.counter_team;
create policy "counter_team: lesen erlaubt" on public.counter_team
  for select to anon, authenticated using (true);
drop policy if exists "counter_matches: lesen erlaubt" on public.counter_matches;
create policy "counter_matches: lesen erlaubt" on public.counter_matches
  for select to anon, authenticated using (true);
drop policy if exists "bracket: lesen erlaubt" on public.bracket;
create policy "bracket: lesen erlaubt" on public.bracket
  for select to anon, authenticated using (true);

revoke all on function
  public._clean_label(text, int),
  public.counter_state(), public.counter_set_team(text, text, text[]),
  public.counter_add_match(text, text, text, int, int), public.counter_delete_match(text, bigint),
  public.counter_reset(text),
  public.bracket_state(), public.bracket_save(text, text[], int[]), public.bracket_reset(text, boolean)
from public, anon, authenticated;

grant execute on function
  public.counter_state(), public.counter_set_team(text, text, text[]),
  public.counter_add_match(text, text, text, int, int), public.counter_delete_match(text, bigint),
  public.counter_reset(text),
  public.bracket_state(), public.bracket_save(text, text[], int[]), public.bracket_reset(text, boolean)
to anon, authenticated;

-- Realtime für Counter und Bracket
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['counter_team', 'counter_matches', 'bracket'] loop
      if not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;


-- Kontrolle: beide Werte sollten 1 sein
select (select count(*) from public.counter_team) as counter_bereit,
       (select count(*) from public.bracket)      as bracket_bereit;
