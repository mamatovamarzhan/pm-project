/* HTTP API + static front end. Start with:  npm start   (reads .env for DATABASE_URL, PORT, DEMO_TOOLS) */
"use strict";
const path = require("path");
const fs = require("fs");
const express = require("express");
const { connect, migrate } = require("./db");
const { seedIfEmpty } = require("./seed");
const { createService, ROLES, TYPES, STATUSES, SESSION_MINUTES, MAX_FAILS, LOCK_SECONDS } = require("./service");

const STATUS = { UNAUTH: 401, EXPIRED: 401, INVALID: 401, ACCESS_DENIED: 403, NOT_FOUND: 404, VALIDATION: 400, POLICY: 422, CAPACITY: 422,
  NO_MATCH: 422, CONFLICT: 409, HAS_BOOKINGS: 409, RATE_LIMIT: 429, SSO_DOWN: 503 };

function buildApp(svc, opts) {
  const demo = !opts || opts.demo !== false;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  const tok = req => (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || null;
  const r = fn => async (req, res) => res.json(await fn(req, tok(req)));

  app.get("/api/meta", r(async () => ({ roles: ROLES, types: TYPES, statuses: STATUSES, sessionMinutes: SESSION_MINUTES, maxFails: MAX_FAILS,
    lockSeconds: LOCK_SECONDS, policy: await svc.policy(), demo: demo ? { accounts: await svc.demoAccounts(), password: require("./sso").DEMO_PASSWORD, ssoDown: svc.isSsoDown() } : null })));
  // US1
  app.post("/api/login", r(req => svc.login(req.body.username, req.body.password)));
  app.post("/api/logout", r((req, t) => svc.logout(t)));
  app.get("/api/me", r((req, t) => svc.me(t)));
  app.get("/api/dashboard", r((req, t) => svc.dashboard(t)));
  // US2
  app.get("/api/users", r((req, t) => svc.listUsers(t)));
  app.put("/api/users/:username/role", r((req, t) => svc.setRole(t, req.params.username, req.body.role)));
  app.get("/api/logs", r((req, t) => svc.logs(t)));
  // US3
  app.get("/api/facilities", r((req, t) => svc.listFacilities(t)));
  app.post("/api/facilities", r((req, t) => svc.saveFacility(t, { ...req.body, id: null })));
  app.put("/api/facilities/:id", r((req, t) => svc.saveFacility(t, { ...req.body, id: req.params.id })));
  app.get("/api/facilities/:id/future-bookings", r((req, t) => svc.futureBookings(t, req.params.id)));
  app.delete("/api/facilities/:id", r((req, t) => svc.deleteFacility(t, req.params.id, { force: req.query.force === "1" })));
  // US4
  app.get("/api/search", r((req, t) => svc.search(t, req.query)));
  app.get("/api/search/options", r((req, t) => svc.filterOptions(t)));
  app.get("/api/catalogue/:id", r((req, t) => svc.facility(t, req.params.id)));
  // US5
  app.get("/api/bookings", r((req, t) => svc.listBookings(t, { all: req.query.all === "1" })));
  app.post("/api/bookings", r((req, t) => svc.createBooking(t, req.body)));
  // Approval
  app.get("/api/approvals", r((req, t) => svc.pendingBookings(t)));
  app.post("/api/bookings/:id/decision", r((req, t) => svc.decideBooking(t, req.params.id, req.body.decision, req.body.note)));
  // US6
  app.post("/api/recommendations", r((req, t) => svc.recommend(t, req.body)));
  // demo tools
  if (demo) {
    app.post("/api/demo/reset", r(() => svc.reset()));
    app.post("/api/demo/sso", r(req => svc.setSsoDown(req.body.down)));
    app.post("/api/demo/idle", r((req, t) => svc.simulateIdle(t)));
  }
  app.use("/api", (req, res) => res.status(404).json({ code: "NOT_FOUND", message: "Unknown API endpoint." }));

  // Front end: only these folders are public (never server/, data/, node_modules/ or .env).
  const root = path.join(__dirname, "..");
  app.use("/css", express.static(path.join(root, "css")));
  app.use("/js", express.static(path.join(root, "js")));
  app.get("/", (req, res) => res.sendFile(path.join(root, "index.html")));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err && err.code && STATUS[err.code]) return res.status(STATUS[err.code]).json({ code: err.code, message: err.message, ...(err.extra || {}) });
    // Raised by the bookings_no_overlap trigger (schema.sql) if an overlap slipped past the checks in service.js.
    if (err && err.code === "23P01") return res.status(409).json({ code: "CONFLICT", message: "That room is already booked during that time." });
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ code: "VALIDATION", message: "Malformed JSON." });
    console.error(err);
    res.status(500).json({ code: "SERVER", message: "Something went wrong on the server." });
  });
  return app;
}

async function main() {
  const envFile = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const db = await connect();
  await migrate(db);
  if (await seedIfEmpty(db, Date.now())) console.log("Empty database: demo data loaded.");
  const demo = (process.env.DEMO_TOOLS || "on").toLowerCase() !== "off";
  const app = buildApp(createService({ db }), { demo });
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => console.log(`Campus Facility Allocation running at http://localhost:${port}\nDatabase: ${db.label}`));
  // Close the database cleanly on Ctrl+C and on `npm run dev` restarts (an embedded database killed mid-write can be damaged).
  const stop = () => { server.close(); db.close().catch(() => {}).finally(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (require.main === module) main().catch(e => { console.error("Could not start:", e.message); process.exit(1); });

module.exports = { buildApp };
