'use strict';

// Data-access layer — every query server.js needs, grouped by entity.
// Each function returns plain JS objects shaped exactly like the old
// in-memory records from store.js (same field names, timestamps as
// epoch-millisecond numbers rather than SQL timestamps), so server.js's
// route handlers only need `await` added, not their response shapes
// rewritten, and the mobile app / dashboard don't need to change at all.
const { pool } = require('./index');

// --- mapping helpers: DB row (snake_case, Date objects) -> API shape
// (camelCase, epoch-ms numbers) -------------------------------------------
const ms = (d) => (d ? new Date(d).getTime() : null);

function mapTechnician(r) {
  if (!r) return null;
  const t = {
    id: r.id,
    name: r.name,
    phone: r.phone,
    vehicle: r.vehicle,
    status: r.status,
    latitude: r.latitude,
    longitude: r.longitude,
  };
  if (r.heading != null) t.heading = r.heading;
  return t;
}

function mapDevice(r) {
  return {
    id: r.id,
    name: r.name,
    model: r.model,
    brand: r.brand,
    power: r.power,
    latitude: r.latitude,
    longitude: r.longitude,
    registeredAt: ms(r.registered_at),
  };
}

function mapAddress(r) {
  return {
    id: r.id,
    label: r.label,
    line: r.line,
    latitude: r.latitude,
    longitude: r.longitude,
    isDefault: r.is_default,
  };
}

function mapCustomer(r, devices = [], addresses = []) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    status: r.status,
    registeredAt: ms(r.registered_at),
    devices: devices.map(mapDevice),
    addresses: addresses.map(mapAddress),
  };
}

function mapJob(r) {
  if (!r) return null;
  return {
    id: r.id,
    subject: r.subject,
    serviceName: r.service_name,
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    chargerNickname: r.charger_nickname,
    latitude: r.latitude,
    longitude: r.longitude,
    status: r.status,
    technicianId: r.technician_id,
    assignedAt: ms(r.assigned_at),
    arrivedAt: ms(r.arrived_at),
    completedAt: ms(r.completed_at),
    delayAlerted: r.delay_alerted,
    routePath: r.route_path || undefined,
  };
}

function mapAttendance(r) {
  const a = { id: r.id, technicianId: r.technician_id, checkInAt: ms(r.check_in_at) };
  if (r.marked_by_admin) a.markedByAdmin = true;
  return a;
}

function mapLeave(r) {
  return {
    id: r.id,
    technicianId: r.technician_id,
    fromDate: r.from_date,
    toDate: r.to_date,
    reason: r.reason,
    status: r.status,
    requestedAt: ms(r.requested_at),
    decidedAt: ms(r.decided_at),
  };
}

function mapAlert(r) {
  return {
    id: r.id,
    jobId: r.job_id,
    technicianName: r.technician_name,
    message: r.message,
    createdAt: ms(r.created_at),
    acknowledged: r.acknowledged,
  };
}

