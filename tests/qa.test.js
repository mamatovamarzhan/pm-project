/* QA acceptance tests for User Stories 1-6, taken from the US1QATest … US6QATest sheets.
   They run against a real PostgreSQL engine (PGlite, in memory) with the same schema the server uses.
   Run:  npm test      (Node 20+) */
const { test, describe, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { connect, migrate } = require("../server/db");
const { reset, weekdayAt } = require("../server/seed");
const { createService, ROLES, TYPES, STATUSES, MAX_FAILS, LOCK_SECONDS } = require("../server/service");
const { DEMO_PASSWORD: PW } = require("../server/sso");
const { buildApp } = require("../server/server");

const START = new Date(2026, 9, 5, 9, 0).getTime(); // Monday 5 Oct 2026, 09:00 local time
let db, api, clock, tok;
const at = (days, hh, mm) => weekdayAt(clock, days, hh, mm).toISOString();
const login = async u => (tok = (await api.login(u, PW)).token);
const rows = (sql, p) => db.query(sql, p).then(r => r.rows);
const idOf = async name => (await rows("SELECT id FROM facilities WHERE name = $1 OR name LIKE $2", [name, name + " %"]))[0].id;
async function rejects(promise, code) {
  try { await promise; } catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return e; }
  assert.fail("expected an error " + code);
}

before(async () => { db = await connect({ url: "", memory: true }); await migrate(db); });
after(async () => { await db.close(); });
beforeEach(async () => { clock = START; api = createService({ db, now: () => clock }); await reset(db, clock); tok = null; });

describe("US1 — Login & Authentication", () => {
  test("Scenario 1: valid credentials authenticate the user and redirect to the dashboard", async () => {
    const r = await api.login("student", PW);
    assert.equal(r.redirect, "dashboard");
    assert.equal((await api.me(r.token)).username, "student");
    assert.equal(r.token.length, 64, "a session token is issued");
    const [s] = await rows("SELECT token_hash FROM sessions");
    assert.notEqual(s.token_hash, r.token, "only a hash of the token is stored");
  });
  test("Scenario 2: invalid credentials are rejected with 'Invalid username or password'", async () => {
    const e = await rejects(api.login("student", "wrong-password"), "INVALID");
    assert.equal(e.message, "Invalid username or password");
    assert.equal((await rows("SELECT * FROM sessions")).length, 0);
  });
  test("Scenario 3: logout terminates the session and redirects to the login page", async () => {
    await login("student");
    assert.equal((await api.logout(tok)).redirect, "login");
    await rejects(api.me(tok), "UNAUTH");
  });
  test("Scenario 4: after 30 minutes of inactivity any action shows 'Session expired, please log in again'", async () => {
    await login("student");
    clock += 31 * 60 * 1000;
    const e = await rejects(api.search(tok, {}), "EXPIRED");
    assert.equal(e.message, "Session expired, please log in again");
    await rejects(api.me(tok), "UNAUTH");
  });
  test("Rule: activity keeps the session alive (the 30 minutes count from the last action)", async () => {
    await login("student");
    clock += 20 * 60 * 1000; await api.me(tok);
    clock += 20 * 60 * 1000;
    assert.equal((await api.me(tok)).username, "student");
  });
  test("Rule: the user cannot log in while the SSO server is unavailable", async () => {
    api.setSsoDown(true);
    await rejects(api.login("student", PW), "SSO_DOWN");
  });
  test("Rule: failed login attempts are rate-limited and logged", async () => {
    for (let i = 0; i < MAX_FAILS; i++) await rejects(api.login("faculty", "x"), "INVALID");
    await rejects(api.login("faculty", PW), "RATE_LIMIT"); // even the right password is refused while locked
    clock += (LOCK_SECONDS + 1) * 1000;
    assert.equal((await api.login("faculty", PW)).redirect, "dashboard");
    await login("admin");
    const failed = (await api.logs(tok)).loginLog.filter(l => !l.ok);
    assert.ok(failed.length >= MAX_FAILS + 1, "failures are in the sign-in log");
  });
  test("Rule: passwords are never stored in the database", async () => {
    await login("student");
    const cols = (await rows("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'")).map(r => r.column_name);
    assert.ok(!cols.some(c => /pass/i.test(c)), "users table has no password column");
    for (const t of ["users", "sessions", "login_log", "audit_log"]) assert.ok(!JSON.stringify(await rows(`SELECT * FROM ${t}`)).includes(PW), t);
  });
  test("Rule: no content is reachable without a login", async () => {
    await rejects(api.search(null, {}), "UNAUTH");
    await rejects(api.listFacilities("not-a-token"), "UNAUTH");
    await rejects(api.recommend(null, {}), "UNAUTH");
  });
});

