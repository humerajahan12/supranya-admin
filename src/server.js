'use strict';

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const repo = require('../db/repo');
const { startSimulation, stopSimulation } = require('./simulate');
const { geocodeSearch } = require('./routing');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is not set. Copy .env.example to .env and fill in a real random secret before starting the server.');
}

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
  })
);

// Every route handler here is async and talks to Postgres — a thrown
// error (a bad query, the DB being briefly unreachable) would otherwise
// crash the process, since Express doesn't catch rejected promises on its
// own for regular route handlers. This wraps every app.METHOD call once,
// centrally, instead of wrapping every single handler in its own
// try/catch — a route that forgets to catch is far more likely than this
// wrapper being wrong.
for (const method of ['get', 'post', 'patch', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => {
    const wrapped = handlers.map((h) =>
      h.length >= 3
        ? h // already has its own (err, req, res, next) shape — leave alone (none currently do)
        : async (req, res, next) => {
            try {
              await h(req, res, next);
            } catch (err) {
              if (!res.headersSent && err.code === '23505') {
                // Postgres unique-violation — most commonly a duplicate
                // phone number (technicians and customers are both
                // unique-by-phone; the old in-memory store never enforced
                // this, which was a latent bug in every "by phone" lookup
                // silently matching whichever record came first).
                const field = /\(phone\)/.test(err.detail || '') ? 'phone number' : 'value';
                return res.status(409).json({ error: `That ${field} is already in use.` });
              }
              console.error(`${method.toUpperCase()} ${routePath} failed:`, err);
              if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on our end. Try again in a moment.' });
            }
          }
    );
    return original(routePath, ...wrapped);
  };
}

// --- Auth ------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const account = username ? await repo.adminUsers.findByUsername(username) : null;
  const ok = account && (await bcrypt.compare(password || '', account.password_hash));
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// --- Customer registration (PUBLIC — called by the customer's phone, not
// an admin session). A real deployment would put its own auth here (the
// customer's own OTP-verified session token), but it must NOT require the
// admin password, since the mobile app calling it is never logged in as
// admin. ---------------------------------------------------------------
app.get('/api/customers/by-phone', async (req, res) => {
  const phone = (req.query.phone || '').trim();
  const customer = await repo.customers.getByPhone(phone);
  if (!customer) return res.status(404).json({ error: 'No customer found for this phone number' });
  res.json(customer);
});

app.post('/api/customers/register', async (req, res) => {
  const { phone, name } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  let customer = await repo.customers.getByPhone(phone);
  if (!customer) {
    customer = await repo.customers.create({ id: `cust-${Date.now()}`, name: name || 'Customer', phone });
  } else if (name && customer.name === 'Customer') {
    await repo.customers.setName(customer.id, name);
    customer = await repo.customers.getById(customer.id);
  }

  await broadcastState();
  res.status(201).json(customer);
});

app.post('/api/customers/:id/devices', async (req, res) => {
  const customer = await repo.customers.getById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const { name, model, brand, power, latitude, longitude } = req.body || {};
  if (!name || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'name, latitude and longitude are required' });
  }

  const device = await repo.devices.add(customer.id, {
    id: `dev-${Date.now()}`,
    name,
    model,
    brand,
    power,
    latitude: Number(latitude),
    longitude: Number(longitude),
  });

  await broadcastState();
  res.status(201).json(device);
});

// Admin updating a device's location — e.g. correcting a pin the customer
// placed wrong at registration. Admin-only, unlike the POST above (which
// the customer's own app calls to register a device in the first place).
app.patch('/api/customers/:id/devices/:deviceId', requireAuth, async (req, res) => {
  const device = await repo.devices.getById(req.params.id, req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const { latitude, longitude } = req.body || {};
  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'latitude and longitude are required' });
  }
  const updated = await repo.devices.setLocation(req.params.deviceId, Number(latitude), Number(longitude));

  await broadcastState();
  res.json(updated);
});

