'use strict';

// Razorpay integration — order creation + signature verification.
//
// Security principle this follows throughout: the mobile app never gets to
// say how much something costs. It sends a serviceId; this file looks up
// the real price. If a customer tampered with the app's local state to
// claim a ₹899 service costs ₹1, the backend simply never sees that number
// — it computes its own from SERVICES below.
//
// SERVICES here must stay in sync with supranya-charge-app's
// src/data/mock.js services array (same ids/prices) — that file is what
// renders the price list to the customer; this one is the only copy that
// actually matters for what gets charged. A mismatch means the customer
// sees one price and gets charged another, so if you change a price,
// change both.
const crypto = require('crypto');

const PLATFORM_FEE = 20;

const SERVICES = {
  'svc-annual': { name: 'Annual Maintenance', price: 899 },
  'svc-repair': { name: 'Fault Diagnosis & Repair', price: 499 },
};

function getRazorpay() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set — add them to .env (test keys from your Razorpay dashboard).');
  }
  // Lazy require + construct so a server without these env vars set can
  // still boot and serve every other route — payments just won't work
  // until they're configured, rather than crashing the whole process.
  const Razorpay = require('razorpay');
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

// serviceId -> { amountPaise, totalRupees, service }, or null if serviceId
// is unrecognized (caller should 400).
function priceFor(serviceId) {
  const service = SERVICES[serviceId];
  if (!service) return null;
  const totalRupees = service.price + PLATFORM_FEE;
  return { amountPaise: totalRupees * 100, totalRupees, service };
}

async function createOrder({ serviceId }) {
  const priced = priceFor(serviceId);
  if (!priced) {
    const err = new Error(`Unknown serviceId "${serviceId}"`);
    err.statusCode = 400;
    throw err;
  }
  const razorpay = getRazorpay();
  const order = await razorpay.orders.create({
    amount: priced.amountPaise,
    currency: 'INR',
    receipt: `svc_${serviceId}_${Date.now()}`,
  });
  return {
    keyId: process.env.RAZORPAY_KEY_ID,
    orderId: order.id,
    amount: priced.amountPaise,
    currency: 'INR',
    totalRupees: priced.totalRupees,
    serviceName: priced.service.name,
  };
}

// Razorpay's documented verification scheme: HMAC-SHA256 of
// "order_id|payment_id" using the key secret, compared to the signature
// the checkout flow hands back. This is what actually proves a payment
// happened — never trust a client simply saying "payment succeeded"
// (which is exactly what the old mock did).
function verifySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  // Constant-time compare — a plain === here would leak timing
  // information about how many leading characters matched, which is the
  // kind of thing that turns into a real attack against signature checks.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(razorpay_signature, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { SERVICES, PLATFORM_FEE, priceFor, createOrder, verifySignature };