describe("US2 — User Role Management", () => {
  test("Scenario 1: Admin changes Faculty → Facility Manager; saved immediately, effective on next login", async () => {
    await login("faculty2"); const oldTok = tok;
    await login("admin");
    assert.equal((await api.setRole(tok, "faculty2", "Facility Manager")).role, "Facility Manager");
    assert.equal((await rows("SELECT role FROM users WHERE username = 'faculty2'"))[0].role, "Facility Manager", "stored in the users table");
    assert.equal((await api.logs(tok)).audit[0].action, "Role changed");
    await rejects(api.listFacilities(oldTok), "ACCESS_DENIED"); // the open session keeps the old role
    await login("faculty2");
    assert.equal((await api.me(tok)).role, "Facility Manager");
    assert.ok((await api.listFacilities(tok)).length > 0, "facility-management permission granted on next login");
  });
  test("Scenario 2: a Student who opens the admin panel gets 'Access Denied'", async () => {
    await login("student");
    assert.equal((await rejects(api.listUsers(tok), "ACCESS_DENIED")).message, "Access Denied");
    await rejects(api.setRole(tok, "student", "Admin"), "ACCESS_DENIED");
    assert.equal((await rows("SELECT role FROM users WHERE username = 'student'"))[0].role, "Student", "no self-elevation");
  });
  test("Scenario 3: a Student with 2 active bookings cannot create a third", async () => {
    await login("student"); // the seed gives this student 1 pending request
    await api.createBooking(tok, { facilityId: await idOf("D102"), start: at(4, 9), end: at(4, 10), purpose: "Revision", attendees: 4 });
    const e = await rejects(api.createBooking(tok, { facilityId: await idOf("D103"), start: at(5, 9), end: at(5, 10), purpose: "Revision", attendees: 4 }), "POLICY");
    assert.match(e.message, /2 active bookings at a time/);
  });
  test("Rule: a Faculty user is not held to Student limits", async () => {
    await login("faculty");
    const me = await api.me(tok);
    assert.equal(me.limits.maxActive, 5);
    for (let i = 0; i < 3; i++) await api.createBooking(tok, { facilityId: await idOf("D102"), start: at(5 + i, 9), end: at(5 + i, 13), purpose: "Lecture", attendees: 25 });
  });
  test("Rule: roles are exactly Student, Faculty, Facility Manager, Admin; unknown roles are rejected", async () => {
    await login("admin");
    assert.deepEqual(ROLES, ["Student", "Faculty", "Facility Manager", "Admin"]);
    assert.deepEqual((await rows("SELECT name FROM roles ORDER BY sort_order")).map(r => r.name), ROLES);
    await rejects(api.setRole(tok, "student", "Superuser"), "VALIDATION");
    await assert.rejects(db.query("UPDATE users SET role = 'Superuser' WHERE username = 'student'"), "the database refuses unknown roles too");
  });
  test("Rule: an Admin cannot change their own role", async () => {
    await login("admin");
    await rejects(api.setRole(tok, "admin", "Student"), "VALIDATION");
    assert.equal((await api.me(tok)).role, "Admin");
  });
});