// A customer's own address book — same pattern as devices above: public
// (the customer app isn't an admin session), scoped to that customerId.
// The first address a customer adds is automatically their default; a
// later one marked isDefault:true unsets any previous default.
app.post('/api/customers/:id/addresses', async (req, res) => {
  const customer = await repo.customers.getById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const { label, line, latitude, longitude, isDefault } = req.body || {};
  if (!label || !line || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'label, line, latitude and longitude are required' });
  }

  const existingCount = await repo.addresses.countForCustomer(customer.id);
  const makeDefault = !!isDefault || existingCount === 0;
  const address = await repo.addresses.add(customer.id, {
    id: `addr-${Date.now()}`,
    label,
    line,
    latitude: Number(latitude),
    longitude: Number(longitude),
    isDefault: makeDefault,
  });

  await broadcastState();
  res.status(201).json(address);
});

// --- Ticket creation & customer-facing ticket lookup (PUBLIC — called by
// the customer's phone). ---------------------------------------------------
app.post('/api/tickets', async (req, res) => {
  const { customerId, customerName, customerPhone, chargerNickname, latitude, longitude, serviceName, subject } = req.body || {};
  if (!customerName || !customerPhone || !chargerNickname || latitude == null || longitude == null || !serviceName) {
    return res.status(400).json({ error: 'customerName, customerPhone, chargerNickname, latitude, longitude and serviceName are required' });
  }
  const ticket = await repo.jobs.create({
    id: `TKT-${Date.now()}`,
    subject: subject || serviceName,
    serviceName,
    customerId: customerId || null,
    customerName,
    customerPhone,
    chargerNickname,
    latitude: Number(latitude),
    longitude: Number(longitude),
  });
  await broadcastState();
  res.status(201).json(ticket);
});

// Admin-created job (ADMIN-ONLY). Same shape as the public /api/tickets
// above, plus an optional customerId to link it to an existing registered
// customer, and an optional technicianId to assign it immediately on
// creation instead of leaving it Unassigned.
app.post('/api/jobs', requireAuth, async (req, res) => {
  const { customerId, customerName, customerPhone, chargerNickname, latitude, longitude, serviceName, subject, technicianId } = req.body || {};
  if (!customerName || !customerPhone || !chargerNickname || latitude == null || longitude == null || !serviceName) {
    return res.status(400).json({ error: 'customerName, customerPhone, chargerNickname, latitude, longitude and serviceName are required' });
  }
  if (customerId && !(await repo.customers.getById(customerId))) {
    return res.status(404).json({ error: 'customerId does not match any registered customer' });
  }

  const job = await repo.jobs.create({
    id: `TKT-${Date.now()}`,
    subject: subject || serviceName,
    serviceName,
    customerId: customerId || null,
    customerName,
    customerPhone,
    chargerNickname,
    latitude: Number(latitude),
    longitude: Number(longitude),
  });

  if (technicianId) {
    const technician = await repo.technicians.getById(technicianId);
    if (!technician) {
      await broadcastState();
      return res.status(201).json({ job, warning: 'Job created, but the technicianId given did not match anyone — left unassigned.' });
    }
    const { job: assignedJob, technician: assignedTechnician } = await assignJobToTechnician(job.id, technician);
    return res.status(201).json({ job: assignedJob, technician: assignedTechnician });
  }

  await broadcastState();
  res.status(201).json({ job });
});

// A customer's own full record, devices included.
app.get('/api/customers/:id', async (req, res) => {
  const customer = await repo.customers.getById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json(customer);
});

// A single ticket by id.
app.get('/api/tickets/:id', async (req, res) => {
  const job = await repo.jobs.getById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Ticket not found' });
  const technician = job.technicianId ? await repo.technicians.getById(job.technicianId) : null;
  res.json({ ...job, technicianName: technician ? technician.name : null });
});

app.get('/api/customers/:id/tickets', async (req, res) => {
  const customer = await repo.customers.getById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const mine = await repo.jobs.listByCustomer(customer.id, customer.phone);
  const techNameById = await technicianNameMap();
  res.json(mine.map((j) => ({ ...j, technicianName: j.technicianId ? techNameById[j.technicianId] || j.technicianId : null })));
});

// --- Technician mobile app login + job list (PUBLIC). ---------------------
app.get('/api/technicians/by-phone', async (req, res) => {
  const phone = (req.query.phone || '').trim();
  const technician = await repo.technicians.getByPhone(phone);
  if (!technician) return res.status(404).json({ error: 'No technician account found for this phone number' });
  res.json(technician);
});