// --- technicians -----------------------------------------------------------
const technicians = {
  async list() {
    const { rows } = await pool.query('SELECT * FROM technicians ORDER BY name');
    return rows.map(mapTechnician);
  },
  async getById(id) {
    const { rows } = await pool.query('SELECT * FROM technicians WHERE id = $1', [id]);
    return mapTechnician(rows[0]);
  },
  async getByPhone(phone) {
    const { rows } = await pool.query('SELECT * FROM technicians WHERE phone = $1', [phone]);
    return mapTechnician(rows[0]);
  },
  async create({ id, name, phone, vehicle, latitude, longitude }) {
    const { rows } = await pool.query(
      `INSERT INTO technicians (id, name, phone, vehicle, status, latitude, longitude)
       VALUES ($1, $2, $3, $4, 'available', $5, $6) RETURNING *`,
      [id, name, phone, vehicle, latitude, longitude]
    );
    return mapTechnician(rows[0]);
  },
  async update(id, fields) {
    const sets = [];
    const params = [];
    let i = 1;
    for (const [col, val] of Object.entries(fields)) {
      sets.push(`${col} = $${i++}`);
      params.push(val);
    }
    if (!sets.length) return technicians.getById(id);
    params.push(id);
    const { rows } = await pool.query(`UPDATE technicians SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params);
    return mapTechnician(rows[0]);
  },
  async remove(id) {
    await pool.query('DELETE FROM technicians WHERE id = $1', [id]);
  },
  // Derives available/on_job from the jobs table itself — same rule as the
  // original recomputeTechnicianStatus, now a single UPDATE instead of an
  // in-memory scan.
  async recomputeStatus(id) {
    await pool.query(
      `UPDATE technicians SET status = CASE
         WHEN EXISTS (SELECT 1 FROM jobs WHERE technician_id = $1 AND status <> 'Completed')
         THEN 'on_job' ELSE 'available' END
       WHERE id = $1`,
      [id]
    );
  },
  async setPosition(id, { latitude, longitude, heading }) {
    await pool.query('UPDATE technicians SET latitude = $1, longitude = $2, heading = $3 WHERE id = $4', [
      latitude,
      longitude,
      heading,
      id,
    ]);
  },
  async hasActiveJob(id) {
    const { rows } = await pool.query(`SELECT 1 FROM jobs WHERE technician_id = $1 AND status <> 'Completed' LIMIT 1`, [id]);
    return rows.length > 0;
  },
};

// --- customers ---------------------------------------------------------
async function loadDevicesAndAddresses(customerId) {
  const [devicesRes, addressesRes] = await Promise.all([
    pool.query('SELECT * FROM devices WHERE customer_id = $1 ORDER BY registered_at', [customerId]),
    pool.query('SELECT * FROM addresses WHERE customer_id = $1 ORDER BY is_default DESC', [customerId]),
  ]);
  return { devices: devicesRes.rows, addresses: addressesRes.rows };
}

const customers = {
  async getById(id) {
    const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
    if (!rows[0]) return null;
    const { devices, addresses } = await loadDevicesAndAddresses(id);
    return mapCustomer(rows[0], devices, addresses);
  },
  async getByPhone(phone) {
    const { rows } = await pool.query('SELECT * FROM customers WHERE phone = $1', [phone]);
    if (!rows[0]) return null;
    const { devices, addresses } = await loadDevicesAndAddresses(rows[0].id);
    return mapCustomer(rows[0], devices, addresses);
  },
  async create({ id, name, phone }) {
    const { rows } = await pool.query(
      `INSERT INTO customers (id, name, phone, status, registered_at) VALUES ($1, $2, $3, 'active', now()) RETURNING *`,
      [id, name, phone]
    );
    return mapCustomer(rows[0], [], []);
  },
  async setName(id, name) {
    await pool.query('UPDATE customers SET name = $1 WHERE id = $2', [name, id]);
  },
  async search({ q, page, pageSize }) {
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE lower(name) LIKE lower($${params.length}) OR lower(phone) LIKE lower($${params.length})`;
    }
    const totalRes = await pool.query(`SELECT count(*)::int AS total FROM customers ${where}`, params);
    const total = totalRes.rows[0].total;

    params.push(pageSize, (page - 1) * pageSize);
    const { rows } = await pool.query(
      `SELECT * FROM customers ${where} ORDER BY registered_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const withRelations = await Promise.all(
      rows.map(async (r) => {
        const { devices, addresses } = await loadDevicesAndAddresses(r.id);
        return mapCustomer(r, devices, addresses);
      })
    );
    return { customers: withRelations, total };
  },
  async updateNameOrPhone(id, { name, phone }) {
    const sets = [];
    const params = [];
    let i = 1;
    if (name != null) { sets.push(`name = $${i++}`); params.push(name); }
    if (phone != null) { sets.push(`phone = $${i++}`); params.push(phone); }
    if (!sets.length) return customers.getById(id);
    params.push(id);
    await pool.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = $${i}`, params);
    return customers.getById(id);
  },
  async setStatus(id, status) {
    await pool.query('UPDATE customers SET status = $1 WHERE id = $2', [status, id]);
    return customers.getById(id);
  },
  async remove(id) {
    await pool.query('DELETE FROM customers WHERE id = $1', [id]);
  },
  async hasOpenTicket(id, phone) {
    const { rows } = await pool.query(
      `SELECT id, status FROM jobs WHERE (customer_id = $1 OR customer_phone = $2) AND status <> 'Completed' LIMIT 1`,
      [id, phone]
    );
    return rows[0] || null;
  },
};

