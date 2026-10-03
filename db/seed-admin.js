'use strict';

// Creates (or updates the password of) the one admin account, from
// ADMIN_USERNAME / ADMIN_PASSWORD in .env. Run this once after applying
// db/schema.sql, and again any time you want to change the password:
//   node db/seed-admin.js
//
// The real password never lives in a committed file — only its bcrypt
// hash is stored, in the database.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./index');

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.error('Set ADMIN_USERNAME and ADMIN_PASSWORD in .env first.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('ADMIN_PASSWORD should be at least 8 characters — pick something stronger before going live.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO admin_users (id, username, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [`admin-${username}`, username, passwordHash]
  );
  console.log(`Admin account "${username}" is set.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Failed to seed admin account:', err.message);
  process.exit(1);
});