app.get('/api/technicians/:id/jobs', async (req, res) => {
  const technician = await repo.technicians.getById(req.params.id);
  if (!technician) return res.status(404).json({ error: 'Technician not found' });
  res.json(await repo.jobs.listByTechnician(technician.id));
});

// Local-calendar-day key for a millis timestamp. Server and admin/technician
// devices are assumed to share a timezone (this deployment runs entirely in
// India, IST) — used for shaping API responses; the DB's own day-uniqueness
// check (schema.sql) does this same IST conversion directly in SQL.
function toDateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// --- Attendance (PUBLIC — marked from the technician's own app). Just a
// check-in timestamp, once per calendar day — no check-out. ---------------
app.post('/api/technicians/:id/attendance/check-in', async (req, res) => {
  const technician = await repo.technicians.getById(req.params.id);
  if (!technician) return res.status(404).json({ error: 'Technician not found' });

  const record = await repo.attendance.checkIn({ id: `att-${Date.now()}`, technicianId: technician.id });
  if (!record) {
    const already = await repo.attendance.findToday(technician.id);
    return res.status(409).json({ error: 'Already checked in today', record: already });
  }
  await broadcastState();
  res.status(201).json(record);
});

app.get('/api/technicians/:id/attendance', async (req, res) => {
  const technician = await repo.technicians.getById(req.params.id);
  if (!technician) return res.status(404).json({ error: 'Technician not found' });
  res.json(await repo.attendance.listByTechnician(technician.id));
});

// --- Leave requests (PUBLIC where technician-facing). ---------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.post('/api/technicians/:id/leave', async (req, res) => {
  const technician = await repo.technicians.getById(req.params.id);
  if (!technician) return res.status(404).json({ error: 'Technician not found' });

  const { fromDate, toDate, reason } = req.body || {};
  if (!fromDate || !toDate || !reason || !reason.trim()) {
    return res.status(400).json({ error: 'fromDate, toDate and reason are all required' });
  }
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
    return res.status(400).json({ error: 'fromDate and toDate must be YYYY-MM-DD' });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ error: 'fromDate cannot be after toDate' });
  }

  const request = await repo.leave.create({
    id: `leave-${Date.now()}`,
    technicianId: technician.id,
    fromDate,
    toDate,
    reason: reason.trim(),
  });
  await broadcastState();
  res.status(201).json(request);
});

app.get('/api/technicians/:id/leave', async (req, res) => {
  const technician = await repo.technicians.getById(req.params.id);
  if (!technician) return res.status(404).json({ error: 'Technician not found' });
  res.json(await repo.leave.listByTechnician(technician.id));
});

// A technician can withdraw their own request while it's still pending —
// once admin has decided it, it's a record, not a draft.
app.delete('/api/technicians/:id/leave/:leaveId', async (req, res) => {
  const request = await repo.leave.getById(req.params.leaveId);
  if (!request) return res.status(404).json({ error: 'Leave request not found' });
  if (request.technicianId !== req.params.id) {
    return res.status(403).json({ error: 'This leave request does not belong to this technician' });
  }
  if (request.status !== 'pending') {
    return res.status(409).json({ error: `Cannot withdraw a request that's already been ${request.status}` });
  }
  await repo.leave.remove(req.params.leaveId);
  await broadcastState();
  res.json({ ok: true });
});

// Admin-only view of everyone who's registered, with their devices.
app.get('/api/customers', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const { customers, total } = await repo.customers.search({ q, page, pageSize });
  res.json({ customers, total, page, pageSize });
});

