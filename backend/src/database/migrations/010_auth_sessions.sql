-- Login sessions, one row per sign-in (S-05).
--
-- A session cookie used to be valid until it expired, whatever happened to
-- it: logout only cleared the browser's copy. Each cookie now names a row
-- here, and the backend accepts it only while that row exists. Logout
-- deletes the row, and "sign out everywhere" deletes them all.
--
-- The id alone signs nobody in: a cookie also carries a signature made with
-- the session key (services/session.ts).
CREATE TABLE IF NOT EXISTS auth_sessions (
    id VARCHAR(64) PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    ip VARCHAR(64),
    user_agent VARCHAR(256)
);
