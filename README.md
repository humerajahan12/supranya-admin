# Supranya Admin

A real Node.js backend + web dashboard for Supranya's staff — separate from
the customer/technician mobile app. Admin logs in, assigns jobs to
technicians, and watches the technician's live location move toward the
charging station on a map.

## Database migration — Postgres (Supabase), replacing the in-memory store

**Why:** everything used to live in a plain JS array in `src/store.js` —
every customer, device, ticket, attendance and leave record was gone on
every server restart or crash. That was fine for local development, not
for real customers trusting the app with their data. This backend now
runs on real Postgres and keeps everything permanently.

**What changed, concretely:**
- `src/store.js` is gone. All data access goes through `db/repo.js`,
  which talks to Postgres via the `pg` package.
- `db/schema.sql` defines every table (technicians, customers, devices,
  addresses, jobs, attendance, leave_requests, alerts, admin_users).
- The admin login is a real account in the database now, with a
  **bcrypt-hashed password** — not a hardcoded plaintext credential.
- The session secret comes from an environment variable, not a hardcoded
  string in the source.
- Every API endpoint returns the exact same JSON shape as before — the
  mobile app and this dashboard's own frontend (`public/dashboard.html`)
  did not need to change at all.
- The one behavior change: technicians and customers now have a real
  **unique constraint on phone number** (the old array-based version had
  none, which was a latent bug — `/api/technicians/by-phone` could
  silently match the wrong record if two ever shared a phone). Creating
  a second technician/customer with a phone already in use now returns
  a clean `409 That phone number is already in use.` instead of quietly
  creating a duplicate.

### One-time setup