app.patch('/api/customers/:id', requireAuth, async (req, res) => {
  const customer = await repo.customers.getById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const { name, phone } = req.body || {};
  if (name != null && !name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
  if (phone != null && !phone.trim()) return res.status(400).json({ error: 'phone cannot be empty' });
  const updated = await repo.customers.updateNameOrPhone(req.params.id, {
    name: name != null ? name.trim() : null,
    phone: phone != null ? phone.trim() : null,
  });
  await broadcastState();
  res.json(updated);
});

app.patch('/api/customers/:id/status', requireAuth, async (req, res) => {
  const customer = await repo.customers.getById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const { status } = req.body || {};
  if (!['active', 'inactive'].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'inactive'" });
  }
  const updated = await repo.customers.setStatus(req.params.id, status);
  await broadcastState();
  res.json(updated);
});

// Same safety principle as deleting a technician: blocked while there's
// open work tied to them.
app.delete('/api/customers/:id', requireAuth, async (req, res) => {
  const customer = await repo.customers.getById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const openTicket = await repo.customers.hasOpenTicket(customer.id, customer.phone);
  if (openTicket) {
    return res.status(409).json({
      error: `Cannot delete ${customer.name} — still has an open ticket ${openTicket.id} (${openTicket.status}). Resolve it first.`,
    });
  }

  await repo.customers.remove(req.params.id);
  await broadcastState();
  res.json({ ok: true });
});

// --- Data API (all require auth) -------------------------------------------
app.get('/api/technicians', requireAuth, async (req, res) => res.json(await repo.technicians.list()));
app.get('/api/jobs', requireAuth, async (req, res) => res.json(await repo.jobs.list()));
app.get('/api/alerts', requireAuth, async (req, res) => res.json(await repo.alerts.list()));

// A single day's status per technician — present (checked in that day),
// on leave (approved/pending), or absent — for the day view of the
// Attendance tab.
async function dayStatusFor(technicianId, dateKey, todayKey) {
  const record = await repo.attendance.findByTechnicianAndDate(technicianId, dateKey);
  if (record) return { status: 'present', checkInAt: record.checkInAt, id: record.id };
  const covering = await repo.leave.findCovering(technicianId, dateKey);
  if (covering) return { status: covering.status === 'approved' ? 'leave-approved' : 'leave-pending', checkInAt: null };
  if (dateKey > todayKey) return { status: 'future', checkInAt: null };
  const dow = new Date(dateKey + 'T00:00:00').getDay();
  return { status: dow === 0 ? 'weekend' : 'absent', checkInAt: null };
}

// The Attendance tab's one summary view — either a single day's roster
// (mode=day, default today) or the current month's per-technician tally
// (mode=month, default this month).
//
// Both modes pull every relevant attendance/leave record for the range in
// ONE query up front (rather than one query per technician per day, which
// is what a naive per-cell dayStatusFor call would do), then compute each
// day's status in memory from that small set — the same shape of work
// server.js always did, just fed from a real query instead of a full
// array scan.
app.get('/api/attendance/summary', requireAuth, async (req, res) => {
  const mode = req.query.mode === 'month' ? 'month' : 'day';
  const todayKey = toDateKey(Date.now());
  const technicians = await repo.technicians.list();

  if (mode === 'day') {
    const date = DATE_RE.test(req.query.date || '') ? req.query.date : todayKey;
    const totals = { present: 0, absent: 0, leaveApproved: 0, leavePending: 0, total: technicians.length };
    const rows = await Promise.all(
      technicians.map(async (t) => {
        const { status, checkInAt, id } = await dayStatusFor(t.id, date, todayKey);
        if (status === 'present') totals.present += 1;
        else if (status === 'absent') totals.absent += 1;
        else if (status === 'leave-approved') totals.leaveApproved += 1;
        else if (status === 'leave-pending') totals.leavePending += 1;
        return { technicianId: t.id, technicianName: t.name, status, checkInAt, attendanceId: id || null };
      })
    );
    return res.json({ mode, date, totals, rows });
  }

  // mode === 'month'
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : todayKey.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const lastDay = month === todayKey.slice(0, 7) ? new Date(todayKey).getDate() : daysInMonth;
  const days = [];
  for (let d = 1; d <= lastDay; d++) days.push(`${month}-${String(d).padStart(2, '0')}`);

  const totals = { presentDays: 0, absentDays: 0, leaveDays: 0 };
  const rows = await Promise.all(
    technicians.map(async (t) => {
      let presentDays = 0, absentDays = 0, leaveDays = 0;
      for (const date of days) {
        const { status } = await dayStatusFor(t.id, date, todayKey);
        if (status === 'present') presentDays += 1;
        else if (status === 'absent') absentDays += 1;
        else if (status === 'leave-approved' || status === 'leave-pending') leaveDays += 1;
      }
      totals.presentDays += presentDays;
      totals.absentDays += absentDays;
      totals.leaveDays += leaveDays;
      return { technicianId: t.id, technicianName: t.name, presentDays, absentDays, leaveDays };
    })
  );

  res.json({ mode, month, totals, rows });
});

// Admin marking attendance on a technician's behalf.
app.post('/api/attendance/mark', requireAuth, async (req, res) => {
  const { technicianId, date } = req.body || {};
  const technician = await repo.technicians.getById(technicianId);
  if (!technician) return res.status(404).json({ error: 'Technician not found' });
  if (!DATE_RE.test(date || '')) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  const todayKey = toDateKey(Date.now());
  if (date > todayKey) return res.status(400).json({ error: "Can't mark attendance for a future date" });

  const record = await repo.attendance.markByAdmin({ id: `att-admin-${Date.now()}`, technicianId, dateKey: date });
  if (!record) {
    const already = await repo.attendance.findByTechnicianAndDate(technicianId, date);
    return res.status(409).json({ error: 'Attendance for that day is already marked', record: already });
  }
  await broadcastState();
  res.status(201).json(record);
});

// Undo either kind of attendance record.
app.delete('/api/attendance/:id', requireAuth, async (req, res) => {
  const removed = await repo.attendance.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Attendance record not found' });
  await broadcastState();
  res.json({ ok: true });
});

// Admin view of every leave request — paginated, searchable, filterable.
app.get('/api/leave', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const { leave, total } = await repo.leave.search({ q, status, page, pageSize });
  res.json({ leave, total, page, pageSize });
});

