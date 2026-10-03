// Used to fake the technician's movement with a timer-driven walk along a
// route — that's gone now. The technician's own phone reports its real
// position (see POST /api/technicians/:id/location in server.js, and
// src/screens/technician/*.js's location watcher in the mobile app), so
// this file now only does the one honest thing left to do here: compute
// the road route for the map line, and flip the job to "En Route". It no
// longer moves anyone or decides on its own that a technician has
// "arrived" — that's a real status the technician marks from their own
// app once they're actually there.
'use strict';

const { fetchRoadRoute } = require('./routing');
const repo = require('../db/repo');

// Called once, right when a job is assigned to a technician. Computes a
// real road route from the technician's last known position to the job's
// location purely so the admin dashboard and the mobile app's tracking
// screen have a line to draw — the technician's live position itself now
// comes from their phone, independently of this.
async function startRoute(job, technician, onUpdate) {
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
  onUpdate();
}

module.exports = { startRoute };
