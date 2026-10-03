'use strict';

// Thin Postgres connection pool, shared by every route handler in
// server.js. Nothing fancier than this is needed — the app makes one
// query per request, not multi-statement transactions, with one
// exception (the attendance one-record-per-day check-and-insert, which
// relies on the DB's own unique index — see db/schema.sql — rather than
// an application-level transaction, so a race between two near-
// simultaneous requests still can't create two records for the same day).
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and fill in your Postgres connection string before starting the server.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase's pooled connection (port 6543) terminates TLS with a cert
  // that isn't in Node's default trust store in some environments;
  // rejectUnauthorized: false is the standard Supabase-recommended
  // setting for this, same as their own connection examples. Local dev
  // Postgres (no SSL at all) ignores this option harmlessly.
  ssl: process.env.DATABASE_URL.includes('supabase.co') ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // A background/idle client dying (network blip, DB restart) shouldn't
  // crash the whole server — the next query just gets a fresh connection
  // from the pool.
  console.error('Unexpected Postgres pool error:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