describe("US3 — Facility Inventory Management", () => {
  const base = { name: "E120 Classroom", type: "Classroom", capacity: "40", building: "Block E", floor: "1", equipment: ["Projector", "Whiteboard"], status: "Active" };
  test("Scenario 1: Admin creates a classroom (capacity 40); it is stored and appears in search as Active", async () => {
    await login("admin");
    const f = await api.saveFacility(tok, base);
    assert.match(f.id, /^F-\d{3}$/);
    assert.equal((await rows("SELECT capacity FROM facilities WHERE id = $1", [f.id]))[0].capacity, 40, "stored in the facilities table");
    const hit = (await api.search(tok, { q: "E120" })).results[0];
    assert.equal(hit.id, f.id); assert.equal(hit.status, "Active"); assert.equal(hit.capacity, 40);
  });
  test("Scenario 2: Facility Manager changes a lab from 25 to 30 seats; search and recommendations reflect it", async () => {
    await login("manager");
    const lab = (await api.listFacilities(tok)).find(f => f.name.startsWith("E104"));
    assert.equal(lab.capacity, 25);
    await api.saveFacility(tok, { ...lab, capacity: "30" });
    assert.equal((await rows("SELECT capacity FROM facilities WHERE id = $1", [lab.id]))[0].capacity, 30);
    assert.ok((await api.search(tok, { type: "Laboratory", capMin: 30 })).results.some(f => f.id === lab.id), "search");
    const rec = await api.recommend(tok, { capacity: 30, equipment: ["Computers"], start: at(1, 9), end: at(1, 10) });
    assert.equal(rec.results[0].id, lab.id, "recommendations");
  });
  test("Scenario 3: deleting a facility with future bookings is blocked and the conflicts are listed", async () => {
    await login("admin");
    const room = (await api.listFacilities(tok)).find(f => f.name === "D101");
    const e = await rejects(api.deleteFacility(tok, room.id), "HAS_BOOKINGS");
    assert.ok(e.extra.conflicts.length >= 1);
    assert.match(e.extra.conflicts[0].id, /^REQ-\d{4}-\d{4}$/);
    assert.ok((await api.listFacilities(tok)).some(f => f.id === room.id), "still exists");
  });
  test("Rule: only an Admin can force-delete; bookings are then cancelled and the action audited", async () => {
    await login("manager");
    const room = (await api.listFacilities(tok)).find(f => f.name === "D101");
    await rejects(api.deleteFacility(tok, room.id, { force: true }), "ACCESS_DENIED");
    await login("admin");
    const r = await api.deleteFacility(tok, room.id, { force: true });
    assert.equal(r.cancelled, 1);
    assert.ok(!(await api.listFacilities(tok)).some(f => f.id === room.id));
    assert.equal((await rows("SELECT status FROM bookings WHERE facility_name = $1", [room.name]))[0].status, "Cancelled");
    assert.equal((await api.logs(tok)).audit[0].action, "Facility force-deleted");
  });
  test("Scenario 4: a Student who tries to open the page or call the update API gets 'Access Denied'", async () => {
    await login("student");
    const before = (await rows("SELECT count(*)::int AS n FROM facilities"))[0].n;
    assert.equal((await rejects(api.listFacilities(tok), "ACCESS_DENIED")).message, "Access Denied");
    await rejects(api.saveFacility(tok, base), "ACCESS_DENIED");
    await rejects(api.saveFacility(tok, { ...base, id: "F-001" }), "ACCESS_DENIED");
    await rejects(api.deleteFacility(tok, "F-001"), "ACCESS_DENIED");
    assert.equal((await rows("SELECT count(*)::int AS n FROM facilities"))[0].n, before, "nothing changed");
  });
  test("Rule: capacity must be a positive integer (non-numeric values are rejected)", async () => {
    await login("admin");
    for (const bad of ["abc", "", "0", "-5", "12.5", "40 seats"]) await rejects(api.saveFacility(tok, { ...base, capacity: bad }), "VALIDATION");
  });
  test("Rule: name, type, capacity and building are required; types and statuses come from fixed lists", async () => {
    await login("admin");
    await rejects(api.saveFacility(tok, { ...base, name: " " }), "VALIDATION");
    await rejects(api.saveFacility(tok, { ...base, building: "" }), "VALIDATION");
    await rejects(api.saveFacility(tok, { ...base, type: "Gym" }), "VALIDATION");
    await rejects(api.saveFacility(tok, { ...base, status: "Closed" }), "VALIDATION");
    assert.deepEqual(TYPES, ["Classroom", "Laboratory", "Conference Room", "Other"]);
    assert.deepEqual(STATUSES, ["Active", "Under Maintenance", "Inactive"]);
  });
  test("Rule: equipment is structured (only values from the equipment table are stored)", async () => {
    await login("admin");
    const f = await api.saveFacility(tok, { ...base, equipment: ["Projector", "Jacuzzi"] });
    assert.deepEqual(f.equipment, ["Projector"]);
    assert.deepEqual((await rows("SELECT equipment FROM facility_equipment WHERE facility_id = $1", [f.id])).map(r => r.equipment), ["Projector"]);
  });
  test("Rule: all changes are recorded in the audit log", async () => {
    await login("manager");
    const f = await api.saveFacility(tok, base);
    await api.saveFacility(tok, { ...f, status: "Under Maintenance" });
    await api.deleteFacility(tok, f.id);
    await login("admin");
    const actions = (await api.logs(tok)).audit.map(a => a.action);
    for (const a of ["Facility created", "Facility updated", "Facility deleted"]) assert.ok(actions.includes(a), a);
  });
  test("Rule: Inactive facilities are hidden from search", async () => {
    await login("manager");
    const f = await api.saveFacility(tok, { ...base, name: "Old Annex", status: "Inactive" });
    assert.ok(!(await api.search(tok, { q: "Old Annex" })).results.some(x => x.id === f.id));
  });
});