// Approve or reject a pending leave request.
app.post('/api/leave/:id/decide', requireAuth, async (req, res) => {
  const request = await repo.leave.getById(req.params.id);
  if (!request) return res.status(404).json({ error: 'Leave request not found' });
  if (request.status !== 'pending') {
    return res.status(409).json({ error: `This request has already been ${request.status}` });
  }
  const { status } = req.body || {};
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
  }
  const decided = await repo.leave.decide(req.params.id, status);
  await broadcastState();
  res.json(decided);
});

// Type-to-search a location (Uber/Ola style).
app.get('/api/geocode', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json(await geocodeSearch(q));
});

// Onboard a new technician.
app.post('/api/technicians', requireAuth, async (req, res) => {
  const { name, phone, vehicle, latitude, longitude } = req.body || {};
  if (!name || !phone || !vehicle || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'name, phone, vehicle, latitude and longitude are all required' });
  }
  const technician = await repo.technicians.create({
    id: `tech-${Date.now()}`,
    name,
    phone,
    vehicle,
    latitude: Number(latitude),
    longitude: Number(longitude),
  });
  await broadcastState();
  res.status(201).json(technician);
});

app.patch('/api/technicians/:id', requireAuth, async (req, res) => {
  const technician = await repo.technicians.getById(req.params.id);
  if (!technician) return res.status(404).json({ error: 'Technician not found' });
  const { name, phone, vehicle, latitude, longitude } = req.body || {};
  if (name != null && !name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
  if (phone != null && !phone.trim()) return res.status(400).json({ error: 'phone cannot be empty' });
  if (vehicle != null && !vehicle.trim()) return res.status(400).json({ error: 'vehicle cannot be empty' });

  const fields = {};
  if (name != null) fields.name = name.trim();
  if (phone != null) fields.phone = phone.trim();
  if (vehicle != null) fields.vehicle = vehicle.trim();
  if (latitude != null) fields.latitude = Number(latitude);
  if (longitude != null) fields.longitude = Number(longitude);
  const updated = await repo.technicians.update(req.params.id, fields);
  await broadcastState();
  res.json(updated);
});

// Deletion is blocked while the technician has a job that isn't finished.
app.delete('/api/technicians/:id', requireAuth, async (req, res) => {
  const technician = await repo.technicians.getById(req.params.id);
  if (!technician) return res.status(404).json({ error: 'Technician not found' });

  const activeJob = (await repo.jobs.listByTechnician(technician.id)).find((j) => j.status !== 'Completed');
  if (activeJob) {
    return res.status(409).json({
      error: `Cannot delete ${technician.name} — still assigned to ${activeJob.id} (${activeJob.status}). Reassign or complete that job first.`,
    });
  }

  await repo.technicians.remove(req.params.id);
  await broadcastState();
  res.json({ ok: true });
});

// --- Reporting ---------------------------------------------------------
function avgResponseMinutes(jobList) {
  const withResponse = jobList.filter((j) => j.assignedAt && j.arrivedAt);
  if (!withResponse.length) return null;
  const totalMs = withResponse.reduce((sum, j) => sum + (j.arrivedAt - j.assignedAt), 0);
  return Math.round((totalMs / withResponse.length / 60000) * 10) / 10;
}

function parseRangeQuery(req) {
  const from = req.query.from ? Number(req.query.from) : null;
  const to = req.query.to ? Number(req.query.to) : null;
  return { from, to };
}

async function technicianNameMap() {
  const technicians = await repo.technicians.list();
  return Object.fromEntries(technicians.map((t) => [t.id, t.name]));
}

async function buildReport(jobList) {
  const technicians = await repo.technicians.list();
  const perTechnician = technicians.map((t) => {
    const theirJobs = jobList.filter((j) => j.technicianId === t.id);
    return {
      technicianId: t.id,
      name: t.name,
      status: t.status,
      completed: theirJobs.filter((j) => j.status === 'Completed').length,
      active: theirJobs.filter((j) => j.status !== 'Completed').length,
      delayed: theirJobs.filter((j) => j.delayAlerted).length,
      total: theirJobs.length,
      avgResponseMinutes: avgResponseMinutes(theirJobs),
    };
  });

  const assignedJobs = jobList.filter((j) => j.assignedAt);
  const delayedCount = assignedJobs.filter((j) => j.delayAlerted).length;
  const slaComplianceRate = assignedJobs.length
    ? Math.round(((assignedJobs.length - delayedCount) / assignedJobs.length) * 1000) / 10
    : null;

  const serviceBreakdown = {};
  jobList.forEach((j) => {
    if (!j.serviceName) return;
    serviceBreakdown[j.serviceName] = (serviceBreakdown[j.serviceName] || 0) + 1;
  });

  const summary = {
    totalJobs: jobList.length,
    unassigned: jobList.filter((j) => j.status === 'Unassigned').length,
    active: jobList.filter((j) => !['Unassigned', 'Completed'].includes(j.status)).length,
    completed: jobList.filter((j) => j.status === 'Completed').length,
    delayedCount,
    slaComplianceRate,
    avgResponseMinutes: avgResponseMinutes(assignedJobs),
    availableTechnicians: technicians.filter((t) => t.status === 'available').length,
    onJobTechnicians: technicians.filter((t) => t.status === 'on_job').length,
    serviceBreakdown,
  };

  return { perTechnician, summary };
}

app.get('/api/reports', requireAuth, async (req, res) => {
  const { from, to } = parseRangeQuery(req);
  const { summary } = await buildReport(await repo.jobs.listByDateRange(from, to));
  res.json({ summary });
});

const TECH_SORT_FIELDS = ['name', 'completed', 'active', 'delayed', 'avgResponseMinutes'];

app.get('/api/reports/technicians', requireAuth, async (req, res) => {
  const { from, to } = parseRangeQuery(req);
  const { perTechnician } = await buildReport(await repo.jobs.listByDateRange(from, to));

  const q = (req.query.q || '').trim().toLowerCase();
  const sortBy = TECH_SORT_FIELDS.includes(req.query.sortBy) ? req.query.sortBy : 'completed';
  const sortDir = req.query.sortDir === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 15));

  let filtered = q ? perTechnician.filter((r) => r.name.toLowerCase().includes(q)) : perTechnician;

  filtered = [...filtered].sort((a, b) => {
    const av = a[sortBy], bv = b[sortBy];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const rows = filtered.slice(start, start + pageSize);

  res.json({ rows, total, page, pageSize, sortBy, sortDir });
});

app.get('/api/reports/history', requireAuth, async (req, res) => {
  const { from, to } = parseRangeQuery(req);
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 15));

  const { jobs, total } = await repo.jobs.search({ q, from, to, page, pageSize });
  const techNameById = await technicianNameMap();
  const history = jobs.map((j) => ({ ...j, technicianName: j.technicianId ? techNameById[j.technicianId] || j.technicianId : null }));

  res.json({ history, total, page, pageSize });
});

