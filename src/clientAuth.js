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

// 90 days — long-lived on purpose. There is no refresh-token flow yet, and
// the OTP step is currently a mock ("any 4 digits"), so a short expiry would
// just mean the customer re-does a meaningless OTP screen every few days for
// no real security gain. Shortening this is worth revisiting once OTP is
// real (MSG91 integration, deferred for now).
const TOKEN_TTL = '90d';

function issueToken({ sub, role }) {
  return jwt.sign({ sub, role }, secret(), { expiresIn: TOKEN_TTL });
}

// Express middleware factory. Verifies the bearer token and the account
// type (role), and stashes the authenticated id on req.authSub so the route
// handler can check it against whatever id the request is trying to act on
// (a :id route param, or an id field in the body) — see server.js call
// sites for how each route uses it. This file intentionally does NOT guess
// which param name or body field to compare against; that varies per route
// (:id vs :techId vs a body.customerId) and is easy to get subtly wrong by
// trying to generalize it here.
function requireAccount(role) {
  return (req, res, next) => {
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
    if (payload.role !== role) {
      return res.status(403).json({ error: 'This action is not available for this account type.' });
    }
    req.authSub = payload.sub;
    next();
  };
}

const requireCustomerAuth = requireAccount('customer');
const requireTechnicianAuth = requireAccount('technician');

module.exports = { issueToken, requireCustomerAuth, requireTechnicianAuth };
