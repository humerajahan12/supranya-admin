'use strict';

// Demo/seed data — the Postgres equivalent of the old store.js's
// SEED_DEMO_DATA block. Run it once against an EMPTY database (it does
// not check for existing rows first) when you want something to demo —
// pagination/search/reports at scale, a few fictional technicians and
// tickets to click around:
//   node db/seed-demo.js
//
// Not run automatically and not part of db:migrate — real day-to-day use
// should only ever show technicians you actually onboarded and tickets
// real customers actually raised, never fictional ones mixed in. If you
// want to reset a demo database and reseed, truncate first:
//   TRUNCATE attendance, leave_requests, alerts, jobs, addresses, devices, customers, technicians RESTART IDENTITY CASCADE;
require('dotenv').config();
const { pool } = require('./index');
const repo = require('./repo');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();

const seededPick = (arr, seed) => {
  const h = (seed * 2654435761) >>> 0;
  return arr[h % arr.length];
};
const jitter = (base, seed, spread = 0.03) => base + (((seed * 9301 + 49297) % 233280) / 233280 - 0.5) * spread;

async function main() {
  console.log('Seeding demo data...');

  const technicians = await Promise.all([
    repo.technicians.create({ id: 'tech-1', name: 'Ravi Kumar', phone: '+919000000001', vehicle: 'Bike · TS 09 EQ 4821', latitude: 17.4156, longitude: 78.4347 }),
    repo.technicians.create({ id: 'tech-2', name: 'Suresh Naik', phone: '+919000000002', vehicle: 'Bike · TS 07 FQ 1190', latitude: 17.401, longitude: 78.4867 }),
    repo.technicians.create({ id: 'tech-3', name: 'Mahesh Reddy', phone: '+919000000003', vehicle: 'Bike · TS 08 GT 3305', latitude: 17.385, longitude: 78.4867 }),
  ]);
  console.log(`- ${technicians.length} technicians`);

  const seedCustomer = await repo.customers.create({ id: 'cust-seed-1', name: 'Aslam', phone: '+919000000000' });
  await repo.devices.add(seedCustomer.id, { id: 'dev-seed-1', name: 'Home · Jubilee Hills', brand: 'Delta', power: '7.4kW AC', latitude: 17.4326, longitude: 78.4071 });
  await repo.devices.add(seedCustomer.id, { id: 'dev-seed-2', name: 'Office · HITEC City', brand: 'Exicom', power: '30kW DC', latitude: 17.4483, longitude: 78.3915 });
  await repo.addresses.add(seedCustomer.id, { id: 'addr-seed-1', label: 'Home', line: 'Plot 14, Road No. 3, Jubilee Hills, Hyderabad 500033', latitude: 17.4326, longitude: 78.4071, isDefault: true });

  // --- Bulk-generated customers -------------------------------------------
  const FIRST_NAMES = ['Aarav', 'Vivaan', 'Aditya', 'Ishaan', 'Kabir', 'Rohan', 'Ananya', 'Diya', 'Saanvi', 'Meera', 'Kavya', 'Neha', 'Rahul', 'Sanjay', 'Vikram', 'Pooja', 'Anjali', 'Deepak', 'Lakshmi', 'Ramesh'];
  const LAST_NAMES = ['Reddy', 'Rao', 'Sharma', 'Iyer', 'Nair', 'Gupta', 'Menon', 'Naidu', 'Verma', 'Kumar', 'Chowdary', 'Prasad', 'Pillai', 'Shetty', 'Desai'];
  const AREAS = [
    ['Jubilee Hills', 17.4326, 78.4071], ['HITEC City', 17.4483, 78.3915], ['Banjara Hills', 17.4126, 78.4479],
    ['Gachibowli', 17.4401, 78.3489], ['Kondapur', 17.4644, 78.3638], ['Madhapur', 17.4483, 78.3915],
    ['Secunderabad', 17.4399, 78.4983], ['Kukatpally', 17.4849, 78.4108], ['Begumpet', 17.4444, 78.4682],
    ['Manikonda', 17.4058, 78.3856],
  ];
  const DEVICE_TIERS = [
    { brand: 'Delta', power: '7.4kW AC' },
    { brand: 'Exicom', power: '22kW AC' },
    { brand: 'Exicom', power: '30kW DC' },
    { brand: 'ABB', power: '24kW DC' },
  ];

  const GENERATED_CUSTOMER_COUNT = 120;
  const generatedCustomers = [];
  for (let i = 0; i < GENERATED_CUSTOMER_COUNT; i++) {
    const name = `${seededPick(FIRST_NAMES, i)} ${seededPick(LAST_NAMES, i * 3 + 1)}`;
    const phone = `+9198${String(10000000 + i * 137).slice(0, 8)}`;
    const status = i % 5 === 0 ? 'inactive' : 'active';
    const customer = await repo.customers.create({ id: `cust-gen-${i}`, name, phone });
    if (status === 'inactive') await repo.customers.setStatus(customer.id, 'inactive');

    const deviceCount = i % 7 === 0 ? 0 : (i % 3 === 0 ? 2 : 1);
    const devices = [];
    for (let d = 0; d < deviceCount; d++) {
      const areaSeed = i * 5 + d;
      const [areaName, lat, lng] = seededPick(AREAS, areaSeed);
      const tier = seededPick(DEVICE_TIERS, areaSeed + d);
      const device = await repo.devices.add(customer.id, {
        id: `dev-gen-${i}-${d}`,
        name: `${d === 0 ? 'Home' : 'Office'} · ${areaName}`,
        brand: tier.brand,
        power: tier.power,
        latitude: jitter(lat, areaSeed),
        longitude: jitter(lng, areaSeed + 100),
      });
      devices.push(device);
    }
    generatedCustomers.push({ id: customer.id, name, phone, devices });
  }
  console.log(`- ${GENERATED_CUSTOMER_COUNT} generated customers`);

  // --- Jobs (a few real-looking ones + a bulk-generated completed history)
  const jobsToCreate = [
    { id: 'TKT-4821', subject: 'Buzzing sound', serviceName: 'Fault Diagnosis & Repair', customerId: seedCustomer.id, customerName: 'Aslam', customerPhone: '+919000000000', chargerNickname: 'Home · Jubilee Hills', latitude: 17.4326, longitude: 78.4071 },
    { id: 'TKT-4790', subject: 'Requested annual service', serviceName: 'Annual Maintenance', customerId: seedCustomer.id, customerName: 'Aslam', customerPhone: '+919000000000', chargerNickname: 'Office · HITEC City', latitude: 17.4483, longitude: 78.3915 },
  ];
  for (const j of jobsToCreate) await repo.jobs.create(j);

  const SUBJECTS = ['Buzzing sound', 'No power to unit', 'Connector replacement', 'Annual service', 'Tripped breaker', 'Slow charging', 'Display not working', 'Cable damaged'];
  const SERVICE_NAMES = ['Fault Diagnosis & Repair', 'Annual Maintenance'];
  const GENERATED_JOB_COUNT = 60;
  let jobCount = 0;
  for (let i = 0; i < GENERATED_JOB_COUNT; i++) {
    const customer = seededPick(generatedCustomers, i * 2 + 5);
    const device = customer.devices[0];
    if (!device) continue;
    const technician = seededPick(technicians, i);
    const daysAgo = 1 + (i % 100);
    const assignedAt = now - daysAgo * DAY;
    const canBeDelayed = daysAgo >= 3;
    const isDelayed = canBeDelayed && i % 6 === 0;
    const responseMinutes = isDelayed ? (25 + (i % 20)) * 60 : 10 + (i % 25);
    const arrivedAt = assignedAt + responseMinutes * 60 * 1000;
    const completedAt = assignedAt + (responseMinutes + 25) * 60 * 1000;

    await pool.query(
      `INSERT INTO jobs (id, subject, service_name, customer_id, customer_name, customer_phone, charger_nickname,
         latitude, longitude, status, technician_id, assigned_at, arrived_at, completed_at, delay_alerted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Completed',$10,$11,$12,$13,$14)`,
      [
        `TKT-${3000 + i}`, seededPick(SUBJECTS, i), seededPick(SERVICE_NAMES, i), customer.id, customer.name, customer.phone,
        device.name, device.latitude, device.longitude, technician.id,
        new Date(assignedAt), new Date(arrivedAt), new Date(completedAt), isDelayed,
      ]
    );
    jobCount++;
  }
  console.log(`- ${jobsToCreate.length + jobCount} jobs`);

  // --- Attendance: ~30 days of history for the 3 seeded technicians ------
  let attCount = 0;
  for (let d = 1; d <= 30; d++) {
    const dayStart = new Date(now - d * DAY);
    const dow = dayStart.getDay();
    if (dow === 0) continue; // Sundays — nobody's clocked in
    for (let ti = 0; ti < technicians.length; ti++) {
      if ((d + ti) % 7 === 0) continue; // the occasional day off, staggered per technician
      const checkInAt = new Date(dayStart);
      checkInAt.setHours(9 + (ti % 2), ti * 5, 0, 0);
      await pool.query(
        `INSERT INTO attendance (id, technician_id, check_in_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [`att-seed-${technicians[ti].id}-${d}`, technicians[ti].id, checkInAt]
      );
      attCount++;
    }
  }
  console.log(`- ${attCount} attendance records`);

  // --- A couple of demo leave requests -------------------------------------
  const dateStr = (daysFromNow) => new Date(now + daysFromNow * DAY).toISOString().slice(0, 10);
  await repo.leave.create({ id: 'leave-seed-1', technicianId: technicians[0].id, fromDate: dateStr(-18), toDate: dateStr(-17), reason: 'Family function' });
  await repo.leave.decide('leave-seed-1', 'approved');
  await repo.leave.create({ id: 'leave-seed-2', technicianId: technicians[1].id, fromDate: dateStr(3), toDate: dateStr(4), reason: 'Personal work' });
  console.log('- 2 leave requests');

  console.log('Done.');
  await pool.end();
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
