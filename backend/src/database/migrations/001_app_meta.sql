-- Facts about the installation itself, as opposed to settings someone edits.
-- The first is `encryption_key_check`: a known value sealed under
-- SETTINGS_ENCRYPTION_KEY, so a rebuilt host started with a different key is
-- refused at startup instead of failing to open every stored secret one by
-- one (backend/src/services/keyCheck.ts).
CREATE TABLE IF NOT EXISTS app_meta (
    key VARCHAR(64) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