app.get('/api/reports/trend', requireAuth, async (req, res) => {
  const { from, to } = parseRangeQuery(req);
  res.json(await repo.jobs.dailyCounts(from, to));
});

function attendancePeriodKey(ts, groupBy) {
  const d = new Date(ts);
  if (groupBy === 'month') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  if (groupBy === 'week') {
    const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNr = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 60 * 60 * 1000));
    return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return d.toISOString().slice(0, 10);
}

app.get('/api/reports/attendance', requireAuth, async (req, res) => {
  const { from, to } = parseRangeQuery(req);
  const groupBy = ['day', 'week', 'month'].includes(req.query.groupBy) ? req.query.groupBy : 'day';

  const rows = await repo.attendance.findInRange(from, to);
  const technicians = await repo.technicians.list();
  const todayKey = toDateKey(Date.now());

  const perTechnician = technicians.map((t) => ({
    technicianId: t.id,
    name: t.name,
    presentDays: rows.filter((a) => a.technicianId === t.id).length,
  }));

  const seriesMap = {};
  rows.forEach((a) => {
    const key = attendancePeriodKey(a.checkInAt, groupBy);
    if (!seriesMap[key]) seriesMap[key] = { period: key, presentCount: 0 };
    seriesMap[key].presentCount += 1;
  });
  const series = Object.values(seriesMap).sort((a, b) => (a.period < b.period ? -1 : 1));

  res.json({
    summary: {
      totalPresentDays: rows.length,
      technicianCount: technicians.length,
      checkedInTodayCount: rows.filter((a) => toDateKey(a.checkInAt) === todayKey).length,
      avgPresentDaysPerTechnician: technicians.length ? Math.round((rows.length / technicians.length) * 10) / 10 : 0,
    },
    perTechnician,
    series,
    groupBy,
  });
});

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function formatDateForExport(ts) {
  return ts ? new Date(ts).toISOString() : '';
}

