-- Canonical Supabase schema for the grood history mirror.
-- The keeper writes with the service key; the frontend reads with the anon key
-- (grant read via RLS policies below).

create table if not exists gz_rounds (
  round_id        bigint primary key,
  winning_cell    smallint,
  total_players   integer,
  total_deposits  text,          -- raw 6-decimal USDG base units (frontend divides by 1e6)
  is_bonus        boolean default false,
  resolve_tx_hash text,
  drand_round     bigint,
  created_at      timestamptz default now()
);

create table if not exists gz_round_players (
  round_id        bigint not null,
  player_address  text not null,
  cell_picked     smallint,
  is_winner       boolean default false,
  pick_tx_hash    text,
  created_at      timestamptz default now(),
  primary key (round_id, player_address)
);

alter table gz_rounds enable row level security;
alter table gz_round_players enable row level security;
create policy "public read rounds" on gz_rounds for select using (true);
create policy "public read players" on gz_round_players for select using (true);