describe("US4 — Search & Browse Facilities", () => {
  test("Scenario 1: capacity ≥ 30 and type = Classroom returns only such classrooms, sorted by name", async () => {
    await login("student");
    assert.ok((await rows("SELECT count(*)::int AS n FROM facilities"))[0].n >= 10, "at least 10 facilities exist");
    const { results } = await api.search(tok, { capMin: 30, type: "Classroom" });
    assert.ok(results.length >= 3);
    assert.ok(results.every(f => f.type === "Classroom" && f.capacity >= 30));
    assert.deepEqual(results.map(f => f.name), results.map(f => f.name).slice().sort((a, b) => a.localeCompare(b)));
    const all = (await api.search(tok, {})).results.filter(f => f.type === "Classroom" && f.capacity >= 30);
    assert.equal(results.length, all.length, "no matching classroom is missing");
  });
  test("Scenario 2: the Projector filter returns only rooms that list a Projector", async () => {
    await login("faculty");
    const all = (await api.search(tok, {})).results;
    assert.ok(all.some(f => !f.equipment.includes("Projector")), "some rooms have no projector");
    const { results } = await api.search(tok, { equipment: ["Projector"] });
    assert.ok(results.length > 0 && results.every(f => f.equipment.includes("Projector")));
    assert.equal(results.length, all.filter(f => f.equipment.includes("Projector")).length);
  });
  test("Scenario 3: no match shows 'No facilities match your criteria' and suggests relaxations", async () => {
    await login("student");
    const r = await api.search(tok, { type: "Conference Room", capMin: 100, equipment: ["Fume hood"] });
    assert.equal(r.results.length, 0);
    assert.equal(r.message, "No facilities match your criteria");
    assert.ok(r.suggestions.length > 0);
    for (const s of r.suggestions) {
      assert.ok(s.count > 0);
      const relaxed = await api.search(tok, { type: "Conference Room", capMin: 100, equipment: ["Fume hood"], ...s.patch });
      assert.equal(relaxed.results.length, s.count, `"${s.label}" really returns ${s.count}`);
    }
  });
  test("Rule: all filters work: capacity range, building, floor, availability window", async () => {
    await login("student");
    const range = (await api.search(tok, { capMin: 25, capMax: 40 })).results;
    assert.ok(range.length && range.every(f => f.capacity >= 25 && f.capacity <= 40));
    const b = (await api.search(tok, { building: "Block G" })).results;
    assert.ok(b.length && b.every(f => f.building === "Block G"));
    const fl = (await api.search(tok, { floor: "2" })).results;
    assert.ok(fl.length && fl.every(f => f.floor === 2));
    // D101 has an approved exam 14:00-16:00 three weekdays from now
    const busy = (await api.search(tok, { q: "D101", start: at(3, 15), end: at(3, 16) })).results;
    assert.equal(busy.length, 0, "a booked room is not offered for an overlapping window");
    const free = (await api.search(tok, { q: "D101", start: at(3, 16), end: at(3, 17) })).results;
    assert.equal(free.length, 1, "free right after the booking ends");
    await rejects(api.search(tok, { start: at(3, 16), end: at(3, 15) }), "VALIDATION");
  });
  test("Rule: results carry the key attributes and the current availability status", async () => {
    await login("student");
    const { results } = await api.search(tok, {});
    for (const k of ["name", "type", "capacity", "building", "floor", "equipment", "status"]) assert.ok(k in results[0], k);
    const mb105 = results.find(f => f.name.startsWith("E113"));
    assert.ok(mb105.busyUntil, "the room in use right now shows when it becomes free");
    assert.equal(results.find(f => f.name.startsWith("I305")).status, "Under Maintenance");
  });
  test("Rule: clicking a result opens the facility detail with its schedule", async () => {
    await login("student");
    const d = await api.facility(tok, await idOf("D101"));
    assert.equal(d.name, "D101");
    assert.ok(d.schedule.length >= 1);
    assert.equal(d.schedule[0].purpose, null, "students do not see other people's booking purposes");
  });
  test("Rule: search responds within 2 seconds", async () => {
    await login("student");
    const t0 = Date.now();
    await api.search(tok, { capMin: 10, equipment: ["Projector", "Whiteboard"], start: at(1, 9), end: at(1, 11), q: "room" });
    assert.ok(Date.now() - t0 < 2000);
  });
});

