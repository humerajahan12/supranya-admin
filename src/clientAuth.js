'use strict';
// Real auth tokens for the mobile app's customer/technician accounts.
//
// Before this file: /api/customers/:id/devices, /api/technicians/:id/jobs,
// etc. trusted whatever :id was in the URL — anyone who learned (or guessed)
// another customer's id could read or write their data with a plain fetch,
// no login required. The admin dashboard already had real auth (cookie
// sessions + requireAuth in server.js); this gives the mobile app's
// customer/technician side an equivalent: a signed token proving which
// account is actually making the request.
//
// Deliberately NOT the same mechanism as admin auth — the admin dashboard is
// one browser session with a cookie; the mobile app is many independent
// devices each "logging in" as a customer or technician via phone+OTP, so a
// bearer token it can store and send itself is the right shape here.
const jwt = require('jsonwebtoken');

function secret() {
  if (!process.env.AUTH_TOKEN_SECRET) {
    throw new Error('AUTH_TOKEN_SECRET is not set — add it to .env (any long random string, separate from SESSION_SECRET).');
  }
  return process.env.AUTH_TOKEN_SECRET;
}

// 30 days. A token is refreshed every time the app opens (POST
// /api/auth/refresh), so an active user is never asked for their PIN again;
// only someone who stays away 30+ days, signs out, or has their PIN reset.
const TOKEN_TTL = '30d';

// v  = the account's token_version at issue time. Setting/resetting a PIN
//      bumps the version in the database, which instantly invalidates every
//      older token (stolen phone, ex-employee, admin reset).
// mc = "must change PIN": the token may ONLY be used to change the PIN.
function issueToken({ sub, role, v = 0, mc = false }) {
  const claims = { sub, role, v };
  if (mc) claims.mc = true;
  return jwt.sign(claims, secret(), { expiresIn: TOKEN_TTL });
}

// Short cache so every request doesn't hit the database for the version.
// A PIN change on this server instance clears its entry (invalidate), so
// revocation is immediate; the TTL only bounds staleness across restarts.
const versionCache = new Map();
const VERSION_TTL_MS = 15 * 1000;
function invalidate(role, id) {
  versionCache.delete(`${role}:${id}`);
}
async function currentVersion(role, id) {
  const key = `${role}:${id}`;
  const hit = versionCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.version;
  const repo = require('../db/repo');
  const state = await repo.accounts.getTokenState(role, id);
  const version = state ? state.version : null; // null = account no longer exists
  versionCache.set(key, { version, exp: Date.now() + VERSION_TTL_MS });
  return version;
}

// Express middleware factory. Verifies the bearer token, the account type,
// and that the token is still current for that account (see above). Stashes
// the authenticated id on req.authSub so each route can compare it with the
// id it is acting on. `allowPinChange` is only set on the change-PIN route.
function requireAccount(role, { allowPinChange = false } = {}) {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header — please log in again.' });
      }
      let payload;
      try {
        payload = jwt.verify(token, secret());
      } catch (err) {
        return res.status(401).json({ error: 'Session expired or invalid — please log in again.' });
      }
      if (role && payload.role !== role) {
        return res.status(403).json({ error: 'This action is not available for this account type.' });
      }
      // Tokens from before PIN login carry no version number: reject them.
      const version = typeof payload.v === 'number' ? await currentVersion(payload.role, payload.sub) : null;
      if (version === null || version !== payload.v) {
        return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
      }
      if (payload.mc && !allowPinChange) {
        return res.status(403).json({ code: 'PIN_CHANGE_REQUIRED', error: 'Please set a new PIN to continue.' });
      }
      req.authSub = payload.sub;
      req.authRole = payload.role;
      next();
    } catch (err) {
      next(err);
    }
  };
}

const requireCustomerAuth = requireAccount('customer');
const requireTechnicianAuth = requireAccount('technician');
const requireAnyAccount = requireAccount(null);
const requireAnyAccountForPinChange = requireAccount(null, { allowPinChange: true });

module.exports = {
  issueToken, invalidate,
  requireCustomerAuth, requireTechnicianAuth, requireAnyAccount, requireAnyAccountForPinChange,
};
