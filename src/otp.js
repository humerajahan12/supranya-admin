'use strict';
// Real one-time-password login for the mobile app.
//
// Providers (OTP_PROVIDER env):
//   msg91   - sends the SMS through MSG91 (needs MSG91_AUTHKEY, MSG91_TEMPLATE_ID,
//             and a DLT-approved template — mandatory for OTP SMS in India)
//   console - prints the code in the server log. Development ONLY: refused
//             when NODE_ENV=production.
//
// OTP_TEST_NUMBERS="+919000000001:123456,+919000000002:654321" gives fixed codes
// for specific numbers (Play Store reviewers, your own testing). No SMS is
// sent for them. Keep this list short — each entry is a standing back door.
const crypto = require('crypto');
const { pool } = require('../db/index');

const CODE_LENGTH = 6;
const TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_SENDS_PER_HOUR = 5;

const PHONE_RE = /^\+91\d{10}$/;

function testNumbers() {
  const map = {};
  (process.env.OTP_TEST_NUMBERS || '').split(',').forEach((pair) => {
    const [phone, code] = pair.trim().split(':');
    if (phone && code) map[phone] = code;
  });
  return map;
}

function hash(phone, role, code) {
  return crypto.createHmac('sha256', process.env.AUTH_TOKEN_SECRET).update(`${phone}|${role}|${code}`).digest('hex');
}

async function sendSms(phone, code) {
  const provider = process.env.OTP_PROVIDER || 'console';
  if (provider === 'console') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('OTP_PROVIDER=console is not allowed in production. Set OTP_PROVIDER=msg91.');
    }
    console.log(`[OTP dev] ${phone} -> ${code}`);
    return;
  }
  if (provider === 'msg91') {
    const { MSG91_AUTHKEY, MSG91_TEMPLATE_ID } = process.env;
    if (!MSG91_AUTHKEY || !MSG91_TEMPLATE_ID) throw new Error('MSG91_AUTHKEY / MSG91_TEMPLATE_ID not set');
    const url =
      `https://control.msg91.com/api/v5/otp?template_id=${encodeURIComponent(MSG91_TEMPLATE_ID)}` +
      `&mobile=${encodeURIComponent(phone.replace('+', ''))}&otp=${code}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { authkey: MSG91_AUTHKEY, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.type === 'error') throw new Error(`MSG91 rejected the request: ${JSON.stringify(body)}`);
    return;
  }
  throw new Error(`Unknown OTP_PROVIDER "${provider}"`);
}

// Returns { ok:true, resendInSeconds } or { ok:false, status, error }.
async function requestOtp(phone, role) {
  if (!PHONE_RE.test(phone)) return { ok: false, status: 400, error: 'Enter a valid 10-digit mobile number.' };

  const recent = await pool.query(
    `SELECT created_at FROM otp_codes WHERE phone = $1 AND role = $2 AND created_at > now() - interval '1 hour' ORDER BY created_at DESC`,
    [phone, role]
  );
  if (recent.rows.length) {
    const sinceLast = Date.now() - new Date(recent.rows[0].created_at).getTime();
    if (sinceLast < RESEND_COOLDOWN_MS) {
      return { ok: false, status: 429, error: `Please wait ${Math.ceil((RESEND_COOLDOWN_MS - sinceLast) / 1000)}s before requesting another code.` };
    }
    if (recent.rows.length >= MAX_SENDS_PER_HOUR) {
      return { ok: false, status: 429, error: 'Too many codes requested. Try again in an hour.' };
    }
  }

  const fixed = testNumbers()[phone];
  const code = fixed || String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');

  // Store first, send second: if SMS fails the row is removed so the user
  // isn't locked out by the cooldown for a code that never arrived.
  const ins = await pool.query(
    `INSERT INTO otp_codes (phone, role, code_hash, expires_at) VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond') RETURNING id`,
    [phone, role, hash(phone, role, code), TTL_MS]
  );
  if (!fixed) {
    try {
      await sendSms(phone, code);
    } catch (err) {
      console.error('OTP send failed:', err.message);
      await pool.query('DELETE FROM otp_codes WHERE id = $1', [ins.rows[0].id]);
      return { ok: false, status: 502, error: 'Could not send the code right now. Please try again shortly.' };
    }
  }
  pool.query(`DELETE FROM otp_codes WHERE created_at < now() - interval '1 day'`).catch(() => {});
  return { ok: true, resendInSeconds: RESEND_COOLDOWN_MS / 1000 };
}

// Returns { ok:true } or { ok:false, status, error }. A code works once.
async function verifyOtp(phone, role, code) {
  if (!PHONE_RE.test(phone) || !/^\d{6}$/.test(String(code || ''))) {
    return { ok: false, status: 400, error: 'Enter the 6-digit code.' };
  }
  const { rows } = await pool.query(
    `SELECT * FROM otp_codes WHERE phone = $1 AND role = $2 ORDER BY created_at DESC LIMIT 1`,
    [phone, role]
  );
  const row = rows[0];
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 400, error: 'Code expired. Request a new one.' };
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, status: 429, error: 'Too many wrong attempts. Request a new code.' };
  }
  const expected = Buffer.from(row.code_hash, 'hex');
  const given = Buffer.from(hash(phone, role, code), 'hex');
  if (!crypto.timingSafeEqual(expected, given)) {
    await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    return { ok: false, status: 400, error: 'Incorrect code.' };
  }
  await pool.query('DELETE FROM otp_codes WHERE phone = $1 AND role = $2', [phone, role]);
  return { ok: true };
}

module.exports = { requestOtp, verifyOtp, PHONE_RE };