describe("US5 — Request Facility Allocation", () => {
  test("Scenario 1: Faculty submits a valid request; it is saved as Pending and a request ID is returned", async () => {
    await login("faculty");
    const b = await api.createBooking(tok, { facilityId: await idOf("G113"), start: at(2, 9), end: at(2, 11), purpose: "Algorithms lecture", attendees: 35 });
    assert.match(b.id, /^REQ-\d{4}-\d{4}$/);
    assert.equal(b.status, "Pending");
    const [row] = await rows("SELECT status, username FROM bookings WHERE id = $1", [b.id]);
    assert.equal(row.status, "Pending");
    assert.equal(row.username, "faculty", "linked to the authenticated user");
  });
  test("Scenario 2: a Student asking for 4 hours is rejected with the duration limit explained", async () => {
    await login("student");
    const e = await rejects(api.createBooking(tok, { facilityId: await idOf("D102"), start: at(2, 9), end: at(2, 13), purpose: "Hackathon", attendees: 10 }), "POLICY");
    assert.match(e.message, /at most 2 hours/);
    await rejects(api.createBooking(tok, { facilityId: await idOf("D102"), start: at(2, 9), end: at(2, 17), purpose: "All day", attendees: 10 }), "POLICY");
  });
  test("Scenario 3: end time before start time is not accepted", async () => {
    await login("student");
    const e = await rejects(api.createBooking(tok, { facilityId: await idOf("D102"), start: at(2, 11), end: at(2, 10), purpose: "Study", attendees: 3 }), "VALIDATION");
    assert.match(e.message, /End time must be after the start time/);
  });
  test("Rule: start, end, purpose and attendees are required", async () => {
    await login("faculty");
    const ok = { facilityId: await idOf("D102"), start: at(2, 9), end: at(2, 10), purpose: "Seminar", attendees: 20 };
    for (const k of ["start", "end", "purpose", "attendees"]) await rejects(api.createBooking(tok, { ...ok, [k]: "" }), "VALIDATION");
    await rejects(api.createBooking(tok, { ...ok, attendees: "many" }), "VALIDATION");
    await rejects(api.createBooking(tok, { ...ok, start: new Date(clock - 3600e3).toISOString(), end: new Date(clock).toISOString() }), "VALIDATION");
  });
  test("Rule: duration limits are role-based and configurable in the database", async () => {
    await db.query("UPDATE roles SET max_minutes = 240 WHERE name = 'Student'");
    await login("student");
    const b = await api.createBooking(tok, { facilityId: await idOf("D102"), start: at(2, 9), end: at(2, 13), purpose: "Hackathon", attendees: 10 });
    assert.equal(b.status, "Pending");
  });
  test("Rule: a room that is already requested or booked for that time cannot be requested again", async () => {
    await login("faculty2");
    const e = await rejects(api.createBooking(tok, { facilityId: await idOf("D101"), start: at(3, 15), end: at(3, 17), purpose: "Tutorial", attendees: 20 }), "CONFLICT");
    assert.equal(e.extra.conflicts.length, 1);
  });
  test("Rule: the group must fit the room and the room must be in service", async () => {
    await login("faculty");
    await rejects(api.createBooking(tok, { facilityId: await idOf("E205"), start: at(2, 9), end: at(2, 10), purpose: "Meeting", attendees: 20 }), "CAPACITY");
    await rejects(api.createBooking(tok, { facilityId: await idOf("I305"), start: at(2, 9), end: at(2, 10), purpose: "Match", attendees: 20 }), "VALIDATION");
  });
  test("Rule: leaving the facility blank books the top recommendation", async () => {
    await login("faculty");
    const b = await api.createBooking(tok, { start: at(2, 9), end: at(2, 10), purpose: "Office hours", attendees: 12, equipment: ["Smart display"] });
    assert.equal(b.recommended, true);
    const f = await api.facility(tok, b.facilityId);
    assert.ok(f.capacity >= 12 && f.equipment.includes("Smart display"));
  });
  test("Rule: users see only their own requests unless they are Admin or Facility Manager", async () => {
    await login("student");
    const mine = await api.listBookings(tok, { all: true });
    assert.ok(mine.length > 0 && mine.every(b => b.username === "student"), "a student cannot list everyone's requests");
    await login("manager");
    const all = await api.listBookings(tok, { all: true });
    assert.ok(new Set(all.map(b => b.username)).size > 2);
  });
});

