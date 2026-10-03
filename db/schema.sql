-- Supranya admin — Postgres schema.
--
-- Mirrors the shapes that used to live as plain JS arrays in src/store.js
-- as closely as possible, so server.js's route handlers change from
-- Array.find()/.push()/.splice() to SQL queries without the JSON each
-- endpoint returns needing to change shape — the mobile app and the
-- admin dashboard don't need to know this migration happened.
--
-- IDs stay as the same human-readable strings the app already generates
-- (e.g. "tech-1727..."), rather than switching to a DB-generated UUID —
-- this keeps log output, seed data and anything bookmarked meaningful,
-- and means server.js only changes HOW it stores things, not what an ID
-- looks like.
--
-- Run this once against a fresh database to create everything:
--   psql "$DATABASE_URL" -f db/schema.sql
-- It's safe to re-run — every statement is IF NOT EXISTS / OR REPLACE.

CREATE TABLE IF NOT EXISTS technicians (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  phone     TEXT NOT NULL UNIQUE,
  vehicle   TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'available', -- available | on_job | offline
  latitude  DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  heading   DOUBLE PRECISION -- set while a job's simulation is actively driving them toward a charger
);

CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active', -- active | inactive
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (lower(name));

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  model         TEXT NOT NULL DEFAULT '',
  brand         TEXT NOT NULL DEFAULT '',
  power         TEXT NOT NULL DEFAULT '',
  latitude      DOUBLE PRECISION NOT NULL,
  longitude     DOUBLE PRECISION NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices (customer_id);

CREATE TABLE IF NOT EXISTS addresses (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  line        TEXT NOT NULL,
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_addresses_customer ON addresses (customer_id);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  subject          TEXT NOT NULL,
  service_name     TEXT NOT NULL,
  customer_id      TEXT REFERENCES customers(id) ON DELETE SET NULL,
  customer_name    TEXT NOT NULL,
  customer_phone   TEXT NOT NULL,
  charger_nickname TEXT NOT NULL,
  latitude         DOUBLE PRECISION NOT NULL,
  longitude        DOUBLE PRECISION NOT NULL,
  status           TEXT NOT NULL DEFAULT 'Unassigned', -- Unassigned | Assigned | En Route | Arrived | Completed
  technician_id    TEXT REFERENCES technicians(id) ON DELETE SET NULL,
  assigned_at      TIMESTAMPTZ,
  arrived_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  delay_alerted    BOOLEAN NOT NULL DEFAULT false,
  route_path       JSONB -- live-simulation road route polyline
);
CREATE INDEX IF NOT EXISTS idx_jobs_technician ON jobs (technician_id);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs (customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_assigned_at ON jobs (assigned_at);
CREATE INDEX IF NOT EXISTS idx_jobs_search ON jobs (lower(id), lower(subject), lower(customer_name));

CREATE TABLE IF NOT EXISTS attendance (
  id              TEXT PRIMARY KEY,
  technician_id   TEXT NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  check_in_at     TIMESTAMPTZ NOT NULL,
  marked_by_admin BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_attendance_technician ON attendance (technician_id);
CREATE INDEX IF NOT EXISTS idx_attendance_check_in ON attendance (check_in_at);
-- One check-in per technician per calendar day (IST — see toDateKey in
-- server.js). Enforced with a generated column rather than in application
-- code alone, so a race between two near-simultaneous requests can't both
-- pass the "already checked in?" read and both insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_one_per_day
  ON attendance (technician_id, ((check_in_at AT TIME ZONE 'Asia/Kolkata')::date));

CREATE TABLE IF NOT EXISTS leave_requests (
  id            TEXT PRIMARY KEY,
  technician_id TEXT NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
  from_date     TEXT NOT NULL, -- 'YYYY-MM-DD'
  to_date       TEXT NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_leave_technician ON leave_requests (technician_id);
CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests (status);

CREATE TABLE IF NOT EXISTS alerts (
  id              TEXT PRIMARY KEY,
  job_id          TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  technician_name TEXT NOT NULL,
  message         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts (acknowledged);

-- Single admin account, replacing the old hardcoded { username, password }
-- object in store.js. password_hash is a bcrypt hash, never plaintext.
-- Seeded separately (see db/seed-admin.js) from ADMIN_USERNAME /
-- ADMIN_PASSWORD env vars so the real password never lives in a file.
CREATE TABLE IF NOT EXISTS admin_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);