const devices = {
  async add(customerId, { id, name, model, brand, power, latitude, longitude }) {
    const { rows } = await pool.query(
      `INSERT INTO devices (id, customer_id, name, model, brand, power, latitude, longitude, registered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING *`,
      [id, customerId, name, model || '', brand || '', power || '', latitude, longitude]
    );
    return mapDevice(rows[0]);
  },
  async getById(customerId, deviceId) {
    const { rows } = await pool.query('SELECT * FROM devices WHERE id = $1 AND customer_id = $2', [deviceId, customerId]);
    return rows[0] ? mapDevice(rows[0]) : null;
  },
  async setLocation(deviceId, latitude, longitude) {
    const { rows } = await pool.query('UPDATE devices SET latitude = $1, longitude = $2 WHERE id = $3 RETURNING *', [
      latitude,
      longitude,
      deviceId,
    ]);
    return mapDevice(rows[0]);
  },
};

const addresses = {
  async add(customerId, { id, label, line, latitude, longitude, isDefault }) {
    if (isDefault) {
      await pool.query('UPDATE addresses SET is_default = false WHERE customer_id = $1', [customerId]);
    }
    const { rows } = await pool.query(
      `INSERT INTO addresses (id, customer_id, label, line, latitude, longitude, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, customerId, label, line, latitude, longitude, isDefault]
    );
    return mapAddress(rows[0]);
  },
  async countForCustomer(customerId) {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM addresses WHERE customer_id = $1', [customerId]);
    return rows[0].n;
  },
};

// --- jobs ----------------------------------------------------------------
const JOB_COLUMNS = `id, subject, service_name, customer_id, customer_name, customer_phone, charger_nickname,
  latitude, longitude, status, technician_id, assigned_at, arrived_at, completed_at, delay_alerted, route_path`;

// Work that needs attention comes first: Unassigned, then Assigned, En Route,
// Arrived, and Completed last. Within a group the newest comes first.
// Unassigned jobs have no assigned_at yet (that's what the old
// "assigned_at DESC NULLS LAST" pushed to the bottom), so the final id DESC
// tiebreak orders them newest-first — job ids are TKT-<creation time in ms>.
const JOB_ORDER = `ORDER BY CASE status
    WHEN 'Unassigned' THEN 0 WHEN 'Assigned' THEN 1 WHEN 'En Route' THEN 2 WHEN 'Arrived' THEN 3 ELSE 4 END,
  assigned_at DESC NULLS LAST, id DESC`;

// One page of jobs for a where-clause, plus the total and how many of them
// are still active (anything not Completed) — used by the mobile app lists.
async function pagedJobs(where, params, page, pageSize) {
  const totals = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status <> 'Completed')::int AS active FROM jobs ${where}`,
    params
  );
  const { rows } = await pool.query(
    `SELECT ${JOB_COLUMNS} FROM jobs ${where} ${JOB_ORDER} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, (page - 1) * pageSize]
  );
  return { jobs: rows.map(mapJob), total: totals.rows[0].total, active: totals.rows[0].active };
}

const jobs = {
  async list() {
    const { rows } = await pool.query(`SELECT ${JOB_COLUMNS} FROM jobs ${JOB_ORDER}`);
    return rows.map(mapJob);
  },
  async getById(id) {
    const { rows } = await pool.query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`, [id]);
    return mapJob(rows[0]);
  },
  async listByTechnician(technicianId) {
    const { rows } = await pool.query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE technician_id = $1 ${JOB_ORDER}`, [
      technicianId,
    ]);
    return rows.map(mapJob);
  },
  async listByTechnicianPaged(technicianId, page, pageSize) {
    return pagedJobs('WHERE technician_id = $1', [technicianId], page, pageSize);
  },
  async listByCustomer(customerId, customerPhone) {
    const { rows } = await pool.query(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE customer_id = $1 OR customer_phone = $2 ${JOB_ORDER}`,
      [customerId, customerPhone]
    );
    return rows.map(mapJob);
  },
  async listByCustomerPaged(customerId, customerPhone, page, pageSize) {
    return pagedJobs('WHERE customer_id = $1 OR customer_phone = $2', [customerId, customerPhone], page, pageSize);
  },
  async create({ id, subject, serviceName, customerId, customerName, customerPhone, chargerNickname, latitude, longitude }) {
    const { rows } = await pool.query(
      `INSERT INTO jobs (id, subject, service_name, customer_id, customer_name, customer_phone, charger_nickname, latitude, longitude, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Unassigned') RETURNING ${JOB_COLUMNS}`,
      [id, subject, serviceName, customerId || null, customerName, customerPhone, chargerNickname, latitude, longitude]
    );
    return mapJob(rows[0]);
  },
  async assign(jobId, technicianId) {
    const { rows } = await pool.query(
      `UPDATE jobs SET technician_id = $1, status = 'Assigned', assigned_at = now(), delay_alerted = false
       WHERE id = $2 RETURNING ${JOB_COLUMNS}`,
      [technicianId, jobId]
    );
    return mapJob(rows[0]);
  },
  async setRoutePathAndEnRoute(jobId, routePath) {
    await pool.query(`UPDATE jobs SET route_path = $1, status = 'En Route' WHERE id = $2`, [JSON.stringify(routePath), jobId]);
  },
  async setStatus(jobId, status) {
    if (status === 'Completed') {
      const { rows } = await pool.query(
        `UPDATE jobs SET status = $1, completed_at = now() WHERE id = $2 RETURNING ${JOB_COLUMNS}`,
        [status, jobId]
      );
      return mapJob(rows[0]);
    }
    const { rows } = await pool.query(`UPDATE jobs SET status = $1 WHERE id = $2 RETURNING ${JOB_COLUMNS}`, [status, jobId]);
    return mapJob(rows[0]);
  },
  async setArrived(jobId) {
    await pool.query(`UPDATE jobs SET status = 'Arrived', arrived_at = now() WHERE id = $1`, [jobId]);
  },
  async setDelayAlerted(jobId) {
    await pool.query('UPDATE jobs SET delay_alerted = true WHERE id = $1', [jobId]);
  },
  // Jobs that are still Assigned/En Route, assigned more than thresholdMs
  // ago, and haven't already raised a delay alert — for the delay-watch
  // interval in server.js.
  async findOverdue(thresholdMs) {
    const { rows } = await pool.query(
      `SELECT ${JOB_COLUMNS} FROM jobs
       WHERE status IN ('Assigned', 'En Route') AND delay_alerted = false AND assigned_at IS NOT NULL
         AND assigned_at < now() - ($1 || ' milliseconds')::interval`,
      [thresholdMs]
    );
    return rows.map(mapJob);
  },
  async search({ q, from, to, page, pageSize }) {
    const params = [];
    const clauses = [];
    if (from) { params.push(new Date(from)); clauses.push(`assigned_at >= $${params.length}`); }
    if (to) { params.push(new Date(to)); clauses.push(`assigned_at <= $${params.length}`); }
    if (q) { params.push(`%${q}%`); clauses.push(`(lower(id) LIKE lower($${params.length}) OR lower(subject) LIKE lower($${params.length}) OR lower(customer_name) LIKE lower($${params.length}) OR lower(customer_phone) LIKE lower($${params.length}))`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const totalRes = await pool.query(`SELECT count(*)::int AS total FROM jobs ${where}`, params);
    const total = totalRes.rows[0].total;

    params.push(pageSize, (page - 1) * pageSize);
    const { rows } = await pool.query(
      `SELECT ${JOB_COLUMNS} FROM jobs ${where} ${JOB_ORDER} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { jobs: rows.map(mapJob), total };
  },
  // Every job in a date range, unpaged — used by the report aggregations
  // below, which need the full matching set to compute sums/averages, not
  // a page of it.
  async listByDateRange(from, to) {
    const params = [];
    const clauses = [];
    if (from) { params.push(new Date(from)); clauses.push(`assigned_at >= $${params.length}`); }
    if (to) { params.push(new Date(to)); clauses.push(`assigned_at <= $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT ${JOB_COLUMNS} FROM jobs ${where}`, params);
    return rows.map(mapJob);
  },
  async dailyCounts(from, to) {
    const params = [];
    const clauses = ['assigned_at IS NOT NULL'];
    if (from) { params.push(new Date(from)); clauses.push(`assigned_at >= $${params.length}`); }
    if (to) { params.push(new Date(to)); clauses.push(`assigned_at <= $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT to_char(assigned_at, 'YYYY-MM-DD') AS day, count(*)::int AS count
       FROM jobs WHERE ${clauses.join(' AND ')} GROUP BY day ORDER BY day`,
      params
    );
    return rows.map((r) => ({ date: r.day, count: r.count }));
  },
};

// --- attendance ----------------------------------------------------------
const attendance = {
  // Local-calendar-day key, computed the same way server.js's toDateKey
  // does for a JS timestamp — used here only for shaping responses, not
  // for the DB's own day-uniqueness check (that's the schema's generated
  // index, timezone-aware in SQL directly).
  async checkIn({ id, technicianId }) {
    // ON CONFLICT on the schema's one-per-day unique index turns a race
    // between two near-simultaneous check-ins into a clean "already
        // checked in" instead of a duplicate row or a thrown error.
    const { rows } = await pool.query(
      `INSERT INTO attendance (id, technician_id, check_in_at)
       VALUES ($1, $2, now())
       ON CONFLICT (technician_id, ((check_in_at AT TIME ZONE 'Asia/Kolkata')::date)) DO NOTHING
       RETURNING *`,
      [id, technicianId]
    );
    return rows[0] ? mapAttendance(rows[0]) : null; // null means someone already checked in today
  },
  async findToday(technicianId) {
    const { rows } = await pool.query(
      `SELECT * FROM attendance WHERE technician_id = $1
       AND (check_in_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
      [technicianId]
    );
    return rows[0] ? mapAttendance(rows[0]) : null;
  },
  async listByTechnician(technicianId) {
    const { rows } = await pool.query('SELECT * FROM attendance WHERE technician_id = $1 ORDER BY check_in_at DESC', [technicianId]);
    return rows.map(mapAttendance);
  },
  // One row per technician per calendar day in [dateFrom, dateTo] (IST),
  // used by both the day/month summary and the reports below — the
  // per-day status logic (present/absent/leave/weekend/future) still
  // happens in JS in server.js, same as before, just fed from a real
  // query instead of a full-table array scan.
  async findForDateRange(fromDateKey, toDateKey) {
    const { rows } = await pool.query(
      `SELECT *, (check_in_at AT TIME ZONE 'Asia/Kolkata')::date::text AS date_key
       FROM attendance
       WHERE (check_in_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1 AND $2`,
      [fromDateKey, toDateKey]
    );
    return rows.map((r) => ({ ...mapAttendance(r), dateKey: r.date_key }));
  },
  async markByAdmin({ id, technicianId, dateKey }) {
    const { rows } = await pool.query(
      `INSERT INTO attendance (id, technician_id, check_in_at, marked_by_admin)
       VALUES ($1, $2, ($3 || 'T12:00:00+05:30')::timestamptz, true)
       ON CONFLICT (technician_id, ((check_in_at AT TIME ZONE 'Asia/Kolkata')::date)) DO NOTHING
       RETURNING *`,
      [id, technicianId, dateKey]
    );
    return rows[0] ? mapAttendance(rows[0]) : null;
  },
  async findByTechnicianAndDate(technicianId, dateKey) {
    const { rows } = await pool.query(
      `SELECT * FROM attendance WHERE technician_id = $1 AND (check_in_at AT TIME ZONE 'Asia/Kolkata')::date = $2`,
      [technicianId, dateKey]
    );
    return rows[0] ? mapAttendance(rows[0]) : null;
  },
  async remove(id) {
    const { rowCount } = await pool.query('DELETE FROM attendance WHERE id = $1', [id]);
    return rowCount > 0;
  },
  async findInRange(fromMs, toMs) {
    const params = [];
    const clauses = [];
    if (fromMs) { params.push(new Date(fromMs)); clauses.push(`check_in_at >= $${params.length}`); }
    if (toMs) { params.push(new Date(toMs)); clauses.push(`check_in_at <= $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM attendance ${where}`, params);
    return rows.map(mapAttendance);
  },
};

// --- leave requests --------------------------------------------------------
const leave = {
  async create({ id, technicianId, fromDate, toDate, reason }) {
    const { rows } = await pool.query(
      `INSERT INTO leave_requests (id, technician_id, from_date, to_date, reason, status, requested_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', now()) RETURNING *`,
      [id, technicianId, fromDate, toDate, reason]
    );
    return mapLeave(rows[0]);
  },
  async listByTechnician(technicianId) {
    const { rows } = await pool.query('SELECT * FROM leave_requests WHERE technician_id = $1 ORDER BY requested_at DESC', [
      technicianId,
    ]);
    return rows.map(mapLeave);
  },
  async getById(id) {
    const { rows } = await pool.query('SELECT * FROM leave_requests WHERE id = $1', [id]);
    return mapLeave(rows[0]);
  },
  async remove(id) {
    await pool.query('DELETE FROM leave_requests WHERE id = $1', [id]);
  },
  async decide(id, status) {
    const { rows } = await pool.query(
      `UPDATE leave_requests SET status = $1, decided_at = now() WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return mapLeave(rows[0]);
  },
  // Approved/pending leave covering a specific day — used by dayStatusFor.
  async findCovering(technicianId, dateKey) {
    const { rows } = await pool.query(
      `SELECT * FROM leave_requests WHERE technician_id = $1 AND status <> 'rejected' AND $2 BETWEEN from_date AND to_date
       ORDER BY status LIMIT 1`,
      [technicianId, dateKey]
    );
    return rows[0] ? mapLeave(rows[0]) : null;
  },
  async search({ q, status, page, pageSize }) {
    const params = [];
    const clauses = [];
    if (status) { params.push(status); clauses.push(`l.status = $${params.length}`); }
    if (q) { params.push(`%${q}%`); clauses.push(`lower(t.name) LIKE lower($${params.length})`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const totalRes = await pool.query(
      `SELECT count(*)::int AS total FROM leave_requests l JOIN technicians t ON t.id = l.technician_id ${where}`,
      params
    );
    const total = totalRes.rows[0].total;

    params.push(pageSize, (page - 1) * pageSize);
    const { rows } = await pool.query(
      `SELECT l.*, t.name AS technician_name FROM leave_requests l JOIN technicians t ON t.id = l.technician_id
       ${where}
       ORDER BY CASE l.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, l.requested_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { leave: rows.map((r) => ({ ...mapLeave(r), technicianName: r.technician_name })), total };
  },
};

// --- alerts ----------------------------------------------------------------
const alerts = {
  async list() {
    const { rows } = await pool.query('SELECT * FROM alerts ORDER BY created_at DESC');
    return rows.map(mapAlert);
  },
  async create({ id, jobId, technicianName, message }) {
    const { rows } = await pool.query(
      `INSERT INTO alerts (id, job_id, technician_name, message, created_at, acknowledged)
       VALUES ($1, $2, $3, $4, now(), false) RETURNING *`,
      [id, jobId, technicianName, message]
    );
    return mapAlert(rows[0]);
  },
  async ack(id) {
    const { rows } = await pool.query('UPDATE alerts SET acknowledged = true WHERE id = $1 RETURNING *', [id]);
    return rows[0] ? mapAlert(rows[0]) : null;
  },
};

// --- admin user ------------------------------------------------------------
const adminUsers = {
  async findByUsername(username) {
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);
    return rows[0] || null; // raw row on purpose — server.js compares password_hash directly
  },
};

module.exports = { technicians, customers, devices, addresses, jobs, attendance, leave, alerts, adminUsers };