app.get('/api/reports/export', requireAuth, async (req, res) => {
  const { from, to } = parseRangeQuery(req);
  const filteredJobs = await repo.jobs.listByDateRange(from, to);
  const { perTechnician } = await buildReport(filteredJobs);
  const techNameById = await technicianNameMap();

  const lines = [];
  lines.push('Technician Performance');
  lines.push(['Name', 'Status', 'Completed', 'Active', 'Delayed', 'Avg Response (min)'].join(','));
  perTechnician.forEach((r) => {
    lines.push([r.name, r.status, r.completed, r.active, r.delayed, r.avgResponseMinutes ?? ''].map(csvEscape).join(','));
  });
  lines.push('');
  lines.push('Job History');
  lines.push(['Job ID', 'Subject', 'Technician', 'Status', 'Assigned At', 'Arrived At', 'Completed At'].join(','));
  filteredJobs.forEach((j) => {
    lines.push(
      [
        j.id,
        j.subject,
        j.technicianId ? techNameById[j.technicianId] || j.technicianId : '',
        j.status,
        formatDateForExport(j.assignedAt),
        formatDateForExport(j.arrivedAt),
        formatDateForExport(j.completedAt),
      ]
        .map(csvEscape)
        .join(',')
    );
  });

  const csv = lines.join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="supranya-report-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

app.get('/api/tickets', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 15));

  const { jobs, total } = await repo.jobs.search({ q, from: null, to: null, page, pageSize });
  const techNameById = await technicianNameMap();
  const tickets = jobs.map((j) => ({ ...j, technicianName: j.technicianId ? techNameById[j.technicianId] || j.technicianId : null }));

  res.json({ tickets, total, page, pageSize });
});

// Shared by the manual /assign route below and admin job creation.
// Returns both the freshly-assigned job AND the technician re-fetched
// after their status is recomputed — the DB gives back a new plain
// object per query, not a shared mutable reference the way the old
// in-memory arrays did, so a caller holding an earlier technician
// snapshot would otherwise serialize a stale status ("available" instead
// of "on_job") in its response.
async function assignJobToTechnician(jobId, technician) {
  const job = await repo.jobs.assign(jobId, technician.id);
  await repo.technicians.recomputeStatus(technician.id);
  const updatedTechnician = await repo.technicians.getById(technician.id);
  await broadcastState();
  startSimulation(job, updatedTechnician, broadcastState); // begins moving technician toward the job's charger location
  return { job, technician: updatedTechnician };
}