describe("US6 — Intelligent Room Recommendations", () => {
  test("Scenario 1: capacity ≥ 35 + Projector returns only free rooms that qualify, ranked by match", async () => {
    await login("faculty");
    // F113 (lecture hall, projector) has an approved lecture at this time and must not be recommended
    const r = await api.recommend(tok, { capacity: 35, equipment: ["Projector"], start: at(2, 10), end: at(2, 11) });
    assert.ok(r.results.length >= 3);
    for (const f of r.results) {
      assert.ok(f.capacity >= 35, f.name); assert.ok(f.equipment.includes("Projector"), f.name);
      assert.equal(f.status, "Active");
    }
    assert.ok(!r.results.some(f => f.name.startsWith("F113")), "booked room excluded");
    const scores = r.results.map(f => f.score);
    assert.deepEqual(scores, scores.slice().sort((a, b) => b - a), "ranked by score");
    assert.ok(r.results[0].reasons.length > 0, "each recommendation explains itself");
    const small = await api.recommend(tok, { capacity: 25, equipment: ["Projector"], start: at(2, 10), end: at(2, 11) });
    assert.equal(small.results[0].capacity, Math.min(...small.results.map(f => f.capacity)), "the closest fit ranks first");
  });
  test("Scenario 2: no suitable room gives a clear 'No match' message and relaxation suggestions", async () => {
    await login("student");
    const r = await api.recommend(tok, { capacity: 50, equipment: ["Fume hood"], start: at(2, 10), end: at(2, 11) });
    assert.equal(r.results.length, 0);
    assert.match(r.message, /No match/);
    assert.ok(r.suggestions.length > 0);
    const s = r.suggestions[0];
    const relaxed = await api.recommend(tok, { capacity: 50, equipment: ["Fume hood"], start: at(2, 10), end: at(2, 11), ...s.patch, capacity: s.patch.capMin || 50 });
    assert.ok(relaxed.results.length > 0, `"${s.label}" leads to a result`);
  });
  test("Scenario 3: the preferred building is ranked higher between equally suitable rooms", async () => {
    await login("student2"); // no booking history
    const req = { capacity: 30, equipment: ["Projector", "Whiteboard"], start: at(2, 13), end: at(2, 14) };
    const eb = await api.recommend(tok, { ...req, building: "Block E" });
    const db_ = await api.recommend(tok, { ...req, building: "Block D" });
    // D201 and E201 are identical 30-seat classrooms in different blocks (not in the top 10 = ranked lower)
    const pos = (r, code) => { const i = r.results.findIndex(f => f.name === code); return i < 0 ? Infinity : i; };
    assert.ok(pos(eb, "E201") < pos(eb, "D201"));
    assert.ok(pos(db_, "D201") < pos(db_, "E201"));
  });
  test("Rule: a room of capacity 20 is never recommended for 50 attendees, and required equipment is never missing", async () => {
    await login("faculty");
    const r = await api.recommend(tok, { capacity: 50, equipment: ["Video conferencing"], start: at(4, 9), end: at(4, 10) });
    assert.ok(r.results.length > 0 && r.results.every(f => f.capacity >= 50 && f.equipment.includes("Video conferencing")));
  });
  test("Rule: historical preference raises the score of rooms the user booked before", async () => {
    await login("faculty"); // faculty booked F113 twice in the past
    const r = await api.recommend(tok, { capacity: 45, equipment: ["Projector"], start: at(4, 9), end: at(4, 10) });
    const eb215 = r.results.find(f => f.name.startsWith("F113"));
    assert.ok(eb215.reasons.some(x => /booked this room before/.test(x)));
    assert.equal(r.results[0].id, eb215.id);
  });
  test("Rule: inputs are validated and the response is fast", async () => {
    await login("faculty");
    await rejects(api.recommend(tok, { capacity: 0, start: at(2, 9), end: at(2, 10) }), "VALIDATION");
    await rejects(api.recommend(tok, { capacity: 10 }), "VALIDATION");
    const r = await api.recommend(tok, { capacity: 10, start: at(2, 9), end: at(2, 10) });
    assert.ok(r.ms < 3000);
  });
});

