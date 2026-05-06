-- Resterampe: Decks zum Verkauf markieren
-- Ausführen in Supabase SQL Editor

ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS for_sale boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sealed_price_eur numeric,
  ADD COLUMN IF NOT EXISTS archetype text,
  ADD COLUMN IF NOT EXISTS playstyle text;

CREATE INDEX IF NOT EXISTS decks_for_sale_idx ON decks (for_sale) WHERE for_sale = true;
