'use strict';
// PIN login for customers and technicians.
//
// Rules (security-relevant, change deliberately):
//  - 4 digits. Stored only as a bcrypt hash.
//  - 5 wrong tries lock the account for 15 minutes (repeat offenders are
//    just locked again; an admin can unlock instantly).
//  - Obvious PINs (0000, 1234, 1111, ...) are refused.
//  - Any set/reset/change bumps token_version, which kills older sessions.
//  - Admin-issued PINs are temporary: the user must change them at first login.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const repo = require('../db/repo');

const PIN_RE = /^\d{4}$/;
const PHONE_RE = /^\+91\d{10}$/;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

const WEAK = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '0123', '3210', '1212', '2121', '1122', '2580', '0852', '1004', '2000', '2024', '2025', '2026',
]);

// Returns an error string, or null if the PIN is acceptable.
function pinProblem(pin, phone) {
  if (!PIN_RE.test(String(pin || ''))) return 'PIN must be exactly 4 digits.';
  if (WEAK.has(pin)) return 'That PIN is too easy to guess. Choose a different one.';
  if (phone && phone.replace(/\D/g, '').includes(pin)) return 'PIN must not be part of your phone number.';
  return null;
}

function randomPin(phone) {
  for (let i = 0; i < 50; i++) {
    const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!pinProblem(pin, phone)) return pin;
  }
  return '7391';
}

const hashPin = (pin) => bcrypt.hash(pin, 10);

// A fixed hash so "no such account" costs the same time as "wrong PIN",
// which stops timing from revealing which phone numbers exist.
const DUMMY_HASH = bcrypt.hashSync('0000-dummy', 10);

// Checks phone+PIN for the given role. Returns
//   { ok:true, row }  or  { ok:false, status, error, code? }
async function checkLogin(role, phone, pin) {
  if (!PHONE_RE.test(phone || '') || !PIN_RE.test(String(pin || ''))) {
    return { ok: false, status: 400, error: 'Enter your phone number and 4-digit PIN.' };
  }
  const row = await repo.accounts.getAuthByPhone(role, phone);
  if (!row) {
    await bcrypt.compare(String(pin), DUMMY_HASH);
    return { ok: false, status: 401, error: 'Incorrect phone number or PIN.' };
  }
  if (row.pin_locked_until && new Date(row.pin_locked_until).getTime() > Date.now()) {
    const mins = Math.ceil((new Date(row.pin_locked_until).getTime() - Date.now()) / 60000);
    return { ok: false, status: 429, code: 'LOCKED', error: `Too many wrong attempts. Try again in ${mins} min, or contact support.` };
  }
  if (!row.pin_hash) {
    return { ok: false, status: 403, code: 'NO_PIN', error: 'Your account is not activated yet. Please contact support to get your PIN.' };
  }
  if (!(await bcrypt.compare(String(pin), row.pin_hash))) {
    const after = await repo.accounts.recordFailure(role, row.id, MAX_ATTEMPTS, LOCK_MS);
    const locked = after && after.pin_locked_until && new Date(after.pin_locked_until).getTime() > Date.now();
    if (locked) {
      await repo.pinAudit.add('system', role, row.id, 'locked');
      return { ok: false, status: 429, code: 'LOCKED', error: 'Too many wrong attempts. Try again in 15 min, or contact support.' };
    }
    const left = MAX_ATTEMPTS - (after ? after.pin_failed_attempts : 0);
    return { ok: false, status: 401, error: `Incorrect phone number or PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` };
  }
  await repo.accounts.recordSuccess(role, row.id);
  return { ok: true, row };
}

module.exports = { pinProblem, randomPin, hashPin, checkLogin, PHONE_RE, PIN_RE };
