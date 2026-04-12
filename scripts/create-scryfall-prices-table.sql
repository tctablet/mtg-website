-- Run this in the Supabase SQL Editor to create the scryfall_prices table

create table if not exists scryfall_prices (
  name text primary key,
  cheapest_eur numeric not null,
  is_foil boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Allow reads for anon key (frontend)
alter table scryfall_prices enable row level security;

create policy "Allow public read" on scryfall_prices
  for select using (true);

-- Index for fast lookups
create index if not exists idx_scryfall_prices_name on scryfall_prices (name);