app.post('/api/jobs/:id/assign', requireAuth, async (req, res) => {
  const job = await repo.jobs.getById(req.params.id);
  const technician = await repo.technicians.getById(req.body.technicianId);
  if (!job || !technician) return res.status(404).json({ error: 'Job or technician not found' });

  const { job: assigned, technician: assignedTechnician } = await assignJobToTechnician(job.id, technician);
  res.json({ ok: true, job: assigned, technician: assignedTechnician });
});

// Shared by the admin-authenticated status endpoint below and the
// technician-facing one further down.
async function setJobStatus(job, status) {
  const updated = await repo.jobs.setStatus(job.id, status);
  if (status === 'Completed') stopSimulation(job.id);
  if (job.technicianId) await repo.technicians.recomputeStatus(job.technicianId);
  await broadcastState();
  return updated;
}

app.post('/api/jobs/:id/status', requireAuth, async (req, res) => {
  const job = await repo.jobs.getById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const updated = await setJobStatus(job, req.body.status);
  res.json({ ok: true, job: updated });
});

// Technician-facing status update — public but ownership-checked.
app.post('/api/technicians/:techId/jobs/:jobId/status', async (req, res) => {
  const job = await repo.jobs.getById(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.technicianId !== req.params.techId) {
    return res.status(403).json({ error: 'This job is not assigned to this technician' });
  }
  const { status } = req.body || {};
  if (!['En Route', 'Arrived', 'Completed'].includes(status)) {
    return res.status(400).json({ error: 'status must be En Route, Arrived, or Completed' });
  }
  const updated = await setJobStatus(job, status);
  res.json({ ok: true, job: updated });
});

app.post('/api/alerts/:id/ack', requireAuth, async (req, res) => {
  const acked = await repo.alerts.ack(req.params.id);
  if (!acked) return res.status(404).json({ error: 'Alert not found' });
  await broadcastState();
  res.json({ ok: true });
});

// --- Delay watch -------------------------------------------------------------
// Flags a job — and raises a bell notification — when a technician hasn't
// reached "Arrived" within the SLA window after assignment. Real SLA: 24
// hours. To actually see it fire without waiting 24 real hours, start the
// server with a shorter override, e.g.:
//   DELAY_THRESHOLD_MS=20000 npm start        (20 seconds, PowerShell: $env:DELAY_THRESHOLD_MS=20000; npm start)
const DELAY_THRESHOLD_MS = process.env.DELAY_THRESHOLD_MS
  ? Number(process.env.DELAY_THRESHOLD_MS)
  : 24 * 60 * 60 * 1000; // 24 hours — the real SLA

setInterval(async () => {
  try {
    const overdue = await repo.jobs.findOverdue(DELAY_THRESHOLD_MS);
    if (!overdue.length) return;

    for (const job of overdue) {
      await repo.jobs.setDelayAlerted(job.id);
      const technician = job.technicianId ? await repo.technicians.getById(job.technicianId) : null;
      await repo.alerts.create({
        id: `alert-${job.id}-${Date.now()}`,
        jobId: job.id,
        technicianName: technician ? technician.name : 'Unknown technician',
        message: `${technician ? technician.name : 'Technician'} hasn't reached ${job.chargerNickname} yet for ${job.id} (${job.subject}).`,
      });
    }
    await broadcastState();
  } catch (err) {
    console.error('Delay watch tick failed:', err);
  }
}, 3000);

// Socket payload deliberately omits `customers` — the dashboard's own
// socket handler never reads it (it re-fetches customers over REST
// whenever that tab is active), and including it here would mean a
// devices+addresses join for every customer on every single broadcast,
// which fires on every job/technician/attendance/leave change and every
// 2 seconds during a live simulation tick.
async function broadcastState() {
  const [jobs, technicians, alerts] = await Promise.all([repo.jobs.list(), repo.technicians.list(), repo.alerts.list()]);
  io.emit('state', { jobs, technicians, alerts });
}

io.on('connection', async (socket) => {
  const [jobs, technicians, alerts] = await Promise.all([repo.jobs.list(), repo.technicians.list(), repo.alerts.list()]);
  socket.emit('state', { jobs, technicians, alerts });
});

// --- Static admin frontend ---------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Supranya admin backend running at http://localhost:${PORT}`);
  console.log('Login with the admin account set up via db/seed-admin.js.');
});