describe("HTTP API — role checks are enforced at the API level", () => {
  let server, base;
  before(async () => { server = buildApp(createService({ db, now: () => clock })).listen(0); base = `http://127.0.0.1:${server.address().port}`; });
  after(() => server.close());
  const call = (method, p, token, body) => fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });

  test("a Student calling the admin and facility APIs gets 403 Access Denied", async () => {
    const { token } = await (await call("POST", "/api/login", null, { username: "student", password: PW })).json();
    for (const [m, p] of [["GET", "/api/users"], ["PUT", "/api/users/student/role"], ["POST", "/api/facilities"], ["PUT", "/api/facilities/F-001"], ["DELETE", "/api/facilities/F-001"]]) {
      const r = await call(m, p, token, m === "GET" || m === "DELETE" ? undefined : { role: "Admin" });
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal((await r.json()).message, "Access Denied");
    }
  });
  test("wrong password → 401 with the agreed message; no token → 401", async () => {
    const r = await call("POST", "/api/login", null, { username: "student", password: "nope" });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).message, "Invalid username or password");
    assert.equal((await call("GET", "/api/search")).status, 401);
  });
  test("server code, data and secrets are not served to the browser", async () => {
    for (const p of ["/server/service.js", "/.env", "/data/pg", "/package.json", "/node_modules/pg/package.json"]) assert.equal((await call("GET", p)).status, 404, p);
    assert.equal((await call("GET", "/")).status, 200);
  });
});
