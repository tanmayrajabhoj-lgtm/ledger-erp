-- Ledger ERP database schema
-- Run this once against your Neon Postgres database (see DEPLOY.md).

-- Generic key/value store for the non-sensitive parts of the app data.
-- This mirrors the shape the frontend already worked with (one JSON blob
-- per top-level section), so most of the frontend's render/save logic
-- doesn't need to change -- only WHERE it saves to changes (API instead
-- of localStorage).
CREATE TABLE IF NOT EXISTS kv_store (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Admin login. Single row. Password is bcrypt-hashed, never stored/sent
-- as plain text.
CREATE TABLE IF NOT EXISTS admin_auth (
  id            INT PRIMARY KEY DEFAULT 1,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL
);

-- Student logins. One row per student, keyed by the student's id (matches
-- the id used inside the 'students' array in kv_store). Password is
-- bcrypt-hashed.
CREATE TABLE IF NOT EXISTS student_auth (
  student_id    TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

-- NOTE: the default admin row (username "admin", password "admin123") is
-- seeded automatically by server.js the first time it boots against an
-- empty admin_auth table -- it hashes the password with bcrypt there
-- rather than shipping a hash in this file.

-- Seed empty top-level sections so loadDB() has consistent shapes to read.
INSERT INTO kv_store (key, value) VALUES
  ('settings', '{"instituteName":"Ledger Tuition Center","testPhotoRetentionDays":0}'),
  ('students', '[]'),
  ('batches', '[]'),
  ('attendance', '{}'),
  ('fees', '[]'),
  ('homework', '[]'),
  ('homeworkStatus', '{}'),
  ('announcements', '[]'),
  ('testPhotos', '[]')
ON CONFLICT (key) DO NOTHING;
