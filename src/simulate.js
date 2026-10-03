// Stands in for the real technician mobile app periodically POSTing its
// live GPS to a /api/technicians/:id/location-style endpoint. Wire that up
// for real once the technician app exists, and delete this whole file —
// the admin dashboard's map code doesn't need to change, since it just
// reacts to socket "state" events regardless of where they came from.
//
// Postgres-backed version: works off job/technician IDs and writes
// through to the database on every tick, instead of mutating shared
// in-memory objects. Real technician counts for this business are small
// (a handful to a few dozen at once, not thousands), so a write every 2
// seconds per currently-"en route" job is negligible load on Postgres —
// nowhere near worth adding a batching/debounce layer for.
'use strict';

const { fetchRoadRoute, pointAlongPath } = require('./routing');
const repo = require('../db/repo');

const TOTAL_STEPS = 24;
const TICK_MS = 2000;

const running = new Map(); // jobId -> intervalId
// A technician can have more than one active job at once. Only ONE
// simulation may actually move that technician's shared position at a
// time, or two intervals would fight over the same marker every tick.
// Tracks which job currently "drives" each technician's dot.
const drivingTechnician = new Map(); // technicianId -> jobId

async function startSimulation(job, technician, onUpdate) {
  stopSimulation(job.id);

  const startLat = technician.latitude;
  const startLng = technician.longitude;

  // Flip to "en route" immediately for responsive UI feedback — the actual
  // road route takes a moment to fetch, same as the brief "finding a route"
  // pause you see in Ola/Uber right after a driver is assigned.
  await repo.jobs.setStatus(job.id, 'En Route');
  onUpdate();

  const roadPath = await fetchRoadRoute(startLat, startLng, job.latitude, job.longitude);
  // Straight line is the fallback if OSRM is unreachable or finds no route
  // — tracking still works, it just won't hug actual roads.
  const routePath = roadPath || [
    [startLat, startLng],
    [job.latitude, job.longitude],
  ];
  await repo.jobs.setRoutePathAndEnRoute(job.id, routePath);

  // If this technician already has another active job driving their
  // marker, this job still gets a real route (so its own tracking-modal
  // polyline is correct) and still progresses to Arrived on the same
  // timer — it just doesn't also move the shared dot while someone else's
  // simulation already is.
  const isDriving = !drivingTechnician.has(technician.id);
  if (isDriving) drivingTechnician.set(technician.id, job.id);

  let step = 0;
  const interval = setInterval(async () => {
    step += 1;
    const progress = Math.min(step / TOTAL_STEPS, 1);

    if (isDriving) {
      const point = pointAlongPath(routePath, progress);
      await repo.technicians.setPosition(technician.id, {
        latitude: point.latitude,
        longitude: point.longitude,
        heading: point.heading,
      });
    }

    if (progress >= 1) {
      await repo.jobs.setArrived(job.id); // sets status='Arrived' and arrivedAt=now(), used for the response-time metric in /api/reports
      clearInterval(interval);
      running.delete(job.id);
      if (isDriving && drivingTechnician.get(technician.id) === job.id) {
        drivingTechnician.delete(technician.id);
      }
    }
    onUpdate();
  }, TICK_MS);

  running.set(job.id, interval);
}

function stopSimulation(jobId) {
  const interval = running.get(jobId);
  if (interval) {
    clearInterval(interval);
    running.delete(jobId);
  }
  for (const [techId, drivingJobId] of drivingTechnician.entries()) {
    if (drivingJobId === jobId) drivingTechnician.delete(techId);
  }
}

module.exports = { startSimulation, stopSimulation };
