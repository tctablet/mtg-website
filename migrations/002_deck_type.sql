-- Resterampe: Custom vs. Precon unterscheiden
-- Ausführen in Supabase SQL Editor

ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS deck_type text NOT NULL DEFAULT 'precon';

-- Optional: Constraint auf erlaubte Werte
ALTER TABLE decks
  DROP CONSTRAINT IF EXISTS decks_deck_type_check;
ALTER TABLE decks
  ADD CONSTRAINT decks_deck_type_check CHECK (deck_type IN ('precon', 'custom'));
