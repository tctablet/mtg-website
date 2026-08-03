-- Printings-Cache für den Artwork-Picker: der tägliche Preis-Sync befüllt diese
-- Tabelle im selben Bulk-Durchlauf mit allen Paper-Printings der Karten, die in
-- irgendeinem Deck liegen. Die App liest sie mit EINER Query statt ~86 Scryfall-
-- Requests; fehlt die Tabelle (oder ein Name), fällt sie auf Scryfall zurück.
-- Ausführen in Supabase SQL Editor
-- Rollback: DROP TABLE card_printings;  (App und Cron fallen automatisch auf Scryfall zurück)

CREATE TABLE IF NOT EXISTS card_printings (
  scryfall_id uuid PRIMARY KEY,
  name text NOT NULL,
  set_code text NOT NULL,
  set_name text NOT NULL,
  released_at date,
  image_small text,
  image_normal text,
  image_png text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_card_printings_name ON card_printings (name);

ALTER TABLE card_printings ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY kennt kein IF NOT EXISTS — das DROP davor macht das Skript idempotent
DROP POLICY IF EXISTS "card_printings_public_read" ON card_printings;
CREATE POLICY "card_printings_public_read" ON card_printings FOR SELECT USING (true);
-- Bewusst keine anon-Write-Policy: es schreibt nur der Cron mit dem Service-Key.
