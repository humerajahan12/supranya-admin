'use strict';

// Applies db/schema.sql to whatever DATABASE_URL points at. A plain Node
// script rather than an npm script piping into psql, so it works the same
// on Windows/PowerShell as it does on macOS/Linux — no assumption that
// psql is installed or that $DATABASE_URL shell-expands the way it does
// in bash.
//
// Safe to re-run: every statement in schema.sql is IF NOT EXISTS.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Schema applied.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
