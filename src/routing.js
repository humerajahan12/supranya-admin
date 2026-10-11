'use strict';

// Real road-following routes via OSRM's free public demo server — no API
// key needed. This is a shared community server, not something to hammer
// in production: for real use, self-host OSRM (or swap in Google/Mapbox
// Directions) rather than pointing production traffic at this URL.
const OSRM_BASE_URL = process.env.OSRM_BASE_URL || 'https://router.project-osrm.org';

// Free geocoding (type-to-search-a-location, Uber/Ola style) via OSM's
// Nominatim — also no API key, same reasoning as OSRM above: it's a shared
// community server with a usage policy (one request at a time, a real
// User-Agent identifying the app, results not cached/resold) — fine for
// this admin's own low-volume internal use, not for production-scale
// traffic. Self-host Nominatim or swap in Google/Mapbox Geocoding for that.
const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';

async function geocodeSearchRaw(query) {
  try {
    // Soft bias toward Hyderabad (viewbox + bounded=0 means "prefer results
    // in this box, don't exclude everything outside it") — without this, a
    // search like "langar house" can match a same-named place anywhere in
    // the world (confirmed: it matched a village in the UK) instead of the
    // actual Hyderabad locality "Langar Houz" this fleet operates near.
    const HYDERABAD_VIEWBOX = '78.20,17.60,78.65,17.20'; // left,top,right,bottom
    const url = `${NOMINATIM_BASE_URL}/search?q=${encodeURIComponent(query)}&format=json&limit=5&viewbox=${HYDERABAD_VIEWBOX}&bounded=0`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'supranya-admin/1.0 (internal dispatch tool)' }, // Nominatim's usage policy requires a real identifying User-Agent
    });
    if (!res.ok) {
      console.warn(`Nominatim geocoding returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.map((r) => ({ label: r.display_name, latitude: Number(r.lat), longitude: Number(r.lon) }));
  } catch (err) {
    console.warn('Geocoding failed:', err.message);
    return [];
  }
}

// Fetches a driving route between two points. Returns an array of
// [latitude, longitude] points following actual roads, or null if the
// request fails for any reason (network down, no route found, OSRM
// unreachable) — callers should fall back to a straight line rather than
// treating null as an error, since a route not being available shouldn't
// break tracking, only make it less road-accurate.
async function fetchRoadRoute(startLat, startLng, endLat, endLng) {
  try {
    const url = `${OSRM_BASE_URL}/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      console.warn(`OSRM routing returned ${res.status}, falling back to straight line`);
      return null;
    }
    const data = await res.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    // OSRM returns [lng, lat] pairs — flip to [lat, lng] to match every
    // other coordinate in this codebase (and Leaflet's own convention).
    return coords.map(([lng, lat]) => [lat, lng]);
  } catch (err) {
    console.warn('OSRM routing failed, falling back to straight line:', err.message);
    return null;
  }
}

// --- Politeness layer for the free public Nominatim server ------------------
// Its usage policy: max ~1 request/second, no hammering, identify yourself.
// So every lookup goes through ONE queue spaced >= 1.1s apart, identical
// queries are answered from a 24h cache (customers searching the same
// landmark cost nothing), and if the queue backs up we answer "busy" rather
// than pile on. Swap NOMINATIM_BASE_URL for your own server and this still
// works; it just becomes unnecessary.
const GEO_MIN_GAP_MS = 1100;
const GEO_MAX_QUEUE = 15;
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GEO_CACHE_MAX = 1000;
const geoCache = new Map();
let geoChain = Promise.resolve();
let geoPending = 0;
let geoLastAt = 0;
const geoInFlight = new Map(); // identical simultaneous searches share one lookup

async function geocodeSearch(query) {
  const key = String(query || '').trim().toLowerCase();
  if (!key) return [];
  const hit = geoCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;

  if (geoInFlight.has(key)) return geoInFlight.get(key);
  if (geoPending >= GEO_MAX_QUEUE) return [];
  geoPending++;
  const run = geoChain.then(async () => {
    const wait = geoLastAt + GEO_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    geoLastAt = Date.now();
    return geocodeSearchRaw(query);
  });
  geoChain = run.catch(() => {});
  const shared = run.then((data) => {
    if (data.length) {
      if (geoCache.size >= GEO_CACHE_MAX) geoCache.clear();
      geoCache.set(key, { data, exp: Date.now() + GEO_CACHE_TTL_MS });
    }
    return data;
  });
  geoInFlight.set(key, shared);
  try {
    return await shared;
  } finally {
    geoInFlight.delete(key);
    geoPending--;
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Compass bearing (0 = north, 90 = east, ...) from point 1 to point 2 —
// used to rotate the rider marker to actually face the direction of travel,
// the way Ola/Uber driver icons do, rather than always pointing the same way.
// Shortest distance in metres from a point to a polyline of [lat, lng]
// points. Used to decide whether a technician has left the planned route
// (so we only ask the routing server again when they actually have).
function distanceToPathMeters(lat, lng, path) {
  if (!path || path.length === 0) return Infinity;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const px = lng * mPerDegLng;
  const py = lat * mPerDegLat;
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i][1] * mPerDegLng, ay = path[i][0] * mPerDegLat;
    const bx = path[i + 1][1] * mPerDegLng, by = path[i + 1][0] * mPerDegLat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best) best = d;
  }
  if (path.length === 1) best = Math.hypot(px - path[0][1] * mPerDegLng, py - path[0][0] * mPerDegLat);
  return best;
}

function bearingBetween(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Given a road-following path (array of [lat, lng]) and a progress value
// from 0 to 1, returns the point that far along the path BY DISTANCE (not
// by point count — road segments vary wildly in length) plus the compass
// heading of travel at that point. This is what makes the technician
// marker move at a steady real-world pace along actual roads and turn to
// face each bend, instead of teleporting between a fixed number of steps.
function pointAlongPath(path, progress) {
  if (!path || path.length < 2) return null;

  const segmentLengths = [];
  let totalKm = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const d = haversineKm(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
    segmentLengths.push(d);
    totalKm += d;
  }

  const targetKm = Math.max(0, Math.min(1, progress)) * totalKm;
  let coveredKm = 0;

  for (let i = 0; i < segmentLengths.length; i++) {
    const segKm = segmentLengths[i];
    if (coveredKm + segKm >= targetKm || i === segmentLengths.length - 1) {
      const segProgress = segKm === 0 ? 0 : (targetKm - coveredKm) / segKm;
      const [lat1, lon1] = path[i];
      const [lat2, lon2] = path[i + 1];
      return {
        latitude: lat1 + (lat2 - lat1) * segProgress,
        longitude: lon1 + (lon2 - lon1) * segProgress,
        heading: bearingBetween(lat1, lon1, lat2, lon2),
      };
    }
    coveredKm += segKm;
  }

  // Progress >= 1 or a degenerate path — land exactly on the final point.
  const last = path[path.length - 1];
  const secondLast = path[path.length - 2];
  return {
    latitude: last[0],
    longitude: last[1],
    heading: bearingBetween(secondLast[0], secondLast[1], last[0], last[1]),
  };
}

module.exports = { fetchRoadRoute, bearingBetween, pointAlongPath, haversineKm, geocodeSearch, distanceToPathMeters };