1. **Create a free Supabase project** at [supabase.com](https://supabase.com) — a couple of minutes, no card required for the free tier.
2. **Get your connection string**: in the Supabase dashboard, go to
   Project Settings → Database → Connection string → URI. You'll see two
   variants — which one to use when is below.
3. **Copy `.env.example` to `.env`** in this folder and fill in real values:
   ```
   DATABASE_URL="postgresql://postgres:YOUR-PASSWORD@YOUR-PROJECT.supabase.co:5432/postgres"
   SESSION_SECRET="<a long random string>"
   ADMIN_USERNAME="admin"
   ADMIN_PASSWORD="<a real password, not the old default>"
   ```
   Generate a random session secret with:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   For this one-time setup step, use the **direct connection** (port
   `5432`), not the pooled one — the commands below run once each and
   don't need connection pooling.
4. **Apply the schema:**
   ```
   npm run db:migrate
   ```
5. **Create the admin account** (reads `ADMIN_USERNAME`/`ADMIN_PASSWORD` from `.env`):
   ```
   npm run db:seed-admin
   ```
   Run this again any time you want to change the admin password.
6. **(Optional) Seed demo data** — fictional technicians, customers and
   ticket history, useful for demoing pagination/search/reports without
   real data yet:
   ```
   npm run db:seed-demo
   ```
   Don't run this against a database that already has real customer
   data in it.
7. **Switch `DATABASE_URL` to the pooled connection** (port `6543`, with
   `?pgbouncer=true` on the end — Supabase's dashboard shows you this
   exact string as the "Transaction" pooler option) before actually
   running the server day to day:
   ```
   npm start
   ```
   The pooled connection handles many concurrent requests properly; the
   direct connection (port 5432) is fine for the one-off setup commands
   above but isn't meant for the live app.

### Running locally without Supabase

Any Postgres works, including one on your own machine — just point
`DATABASE_URL` at it (e.g.
`postgresql://postgres:yourpassword@localhost:5432/supranya_dev`) and
run the same `db:migrate` / `db:seed-admin` steps.

## Fix — admin couldn't reach back dates / previous months to mark attendance

Round 5 added the "Mark present" / "Remove" buttons to the Attendance
tab's day view, but the only way to get to an older date was clicking
"‹ Prev" one day at a time, and "This Month" was hardcoded to the
current month with no way to look at (or fix) an earlier one. Since any
day with no check-in/leave record defaults to "absent," a month with no
history yet — or before a technician was onboarded — read as wall-to-
wall absences with no way to reach it and correct it. Two additions,
`public/dashboard.html` only (no backend/API changes needed — the
month endpoint already accepted an arbitrary `month=YYYY-MM`, it just
wasn't being used):

- **Day view**: a date picker next to the ‹ › day arrows — jump straight
  to any past date instead of clicking back one day at a time. Capped at
  today, same as the arrows.
- **This Month view**: its own ‹ › navigation to move between months
  (Next is disabled once you're back on the current month — no jumping
  into the future). The stat tiles, donut and per-technician table all
  update for whichever month you're looking at.
- The absent-by-default behavior itself is unchanged — that's the
  correct read of "no record and not on leave" — but now every day it
  applies to is actually reachable to correct with Mark present.

## Fix — Power Rating wasn't showing on the admin dashboard

The mobile app's Register Device screen (round 5, below) already saves
`power` correctly — this was purely a display bug on the admin side. The
customer detail panel's device card, and both map popups, were still
written for the old catalog-based schema and showed `model · brand`, not
`brand · power`. Since round 5 stopped collecting `model` (it's now
always blank), that line rendered as `— · Delta` — reading like the
power rating never saved, when it actually did; it just wasn't being
displayed anywhere. Fixed in `public/dashboard.html` (device card meta
line + both Leaflet map popups) to show `brand · power` instead of
`model · brand`.

## Client feedback round 5 — admin can mark backdated attendance

A technician who forgets to check in from their phone no longer needs a
data-fix from outside the product — the admin can mark it themselves,
right from the day they're looking at.

- **`POST /api/attendance/mark`** (admin-only) — body `{ technicianId,
  date }` (`date` is `YYYY-MM-DD`). Same one-record-per-technician-per-day
  rule as the technician's own check-in (409 if that day's already
  marked), and rejects a future date (400) — this is for catching up on a
  missed day, not pre-marking one. The created record carries
  `markedByAdmin: true` so it's distinguishable from a technician's own
  check-in if that ever matters, though today it reads identically
  everywhere (summary, reports, the technician's own calendar).
- **`DELETE /api/attendance/:id`** (admin-only) — removes any attendance
  record, whether it was a technician's own check-in or an admin's mark.
  For undoing a mistake on either side.
- **Dashboard**: the Attendance tab's day view now shows a **Mark
  present** button next to any technician who isn't already marked
  present that day (works for absent, on-leave, or weekend days too — an
  admin override always wins), and a **Remove** button next to a
  technician who is, for correcting a wrong mark. Both are only offered
  for today or an earlier day, matching the backend's no-future-dates
  rule. This Month mode is unaffected — it's a read-only rollup of the
  same underlying data.

## Client feedback round 4 — check-in-only attendance + a single dashboard-style Attendance tab

Two changes based on more client feedback: attendance no longer has a
check-out step, and the Attendance tab's Log + Grid sub-tabs were
replaced with one summary view shaped like a normal attendance
dashboard (stat tiles, a donut, a day list) instead of a raw log or a
matrix to scan.

- **Check-in only**: `POST /api/technicians/:id/attendance/check-out`
  is gone. An attendance record is now just `{ id, technicianId,
  checkInAt }` — one per technician per calendar day. Checking in twice
  in the same day 409s ("Already checked in today") instead of the old
  open/closed-shift logic. There's no more "hours worked" anywhere in
  the product, since there's nothing to measure a duration against
  anymore — attendance is a yes/no per day.
- **`GET /api/attendance/summary`** (admin-only) replaces the old
  `/api/attendance` (paginated log), `/api/attendance/current`
  (currently-checked-in roster) and `/api/attendance/grid` (the
  technician×week matrix from the previous round) — all three are
  removed. One endpoint, two modes:
  - `?mode=day&date=YYYY-MM-DD` (defaults to today) — every
    technician's status that day (present/absent/on leave) plus their
    check-in time if present, and day totals for the stat tiles/donut.
  - `?mode=month&month=YYYY-MM` (defaults to this month, capped at
    today so it doesn't count unstarted future days) — per-technician
    present/absent/leave day counts for the month, plus totals.
- **Dashboard**: the Attendance tab is now **Attendance** (Today / This
  Month toggle, stat tiles, a donut chart, and either a day list or a
  per-technician month table) + **Leave requests** (unchanged from
  round 3). Today mode has Prev/Next day navigation so you can look
  back at any past day, not just today.
- **Reports tab**: `GET /api/reports/attendance` switched from
  hours/shifts to days-present, since there's no check-out to compute
  hours from — `totalPresentDays`, `avgPresentDaysPerTechnician`, and a
  per-technician `presentDays` count; the chart shows days present per
  day/week/month instead of hours.
- **Demo data**: seeded attendance records now carry just `checkInAt`
  (no `checkOutAt`), same 30-day spread as before.

## Client feedback round 3 — leave requests

Technicians can now apply for leave from the mobile app, and it shows up
for the admin right inside the Attendance tab as a request queue to
approve or reject — no separate screen to hunt for.

- **Data model**: `leaveRequests` array in `store.js` — one record per
  request, `{ id, technicianId, fromDate, toDate, reason, status, requestedAt, decidedAt }`.
  `fromDate`/`toDate` are plain `'YYYY-MM-DD'` strings, not timestamps —
  a leave request is about whole calendar days, and comparing strings in
  that format sorts/ranges correctly without any timezone arithmetic.
  `status` is `pending` until an admin decides it (`approved`/`rejected`).
- **New endpoints** (all in `server.js`):
  - `POST /api/technicians/:id/leave` — public (same trust model as
    check-in/out), validates `fromDate`/`toDate` are `YYYY-MM-DD`,
    `fromDate <= toDate`, and `reason` is non-empty.
  - `GET /api/technicians/:id/leave` — a technician's own leave history,
    used by the mobile app to render "My leave requests" and to know
    which days are covered by an approved/pending request for the
    calendar.
  - `DELETE /api/technicians/:id/leave/:leaveId` — lets a technician
    withdraw their own *pending* request only (403 if it's not theirs,
    409 if it's already been decided).
  - `GET /api/leave` — admin-only, paginated/searchable(by technician
    name)/status-filterable, sorted pending-first then newest — backs
    the new **Leave requests** sub-tab.
  - `POST /api/leave/:id/decide` — admin-only, `{status: 'approved'|'rejected'}`,
    409 if the request was already decided (no re-deciding a closed
    request).
- **Dashboard**: the Attendance tab now has two sub-tabs — **Log** (the
  existing check-in/out history, unchanged) and **Leave requests** (new),
  with a badge showing the pending count. Approve/Reject buttons only
  appear on pending rows.
- **Mobile app**: the technician Attendance tab is now a month calendar —
  green dot for a day actually worked, amber for an approved/pending
  leave day (pending shown with a dashed outline), red for an unexplained
  absence on a past weekday, nothing for weekends/future days. An "Apply
  for leave" button opens a form (from/to date, reason) and a "My leave
  requests" list below the calendar shows status and lets a technician
  withdraw a still-pending request. The check-in/check-out card from
  round 2 is unchanged, just now living above the calendar.
- **Demo data**: two seeded leave requests (one approved, one pending)
  so the new UI isn't empty on first look.
- **Attendance grid view**: a third Attendance sub-tab, **Grid** — a
  technician × day matrix (rows = technicians, columns = the selected
  week's dates) with Prev/Next week navigation, matching the
  spreadsheet-style attendance layout the client asked for. Each cell is
  a colored icon: green ✓ present, red ✗ absent, amber "L" on approved
  leave, dashed-outline "L" for a still-pending leave request, gray "—"
  for a weekend or a future day. Backed by a new admin-only
  `GET /api/attendance/grid?from=&to=` (millis, inclusive, capped at 62
  days per request) that computes each cell server-side from the same
  `attendance`/`leaveRequests` data the Log and Leave sub-tabs already
  use — so a technician who's present, on leave, or missing shows up
  identically everywhere in the tab.

## Client feedback round 2 — technician attendance

Technicians now mark their own attendance from the mobile app (a new
Attendance tab, next to Jobs and Profile) — Check In at the start of a
shift, Check Out at the end. Every timestamp is set server-side
(`Date.now()` in `server.js`, not the phone's clock), so it can't be
backdated or spoofed from the device.

- **Data model**: `attendance` array in `store.js` — one record per shift,
  `{ id, technicianId, checkInAt, checkOutAt }`. `checkOutAt` stays `null`
  while a technician is currently checked in, so "who's on shift right
  now" is just "whose latest record has no checkOutAt" — no separate
  status flag that could drift out of sync with the real history.
- **New endpoints** (all in `server.js`):
  - `POST /api/technicians/:id/attendance/check-in` / `check-out` —
    public, same trust model as the job-status endpoints (identified by
    technicianId in the path). 409s if already checked in / not checked
    in, so a double-tap can't create two open shifts.
  - `GET /api/technicians/:id/attendance` — a technician's own history
    (public), used by the app to show past shifts and figure out on
    launch whether they're currently checked in.
  - `GET /api/attendance` — admin-only, paginated/searchable(by
    technician name)/date-range-filterable full log, backing the new
    **Attendance tab** on the dashboard.
  - `GET /api/attendance/current` — admin-only, the live "who's checked
    in right now" roster shown at the top of that tab.
  - `GET /api/reports/attendance` — admin-only, aggregated reporting for
    the **Reports tab**: total shifts/hours, per-technician days
    present/hours/avg-hours-per-day, and a time series grouped by day,
    week, or month (`?groupBy=`). Uses the same `from`/`to` millis
    convention as the existing job reports, so it shares the Reports
    tab's This Month / Last Month / Last Quarter / Custom range picker —
    daily/weekly/monthly/custom is the groupBy selector plus that shared
    range, not a second separate filter.
- **Demo data**: 30 days of realistic seeded shifts for the 3 demo
  technicians (under `SEED_DEMO_DATA=true`), Sundays and the occasional
  day off skipped, so the Attendance tab and report aren't empty on
  first look.
- Only *completed* shifts (checkOutAt set) count toward hours in the
  report — a shift still in progress counts toward today's headcount but
  not yet toward totalHours, since its duration isn't final yet.

## Client feedback round 1 — admin-created jobs + multi-job assignment

Two changes from client demo feedback:

- **Admin can now create a job directly from the dashboard** — a "+ New
  Job" button on the Jobs tab opens a form: search for a registered
  customer, pick their charger or drop a pin, choose a service, and
  optionally assign it to a technician immediately. Every job is tied to
  a real registered customer (no walk-in/no-account path — that option
  was in the first version but removed per client feedback). New
  endpoint: `POST /api/jobs` (admin-only), separate from the public
  `POST /api/tickets` the mobile app uses — same job shape, plus an
  optional `technicianId` for immediate assignment.
- **A technician can now be assigned more than one job at a time.** The
  Jobs tab's "Choose a technician" dropdown used to silently filter out
  anyone already `on_job`, which is what made it look like a technician
  could only ever carry one ticket. That filter's gone — every technician
  is selectable, each shown with their current active-job count, so the
  admin can deliberately load someone up who has capacity. A technician's
  status (`available`/`on_job`) is now *derived* from whether they have
  any non-Completed job, not set as a side effect of whichever single job
  was touched last — completing one of a technician's two active jobs no
  longer incorrectly frees them while the other is still open. The
  live-tracking simulation was also fixed so two active jobs on the same
  technician don't fight over their shared map marker — only the job that
  got assigned first drives the dot; any other concurrent job still gets
  its own real route for its tracking-modal polyline, and still
  progresses through En Route → Arrived on the same timer.

## The critical gap that's now closed: end-to-end ticket lifecycle

Previously, booking a service in the mobile app was a fully local
simulation — it never created anything here, and the technician's own app
had a completely separate, unrelated set of mock jobs. That's fixed:

- **`POST /api/tickets`** (public) — the mobile app's booking flow now
  creates a real ticket here on "payment" success.
- **`GET /api/customers/:id/tickets`** (public) — the customer's Support
  tab now shows real tickets and their real live status.
- **`GET /api/technicians/by-phone`** (public) — the technician app
  resolves its logged-in user to a real technician record here at login.
  A phone number with no matching technician is blocked with an on-screen
  error, not silently let in — a technician account must be provisioned by
  admin first, matching the "server-side provisioning" principle from the
  mobile app's own design notes.
- **`GET /api/technicians/:id/jobs`** (public) — the technician's Jobs tab
  now shows real assigned jobs instead of disconnected mock data.
- **`POST /api/technicians/:techId/jobs/:jobId/status`** (public, but
  ownership-checked: a technician can only update a job actually assigned
  to them) — "Mark as En Route/Arrived/Completed" in the technician app now
  really updates the ticket, which the customer's app picks up next time
  they open their Support tab.

Verified the entire loop for real, twice, via curl: register → book →
admin assigns → technician sees it and marks it Completed → technician
frees back up to "available" → customer sees the final status. Both runs
matched expectations exactly, including a 403 when a different technician
tried to update a job that wasn't theirs.

What's still not real: the payment step itself (unchanged — still an
explicit mock), and there's no push notification when status changes; the
mobile apps pick up changes by refetching when their tab is opened
(`useFocusEffect`), not by a live push.

## Scale, search, and new tabs (latest round)

- **Customer details now show in-place on the right, not a modal.** Clicking
  a customer swaps the map for a detail panel in the same space (with a
  "← Back to map" button to return); the map underneath stays intact and
  reappears exactly as it was. A background refresh (e.g. a new device
  registering) updates the open panel's content live rather than requiring
  it to be reopened, and closes it automatically if the selected customer
  falls off the current page/search results.
- **Jobs tab now has search + pagination too** — by ticket ID, subject, or
  customer name. Unlike Customers (which fetches one page at a time from
  the server), this filters/paginates client-side against the job data
  already being streamed live over the socket for tracking — that data has
  to be pushed in full regardless, so a second paginated fetch would just
  be redundant work for no benefit.
- **SLA is now the real 24-hour rule**, not the demo-shortened 20 seconds
  from earlier — `DELAY_THRESHOLD_MS` in `server.js` defaults to 24 hours.
  Since that's far longer than this demo's ~48-second simulated trip, the
  live delay alert won't naturally fire in a normal test session anymore;
  override it with an environment variable to actually see it fire without
  waiting 24 real hours:
  ```bash
  DELAY_THRESHOLD_MS=20000 npm start        # 20 seconds
  ```
  ```powershell
  $env:DELAY_THRESHOLD_MS=20000; npm start  # PowerShell
  ```
  Also fixed the seeded historical data to actually be consistent with this
  rule — some jobs were previously hardcoded as "delayed" despite
  responding in under an hour, which isn't a breach of a 24-hour SLA at
  all. Verified after the fix: every job flagged delayed genuinely took
  over 24 hours to respond (shortest: 26h), every non-delayed job responded
  well within it (longest: under 1h), and nothing has a timestamp in the
  future.

- **Customers now support real pagination and search** — with a customer
  base in the thousands, sending the whole list every time isn't viable.
  `GET /api/customers` takes `?q=` (matches name or phone) and
  `?page=&pageSize=`, and the dashboard fetches one page at a time rather
  than holding everyone in the browser. Clicking a customer opens a detail
  modal with their full device list and a **status** field
  (active/inactive) you can toggle from there.
- **Found and fixed a real bug in the seed-data generator** while building
  this: the pseudo-random name/area picker used a plain
  `(i * k + c) % arrayLength`, which silently made certain array entries
  (e.g. the last name "Reddy") mathematically unreachable whenever `k` and
  `arrayLength` shared a common factor — no error, just quietly wrong
  variety. Fixed with a proper multiplicative hash; verified every last
  name and area now actually appears in generated data.
- **New Tickets tab** — the full ticket history, searchable and paginated
  independent of the Jobs tab's assignment workflow. Click a ticket for a
  detail view (status, service, customer, technician, SLA, all three
  timestamps).
- **Reports: date-range filtering** — This Month / Last Month / Last
  Quarter / Custom (with date pickers), applied consistently across the
  summary cards, all four charts, the Job History table, and the CSV
  export, since they all read from the same shared range state.
- **Reports: a fourth chart** ("Jobs over time") showing daily job volume
  across the selected range, backed by a new `/api/reports/trend` endpoint.
- **Reports: Job History is now paginated and searchable** too — the same
  `?q=&page=&pageSize=` pattern as Customers and Tickets, via
  `GET /api/reports/history`.
- **Seed data expanded** to 121 customers and ~52 historical tickets spread
  across 100 days, specifically so pagination, search, and date-range
  filtering have something real to demonstrate against — 3 customers and
  5 tickets weren't enough to meaningfully exercise any of this.
- **Caught and fixed a bug before shipping this**: `/api/reports/trend`
  threw a 500 with no date range supplied, because still-unassigned jobs
  (which have no `assignedAt`) slipped through the "no range = return
  everything" fast path and crashed on `new Date(undefined).toISOString()`.
  Verified the fix with the exact request that used to fail.

## Fixed since last version

- **Editing a technician now includes their location.** Previously the
  edit modal hid the map entirely (name/phone/vehicle only) — you asked
  for the ability to update it there too. `PATCH /api/technicians/:id` now
  accepts optional `latitude`/`longitude`, and the edit modal shows the
  map pre-filled with the technician's current position (search box and
  drag-to-adjust both work, same as onboarding). Renamed the section label
  from "Starting location" to just "Location" since it's now shared by
  both flows. Verified via curl: editing a technician's coordinates
  actually updates them.


- **Location search results rendered behind the map** — same root cause
  as the earlier "modal appears behind the map" bug: Leaflet's own
  controls use a z-index up to 1000 internally, and the search dropdown
  was only at 20. Bumped to 2000.
- **Search results now biased toward Hyderabad** — confirmed from a real
  screenshot that "langar house" matched a village in the UK instead of
  the actual Hyderabad locality "Langar Houz." Added a soft regional bias
  (Nominatim's `viewbox` + `bounded=0`, which prefers local results
  without hard-excluding genuine matches elsewhere) to `geocodeSearch` in
  `routing.js`. Verified the request still returns cleanly with this added
  — actual relevance improvement needs your own internet access to
  confirm, same limitation as OSRM/Nominatim throughout.


- **Admin can now edit customer and technician details.** Previously only
  status-toggle and delete existed for customers, and add/delete for
  technicians — no way to fix a typo'd name or update a phone number
  without deleting and recreating the record. Added `PATCH /api/customers/:id`
  and `PATCH /api/technicians/:id`; both surfaced in the dashboard (a ✎ Edit
  button in the customer detail panel, and one on each technician row,
  reusing the onboarding modal in edit mode with the location section
  hidden — editing a technician's live position doesn't make sense the way
  it does for onboarding). Verified both via curl.
- **Admin can now update a customer's device location.** New
  `PATCH /api/customers/:id/devices/:deviceId`, surfaced as a 📍 button on
  each device card in the customer detail panel, opening a pin-map modal.
  Verified via curl: a device's coordinates update correctly.
- **Type-to-search a location, Uber/Ola style.** New `GET /api/geocode`
  (admin-only, proxies OSM's free Nominatim service — same "no API key"
  reasoning as the OSRM routing already in use, with a required
  identifying User-Agent header set server-side per Nominatim's usage
  policy) backs a search box above every pin-map: technician onboarding
  and the new device-location editor. Typing searches, selecting a result
  moves the pin there — dragging still works as before for fine
  adjustment. **I could not verify live Nominatim results from this
  environment** (same limitation as OSRM earlier — this sandbox's network
  can't reach it, confirmed by a graceful 403-then-empty-array response
  rather than a crash); that needs your own internet access when you run
  it. Watch the server log for "Nominatim geocoding returned..." if a
  search ever comes back empty unexpectedly.


- **`GET /api/tickets/:id`** — a real bug slipped through when
  `TrackTechnicianScreen` was rewritten to expect a full ticket object:
  `BookingConfirmedScreen`'s "Track technician" button was never updated
  and still passed the old param shape, so the tracking screen received no
  ticket and rendered a near-blank fallback card. Added this endpoint so
  that screen can fetch the real ticket by id, and fixed the navigation
  call — verified by creating a real ticket via curl and fetching it back
  by id directly.

- **No more fictional technicians/tickets mixed into real usage.** The
  admin dashboard used to always seed 3 fictional technicians (Ravi Kumar,
  Suresh Naik, Mahesh Reddy), a fictional customer, and 50+ demo tickets on
  every startup — meant for demoing pagination/search/reports at scale, but
  confusing once you're actually using the system with real registrations
  from the mobile app, since real and fictional data showed up mixed
  together with no way to tell them apart. **Now the store starts
  completely empty by default** — technicians only appear once you
  onboard them via "+ Add", customers/tickets only appear from real mobile
  app usage. The old demo dataset still exists, just opt-in:
  ```bash
  SEED_DEMO_DATA=true npm start
  ```
  ```powershell
  $env:SEED_DEMO_DATA='true'; npm start
  ```
  Verified three things: the default start has zero technicians/jobs/
  customers and every endpoint still works correctly against that (no
  crashes, `slaComplianceRate`/`avgResponseMinutes` correctly come back
  `null` instead of throwing); `SEED_DEMO_DATA=true` still produces the
  full demo set (3 technicians, 121 customers, 52 jobs) for whenever you
  want something to click around or demo; and a full real flow (onboard a
  technician, register a customer, create a ticket) from a clean start
  shows *only* that real data, nothing fictional mixed in.

- **Customer address book, for real** — `POST /api/customers/:id/addresses`
  mirrors the devices endpoint exactly: public, scoped to a customerId. A
  customer's first address automatically becomes their default; adding a
  later one marked `isDefault:true` correctly unsets any previous default.
  Verified all three cases via curl: a fresh customer starts with an empty
  address list, their first added address auto-becomes default, and a
  second one explicitly marked default correctly flips the first back to
  non-default.
  create-or-find `register` endpoint) that lets the mobile app check
  whether a phone number is already a customer before deciding whether to
  ask for a name. Verified both paths: an unregistered number 404s (app
  shows the name-entry screen), a registered one returns their real name
  (app skips straight to OTP).

- **Customers can now be deleted** — a 🗑 on each list row and a "Delete
  customer" button in the detail panel, both calling
  `DELETE /api/customers/:id`. Same safety principle as deleting a
  technician: blocked (409) if the customer has an open (non-Completed)
  ticket, so a delete can't silently orphan active work. Verified both
  paths: deleting a customer with genuinely no open tickets succeeds, and
  the seed customer (who has two real open seed tickets) is correctly
  blocked with the actual ticket ID named in the error.
- **Customer names now get captured properly** — the mobile app previously
  only asked for a phone number, so every registration showed up here as
  "Customer" with no real name. The registration endpoint already had
  logic to fill in a real name on a later login if the existing record
  still had the placeholder — verified that path works: re-registering the
  same phone number with a name now updates the existing record instead of
  leaving it stuck at "Customer" forever.

- **Reports tab redesigned** (my recommendation, implemented in full):
  - **Removed the Job History table** — it duplicated the Tickets tab
    (search + pagination, but no click-to-detail), so two tabs offered
    overlapping ways to browse the same raw records. Tickets now owns
    record-browsing; Reports stays focused on aggregates. The backend
    `/api/reports/history` endpoint is left in place, just unused by the
    frontend, in case it's wanted again.
  - **Grouped the 8 flat summary cards into 3 labeled clusters** — Volume
    (Total/Completed/Unassigned/Active), Quality & SLA (Compliance %/Avg
    Response/Delayed), Capacity (Technicians Free). Same numbers, but
    readable as a story instead of a grid you have to sort out yourself.
  - **Added a Service Type Split chart** — every job already carried a
    `serviceName` (Fault Diagnosis & Repair vs. Annual Maintenance) that
    went unused anywhere. New `summary.serviceBreakdown` on the backend
    (generic over however many service types exist, not hardcoded to two)
    feeds a 4th doughnut chart — verified it returns real counts
    (27/25 in the seed data) end-to-end via curl.
  - Left customer-side reporting (new registrations, active/inactive
    trends) out for now — everything in Reports is still technician/ticket
    focused. That's a real scope decision, not an oversight; easy to add
    later as its own section if wanted.

- **Technician phone numbers now shown** — in both the list row (under
  vehicle) and the map marker popup on the Technicians tab. The data was
  already there (`technicians` always had a `phone` field); this closed a
  display gap.
- **Technicians tab now has search + pagination too** — same gap as the
  old "Jobs handled per technician" report table, just not yet fixed here.
  Search matches name or phone; pagination applies to the list only, not
  the map, which still shows every technician's live location regardless
  of which page the list is on (same reasoning as Jobs: this data is
  already streamed live over the socket for tracking, so paging the list
  is a display concern, not a "stop sending everyone" concern). Verified
  by onboarding 30 extra technicians and confirming the list paginated
  correctly.

- **Technician report no longer breaks down at scale.** The "Jobs handled
  per technician" table and its two bar charts used to render one row/bar
  per technician with no limit — meaningless once a fleet reaches the
  hundreds. Fixed properly:
  - `GET /api/reports` no longer sends the full per-technician array at
    all (verified: response dropped to ~180 bytes even with 150+
    technicians) — it's just the fleet summary now.
  - New `GET /api/reports/technicians` is paginated, searchable by name,
    and sortable by any column (click a header to sort/reverse) — verified
    at 150+ technicians: correct total, correct page slicing, search
    narrows to exact matches, sort correctly ranks technicians with real
    data first and pushes "no completed jobs yet" (null average response)
    to the end regardless of sort direction.
  - The two per-technician charts now show **top 10** (by completed jobs,
    and by fastest average response) instead of every technician — pulled
    from the same new endpoint, verified the null-average technicians are
    correctly excluded rather than showing as zero-height bars.

- **Customer detail panel no longer covers the map** — it was a full-screen
  overlay sitting on top of it. Now it's a proper side-by-side layout:
  selecting a customer shrinks the map to sit to the right of a fixed-width
  detail panel on the left, and the map re-scopes to show only that
  customer's own chargers (not the whole page's customers) — fits to their
  device locations, or centers on the single device if they have just one.
  Closing the panel restores the full current-page map view.
- **Removed the "Jobs over time" trend chart** from Reports per request —
  the other three charts (completed per technician, avg response time,
  on-time vs. delayed) and the Job History table are unaffected. The
  backend's `/api/reports/trend` endpoint is left in place, just unused by
  the frontend now, in case it's wanted again later.

- **Onboard/delete modal appeared behind the map**: Leaflet's own controls
  render at `z-index: 1000` by default, and the modal overlay was only at
  `100`. Bumped both modals to `5000` so they always sit on top.
- **Job-assignment dropdown kept resetting mid-selection**: every socket
  `state` broadcast (which fires every ~2s while any job is en route, not
  just the one you're looking at) was rebuilding the entire job list's HTML,
  wiping out a technician you'd picked but not yet clicked "Assign" on.
  Fixed by tracking in-progress dropdown selections separately from the
  server's `technicianId`, so a background update no longer clobbers an
  unsubmitted choice.
- **Reports had no dates**: added a "Generated at" timestamp and a full Job
  History table (assigned/arrived/completed dates per job), pulled from the
  same live data the rest of the dashboard already uses.
- **CSS bug**: the Technicians tab's map/panel was leaking into every tab
  (Jobs, Reports) because a shared `.layout { display: flex }` utility class
  had the same CSS specificity as the `.view { display: none }` rule that's
  supposed to hide inactive tabs, and came later in the stylesheet — so it
  always won regardless of which tab was active. Fixed by giving the
  Technicians tab's flex layout its own higher-specificity rule
  (`#techsView.active`) instead of relying on the shared class.
- **Bell icon alignment**: centered properly with flexbox instead of
  relying on line-height, which rendered the 🔔 emoji slightly off-center.
- **Brand logo** now appears on the login page and in the dashboard header
  (`public/assets/logo.png`).

## Run it

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open **http://localhost:4000** in a browser.

**Login:** whatever you set `ADMIN_USERNAME`/`ADMIN_PASSWORD` to when you
ran `npm run db:seed-admin` — see "Database migration" above. No more
hardcoded credential.

**Starts completely empty** — no fictional technicians, customers, or
tickets. Onboard a technician via the Technicians tab's "+ Add", and
customers/tickets will appear as real people use the mobile app. Want
the old demo dataset instead (3 fictional technicians, 100+ fictional
customers/tickets, useful for demoing pagination/search/reports)?
```bash
npm run db:seed-demo
```

## What it actually does (not just mocked UI)

Unlike the mobile app's mockups, this is a real running server:

- **Real session-based auth** (`express-session`) — API routes return a real
  `401` without a valid session; verified by curling the API directly.
- **Real state changes** — assigning a job in the dashboard calls
  `POST /api/jobs/:id/assign`, which actually updates the job and technician
  records in Postgres.
- **Real live updates** — assigning a job kicks off `src/simulate.js`, which
  moves the technician's coordinates a little every 2 seconds and pushes the
  new state to every connected browser over Socket.IO. Refresh the dashboard
  or open it in two tabs — both update from the same live push, not a local
  animation.
- **Every technician always has a live pin on the map** — not just the ones
  currently on a job. Available technicians show green, on-job amber, so
  admin can see who's actually near a given job before assigning, not just
  pick blindly from a dropdown. This lives on its own **Technicians** tab,
  with a "sort by distance to…" dropdown against any open job.
- **Per-job live tracking, on demand.** The Jobs tab is list-only — no
  persistent map. Once a job is assigned, a navigate arrow (🧭) appears on
  its card; clicking it opens a focused map modal showing just that
  technician's marker, the job's destination pin, a line between them, live
  distance remaining, and status — closing it tears the view down rather
  than leaving a map running in the background.
- **Delay alerts.** Every assigned job is watched against the SLA window;
  if a technician hasn't reached "Arrived" in time, a notification appears
  in the bell icon (top right) with a red badge count, and the job card
  itself shows a "DELAYED" tag. `DELAY_THRESHOLD_MS` in `server.js` is the
  real 24-hour SLA by default — see "SLA is now the real 24-hour rule"
  above for how to override it for quick manual testing.
- **Onboard technicians with a starting location.** The Technicians tab has
  a "+ Add" button that opens a form (name, phone, vehicle) plus a
  draggable-pin map for their starting location — same pattern as the
  per-job tracking map. `POST /api/technicians` validates all fields are
  present before creating the record.
- **Delete a technician, safely.** A 🗑 button on each technician row calls
  `DELETE /api/technicians/:id`. If that technician is currently assigned to
  a job that isn't `Completed`, the backend blocks it with a clear error
  (409) rather than silently stranding the job with no one en route —
  verified via curl: deleting a technician mid-job returned the block
  message, deleting a free one succeeded.
- **Customers tab — real integration with the mobile app, not a parallel
  mock.** `supranya-charge-app`'s phone/OTP screen and its Register a
  Charger screen now actually call this backend's public
  `POST /api/customers/register` and `POST /api/customers/:id/devices`
  endpoints. Register a customer + a charger (with its pinned location) in
  the mobile app, and they show up in this dashboard's Customers tab —
  verified end-to-end by curling the exact request shapes those two screens
  send, then confirming the result through the admin-authenticated
  `GET /api/customers`. See "Connecting the mobile app" below for the LAN-IP
  setup this needs.
- **Real marker icons** on every map (job tracking, Technicians, Customers)
  — a proper pin graphic (anchored at its tip, like an actual map pin) for
  charger/device locations, and a rider illustration on a status-colored
  backdrop for technicians, replacing the emoji placeholders. Both source
  images had opaque white backgrounds baked in; cut out via a corner-seeded
  flood fill (preserving internal white details like the pin's own icon
  circle) rather than a naive white-to-transparent threshold that would
  have eaten those details too.
- **Real road-following routes, not straight lines** — when a job is
  assigned, the backend calls OSRM's free public routing API
  (`src/routing.js`) to get an actual road route between the technician and
  the job, and the technician's simulated movement follows that path (by
  real distance along the road, not just point-count) rather than cutting
  diagonally across the map. If OSRM is unreachable, it falls back to a
  straight line automatically — verified this fallback for real, since this
  sandbox's own network can't reach OSRM (blocked, non-allowlisted domain),
  which made it a genuine test of the failure path rather than a
  hypothetical one. **I could not verify the live OSRM routing itself from
  here** — that needs your own internet access when you run it; watch the
  server log for an "OSRM routing returned..." warning if it's ever falling
  back unexpectedly on your machine.
- **Rider icon rotates to face the direction of travel**, Ola/Uber-style —
  computed from the bearing between consecutive points along the route and
  applied as a CSS rotation on the marker's image (not the colored status
  circle behind it). Verified the bearing math against hand-computable
  cases (due east ≈ 90°, due north ≈ 0°) before wiring it into the live
  simulation.
- **Reports tab** has a fleet-wide summary (total/active/completed/
  unassigned jobs, SLA compliance %, average response time, delayed-job
  count, technicians free vs. on-job) plus a per-technician table with
  completed/active/delayed counts and average response time each. Three
  seeded historical jobs carry real backdated timestamps (one deliberately
  breaching the SLA) so this shows genuine numbers on first run, not zeros.
- **Performance dashboard** inside Reports — three Chart.js charts:
  completed jobs per technician, average response time per technician, and
  a fleet-wide on-time vs. delayed split. Redraw whenever the report data
  refreshes.
- **Export to CSV**, real not simulated — the "⬇ Export CSV" link hits
  `GET /api/reports/export`, which the server builds fresh from the same
  data the dashboard shows (technician performance, then full job history
  with dates) and sends with proper `Content-Disposition` headers so it
  downloads as a dated `.csv` file. Verified via curl that the headers and
  content are both correct.

I ran the whole thing end-to-end via curl again before sending this:
checked the reports endpoint showed the seeded SLA/response numbers,
assigned a job, waited the full ~50 seconds for the simulated technician to
actually reach "Arrived", and confirmed the response-time average
recalculated correctly from that real run — not just the seed data.

The one thing that's simulated is the technician's GPS itself — there's no
real technician phone in this demo, so `simulate.js` moves the coordinates
in a straight line toward the job's charger location as a stand-in. See
"Connecting a real technician app" below for what replaces it.

## Architecture

```
src/
  server.js     Express app: auth routes, job/technician API, Socket.IO setup
  simulate.js   Stands in for a real technician app's GPS updates
db/
  index.js      Postgres connection pool
  repo.js       Every DB query, grouped by entity — the only file that talks SQL
  schema.sql    Table definitions
  migrate.js    Applies schema.sql (npm run db:migrate)
  seed-admin.js Creates/updates the admin login (npm run db:seed-admin)
  seed-demo.js  Optional fictional demo data (npm run db:seed-demo)
public/
  index.html    Login page
  dashboard.html Job list + technician list + live Leaflet map
```

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/login` | — | `{ username, password }` → sets session |
| POST | `/api/logout` | — | Destroys session |
| GET | `/api/session` | — | `{ isAdmin: boolean }` |
| GET | `/api/jobs` | required | List all jobs |
| GET | `/api/technicians` | required | List all technicians |
| POST | `/api/technicians` | required | `{ name, phone, vehicle, latitude, longitude }` → onboard a new technician |
| PATCH | `/api/technicians/:id` | required | `{ name?, phone?, vehicle?, latitude?, longitude? }` → edit a technician's details, including location |
| DELETE | `/api/technicians/:id` | required | Remove a technician — blocked (409) if they have a non-Completed job |
| GET | `/api/geocode?q=` | required | Type-to-search a location (Uber/Ola style), proxying OSM's Nominatim |
| POST | `/api/customers/register` | **none (public)** | `{ phone, name? }` → creates or finds a customer by phone. Called by the mobile app, which is never an admin session |
| POST | `/api/customers/:id/devices` | **none (public)** | `{ name, model, brand, power, latitude, longitude }` → registers a device under a customer |
| PATCH | `/api/customers/:id/devices/:deviceId` | required | `{ latitude, longitude }` → admin updates a device's location |
| GET | `/api/customers` | required | Paginated + searchable (`?q=&page=&pageSize=`) `{ customers, total, page, pageSize }` |
| PATCH | `/api/customers/:id` | required | `{ name?, phone? }` → edit a customer's details |
| POST | `/api/tickets` | **none (public)** | `{ customerId, customerName, customerPhone, chargerNickname, latitude, longitude, serviceName, subject? }` → creates a real ticket from a mobile booking |
| GET | `/api/tickets/:id` | **none (public)** | A single ticket by id, with live status and technician name — used by screens that only have a ticketId |
| GET | `/api/customers/:id/tickets` | **none (public)** | A customer's own tickets, with live status and technician name |
| GET | `/api/technicians/by-phone?phone=` | **none (public)** | Technician login lookup — 404 if no account exists for that number |
| GET | `/api/technicians/:id/jobs` | **none (public)** | A technician's own assigned jobs |
| POST | `/api/technicians/:techId/jobs/:jobId/status` | **none (public, ownership-checked)** | `{ status }` → technician updates their own job; 403 if the job isn't assigned to them |
| PATCH | `/api/customers/:id/status` | required | `{ status: 'active'\|'inactive' }` → toggles a customer's status |
| DELETE | `/api/customers/:id` | required | Remove a customer — blocked (409) if they have a non-Completed ticket |
| GET | `/api/customers/by-phone?phone=` | **none (public)** | Read-only lookup — 404 if no customer exists yet for that number. Used by the mobile app to decide whether to skip the name-entry screen for a returning customer |
| POST | `/api/customers/:id/addresses` | **none (public)** | `{ label, line, latitude, longitude, isDefault? }` → adds an address to a customer's own address book. First address auto-becomes default |
| GET | `/api/tickets` | required | Paginated + searchable (`?q=&page=&pageSize=`) full ticket history, independent of the Jobs tab's assignment view |
| GET | `/api/reports/history` | required | Paginated + searchable + date-range-aware job history — not currently used by the frontend (its Job History table was removed; see "Fixed since last version") |
| GET | `/api/reports/trend` | required | Daily job-volume counts for the selected range, feeds the "Jobs over time" chart |
| POST | `/api/jobs/:id/assign` | required | `{ technicianId }` → assigns, starts simulated tracking |
| POST | `/api/jobs/:id/status` | required | `{ status }` → manually override a job's status |
| GET | `/api/reports` | required | Date-range-aware (`?from=&to=`) fleet-wide summary only (no per-technician list — see below) |
| GET | `/api/reports/technicians` | required | Paginated + searchable + sortable (`?q=&page=&pageSize=&sortBy=&sortDir=&from=&to=`) per-technician performance |
| GET | `/api/reports/export` | required | Downloads a `.csv` with technician performance + full job history, respecting the same date range as the dashboard |
| GET | `/api/alerts` | required | List of delay alerts (newest first) |
| POST | `/api/alerts/:id/ack` | required | Marks an alert as read/dismissed |

Socket.IO emits a `state` event (`{ jobs, technicians }`) on every change —
the dashboard's map and lists just re-render from whatever this event sends.

## Security — read before deploying this anywhere but your own machine

Better than it was, but still not fully hardened for the open internet:

- ✅ **Fixed** — the admin password is bcrypt-hashed and stored in Postgres,
  not hardcoded plaintext. Set via `ADMIN_USERNAME`/`ADMIN_PASSWORD` in
  `.env` (see "Database migration" above).
- ✅ **Fixed** — `express-session`'s secret comes from `SESSION_SECRET` in
  `.env`, not a hardcoded string in the source.
- ✅ **Fixed** — data persists in real Postgres now, not an in-memory array.
  Survives restarts, crashes, and redeploys.
- ✅ **Fixed** — every technician/customer endpoint that used to be gated
  only by knowing an ID in the URL (check-in, leave, job status updates,
  device/address registration, ticket lookup, payment verification) now
  requires a real signed token (`src/clientAuth.js`, JWT via
  `AUTH_TOKEN_SECRET` in `.env`), issued at the mock-OTP step
  (`POST /api/customers/register`, `GET /api/technicians/by-phone`) and
  checked against the ID in the URL on every call. Before this, anyone who
  learned or guessed another customer's or technician's ID could read or
  write their data with a plain `fetch` — no login needed. **Still a real
  gap**: the OTP step itself is still a mock ("any 4 digits works"), so a
  token is only as trustworthy as knowing someone's phone number right
  now — this closes the ID-guessing hole, it doesn't replace MSG91. A
  90-day token expiry was chosen deliberately, since there's no
  refresh-token flow yet; revisit once MSG91 is wired in.
- ⚠️ **Still open** — no HTTPS is configured in this codebase itself; it's
  HTTP-only. Whichever host you deploy to (Render, Railway, Fly.io, etc.)
  should give you HTTPS automatically on their domain — just confirm it's
  actually active before pointing Razorpay or MSG91 at the URL, since both
  are the kind of service that generally expects it.

## Payments — Razorpay, and why hosting has to happen before it

You found this out the hard way, so it's written down here: **Razorpay
will not issue live API keys against `localhost` or a LAN IP** — it needs
a real, reachable URL for the business/app before it hands you live keys.
That reorders what's left more than it adds new work — hosting was
already needed for MSG91 and for the mobile app's API URL, it just now
has to happen *first*, before Razorpay, rather than after it.

**What this changes, concretely:**

1. **Deploy `supranya-admin` to a real host with a public HTTPS domain**
   first (Render, Railway, Fly.io, or similar — any of them can run a
   Node + Postgres app like this on a free/cheap tier). This single step
   unlocks Razorpay, MSG91, and a real API base URL for the mobile app all
   at once.
2. **Then** register/complete KYC on Razorpay using that live URL, and
   generate live API keys from their dashboard. (Razorpay's **test mode**
   keys work without a live URL, so the integration code itself can be
   built and tested in parallel with picking a host — it's only the
   *live* keys that are gated on the real URL being up.)
3. **Wire the keys in carefully**: the key ID is safe to put in the mobile
   app (it's public by design), but the key **secret** stays server-side
   only — in `supranya-admin`'s `.env` (e.g. `RAZORPAY_KEY_ID`,
   `RAZORPAY_KEY_SECRET`), never in the mobile app bundle and never
   committed to git.
4. **Never trust the client for the payment result.** The backend should
   create the Razorpay order server-side (`POST /api/payments/order`) and
   verify the payment signature server-side after checkout completes,
   rather than the mobile app simply reporting "payment succeeded" the way
   the current mock does. This is the same reasoning as everywhere else in
   this app — the phone is never the source of truth for anything that
   matters.

**Updated overall sequence:**

1. ~~Postgres migration~~ — done.
2. **Deploy `supranya-admin`** to a real HTTPS host.
3. **Razorpay** — register with the live URL, generate keys, integrate
   real payment (replacing the current mock step).
4. ~~Security hardening~~ — done: real per-technician/customer auth tokens
   (see Security section above). The OTP step they're issued from is still
   a mock, which is exactly what the next step fixes.
5. **MSG91 OTP** integration — real OTP needs DLT registration first (a
   telecom-regulator requirement for sending OTP/SMS to Indian numbers;
   needs business PAN/GST documents, can take days — start this early).
6. **Mobile app config** — point at the real deployed URL instead of the
   LAN-IP placeholder. (Already done for this deployment.)
7. **App store submission paperwork.**

## Live tracking is real now — but the routing provider has to change before ~100-150 technicians go live

`simulate.js` used to fake technician movement with a server-side timer
walking a fixed route. That's gone: the technician's own phone now reports
real GPS to `POST /api/technicians/:id/location` (foreground-only — see
`TrackingContext.js` in the mobile app), and that's the only thing that
moves a technician's dot on the map.

**The one thing NOT yet fixed**: the road route (the green line, and
travel-time accuracy) still comes from `src/routing.js`'s `fetchRoadRoute`,
which calls OSRM's free public demo server — a shared community resource
with no API key, explicitly not meant for production/sustained traffic.
It's throttled server-side to recompute at most once every 25 seconds per
active job (`ROUTE_RECOMPUTE_THROTTLE_MS` in `server.js`), which is enough
to keep today's testing well-behaved, but at the real target of 100-150
technicians potentially en route simultaneously, this WILL start failing —
not a hypothetical, a near-certainty at that request volume. Same caveat
applies to `geocodeSearch` (address search, via Nominatim) in the same
file, though that's dispatcher-driven and much lower volume, so lower
priority.

**Before running the real build with real technicians at scale**, swap
`fetchRoadRoute` to a production routing provider — Google Directions API
(same billing account as the Maps key already in use; ballpark $5 per
1,000 requests after a 10,000/month free allowance, confirmed as of this
writing) is the straightforward option, since the groundwork is already
in place. Self-hosting OSRM is the free alternative, at the cost of real
infra work (a Docker container + a road-data extract to maintain).

## Connecting the mobile app (supranya-charge-app)

The mobile app's phone/OTP screen and Register a Charger screen already
call this backend for real — see `src/config.js` in `supranya-charge-app`.
The one thing you must do for it to actually work: **replace the
placeholder IP in that file with your computer's real LAN IP address**,
since a phone running Expo Go can't reach "localhost" of the computer
running this server. Full instructions are in the comment at the top of
that file. Quick version:

1. Phone and computer on the same Wi-Fi.
2. Find your computer's LAN IP (`ipconfig` on Windows, `ifconfig` on Mac/Linux).
3. Put that IP into `supranya-charge-app/src/config.js`'s `ADMIN_API_BASE_URL`.
4. Run this backend (`npm start`) before testing registration on the phone.

If the mobile app can't reach this backend (wrong IP, backend not running,
different networks), it fails silently from the customer's point of view —
login and charger registration still work locally in the app, they just
won't show up here. That's a deliberate choice (a demo shouldn't block a
person's login over a dev networking issue) but worth knowing if a
"registered" customer doesn't appear in the Customers tab.

## Connecting a real technician app

Right now `simulate.js` fakes GPS movement. To make it real:

1. Add an endpoint like `POST /api/technicians/:id/location { latitude, longitude }`
   that the technician's own mobile app (see `supranya-charge-app`'s
   technician side) calls every few seconds while a job is active.
2. Delete `simulate.js` and have that new endpoint call `broadcastState()`
   instead — the dashboard's map code doesn't need to change at all, since
   it already just reacts to whatever the `state` socket event contains.
3. Tie technician login (in the mobile app) to a real account so the
   backend knows which technician's phone is calling that endpoint.
