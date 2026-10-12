/* Business logic for user stories 1-6. Every public method checks the session and the role first (RBAC on the backend),
   then validates input, then reads/writes PostgreSQL. server.js maps these methods to HTTP endpoints; the QA tests call
   them directly. Pass { now } to control the clock in tests. */
"use strict";
const crypto = require("crypto");
const SSO = require("./sso");
const seedData = require("./seed");

const ROLES = ["Student", "Faculty", "Facility Manager", "Admin"];
const TYPES = ["Classroom", "Laboratory", "Conference Room", "Other"];
const STATUSES = ["Active", "Under Maintenance", "Inactive"];
const STAFF = ["Admin", "Facility Manager"];
const SESSION_MINUTES = 30, MAX_FAILS = 5, LOCK_SECONDS = 60;
const ACTIVE = "('Pending', 'Approved')"; // bookings that hold a room and count towards the limit

class ApiError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; this.extra = extra; }
}
const fail = (code, msg, extra) => { throw new ApiError(code, msg, extra); };
const hash = t => crypto.createHash("sha256").update(t).digest("hex");
const str = v => String(v == null ? "" : v).trim();
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
const fmtMinutes = m => m % 60 === 0 ? plural(m / 60, "hour") : m < 60 ? plural(m, "minute") : `${Math.floor(m / 60)} h ${m % 60} min`;
const list = v => (Array.isArray(v) ? v : str(v) ? str(v).split(",") : []).map(str).filter(Boolean);
const posInt = v => { const s = str(v); return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null; };
const time = v => { const s = str(v); if (!s) return null; const d = new Date(s); return isNaN(d) ? fail("VALIDATION", "Enter a valid date and time.") : d; };
const likeEsc = s => s.replace(/[\\%_]/g, c => "\\" + c);

function createService(opts) {
  const db = opts.db;
  const now = opts.now || (() => Date.now());
  const nowDate = () => new Date(now());
  let ssoDown = false;

  const q = (sql, params) => db.query(sql, params).then(r => r.rows);
  const one = (sql, params) => q(sql, params).then(r => r[0]);
  const audit = (who, action, detail, t) => (t || db).query("INSERT INTO audit_log (ts, username, action, detail) VALUES ($1,$2,$3,$4)", [nowDate(), who, action, detail]);
  const logLogin = (username, ok, detail) => db.query("INSERT INTO login_log (ts, username, ok, detail) VALUES ($1,$2,$3,$4)", [nowDate(), username, ok, detail]);
  const policyOf = role => one("SELECT max_active, max_minutes FROM roles WHERE name = $1", [role]);

  /* Session + role check used by every endpoint. Throws UNAUTH, EXPIRED or ACCESS_DENIED. */
  async function auth(token, ...roles) {
    if (!token) fail("UNAUTH", "Please log in.");
    const h = hash(String(token));
    const s = await one("SELECT s.username, s.role, s.last_seen, u.name, u.email FROM sessions s JOIN users u USING (username) WHERE s.token_hash = $1", [h]);
    if (!s) fail("UNAUTH", "Please log in.");
    if (now() - new Date(s.last_seen).getTime() > SESSION_MINUTES * 60000) {
      await db.query("DELETE FROM sessions WHERE token_hash = $1", [h]);
      fail("EXPIRED", "Session expired, please log in again");
    }
    if (roles.length && !roles.includes(s.role)) fail("ACCESS_DENIED", "Access Denied");
    await db.query("UPDATE sessions SET last_seen = $2 WHERE token_hash = $1", [h, nowDate()]);
    return { username: s.username, role: s.role, name: s.name, email: s.email, tokenHash: h };
  }

  /* ---------- facilities: shared query used by search (US4), recommendations (US6) and inventory (US3) ---------- */
  function facilityQuery(f, mode) {
    const p = [], add = v => { p.push(v); return "$" + p.length; };
    const where = [f.includeInactive ? "TRUE" : "f.status <> 'Inactive'"];
    if (f.id) where.push(`f.id = ${add(f.id)}`);
    if (f.text) {
      const t = add("%" + likeEsc(f.text) + "%");
      where.push(`((f.name || ' ' || f.type || ' ' || f.building) ILIKE ${t} OR EXISTS (SELECT 1 FROM facility_equipment x WHERE x.facility_id = f.id AND x.equipment ILIKE ${t}))`);
    }
    if (f.type) where.push(`f.type = ${add(f.type)}`);
    if (f.building) where.push(`f.building = ${add(f.building)}`);
    if (f.floor != null) where.push(`f.floor = ${add(f.floor)}`);
    if (f.capMin) where.push(`f.capacity >= ${add(f.capMin)}`);
    if (f.capMax) where.push(`f.capacity <= ${add(f.capMax)}`);
    if (f.equipment && f.equipment.length)
      where.push(`(SELECT count(*) FROM facility_equipment x WHERE x.facility_id = f.id AND x.equipment = ANY(${add(f.equipment)}::text[])) = ${add(f.equipment.length)}`);
    if (f.start && f.end)
      where.push(`f.status = 'Active' AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.facility_id = f.id AND b.status IN ${ACTIVE} AND b.start_ts < ${add(f.end)} AND b.end_ts > ${add(f.start)})`);
    if (mode === "count") return [`SELECT count(*)::int AS n FROM facilities f WHERE ${where.join(" AND ")}`, p];
    const n = add(nowDate());
    const order = f.text ? `(f.name ILIKE ${add(likeEsc(f.text) + "%")}) DESC, f.name` : "f.name";
    return [`SELECT f.id, f.name, f.type, f.capacity, f.building, f.floor, f.status,
        ARRAY(SELECT fe.equipment FROM facility_equipment fe JOIN equipment e ON e.name = fe.equipment WHERE fe.facility_id = f.id ORDER BY e.sort_order) AS equipment,
        (SELECT max(b.end_ts) FROM bookings b WHERE b.facility_id = f.id AND b.status = 'Approved' AND b.start_ts <= ${n} AND b.end_ts > ${n}) AS busy_until
      FROM facilities f WHERE ${where.join(" AND ")} ORDER BY ${order}`, p];
  }
  const toFacility = r => ({ id: r.id, name: r.name, type: r.type, capacity: r.capacity, building: r.building, floor: r.floor, status: r.status,
    equipment: r.equipment || [], busyUntil: r.busy_until ? new Date(r.busy_until).toISOString() : null });
  const findFacilities = f => q(...facilityQuery(f)).then(rows => rows.map(toFacility));
  const countFacilities = f => one(...facilityQuery(f, "count")).then(r => r.n);
  const getFacilityRow = (id, includeInactive) => findFacilities({ id, includeInactive: includeInactive !== false }).then(r => r[0]);

  async function futureBookingsOf(id, t) {
    return (await (t || db).query(
      `SELECT b.id, b.start_ts, b.end_ts, b.status, u.name AS user_name FROM bookings b JOIN users u USING (username)
       WHERE b.facility_id = $1 AND b.status IN ${ACTIVE} AND b.end_ts > $2 ORDER BY b.start_ts`, [id, nowDate()])).rows
      .map(b => ({ id: b.id, start: new Date(b.start_ts).toISOString(), end: new Date(b.end_ts).toISOString(), status: b.status, user: b.user_name }));
  }

  /* Validates and normalises search filters (US4) */
  function searchFilters(input) {
    const i = input || {}, f = { text: str(i.q), type: str(i.type), building: str(i.building), equipment: list(i.equipment) };
    if (f.type && !TYPES.includes(f.type)) fail("VALIDATION", "Unknown facility type.");
    const fl = str(i.floor);
    if (fl) { if (!/^-?\d+$/.test(fl)) fail("VALIDATION", "Floor must be a whole number."); f.floor = Number(fl); }
    for (const k of ["capMin", "capMax"]) if (str(i[k])) { f[k] = posInt(i[k]); if (!f[k]) fail("VALIDATION", "Capacity must be a whole number greater than 0."); }
    if (f.capMin && f.capMax && f.capMin > f.capMax) fail("VALIDATION", "Minimum capacity is larger than the maximum.");
    f.start = time(i.start); f.end = time(i.end);
    if (!!f.start !== !!f.end) fail("VALIDATION", "Choose both a start and an end time to check availability.");
    if (f.start && f.end <= f.start) fail("VALIDATION", "End time must be after the start time.");
    return f;
  }

  /* When nothing matches, try dropping one filter at a time and offer the ones that return rooms. */
  async function relaxations(f, kind) {
    const tries = [];
    for (const e of f.equipment) tries.push([`Remove "${e}"`, { equipment: f.equipment.filter(x => x !== e) }]);
    if (kind === "search") {
      if (f.capMin) tries.push(["Remove the minimum capacity", { capMin: null }]);
      if (f.capMax) tries.push(["Remove the maximum capacity", { capMax: null }]);
      if (f.type) tries.push(["Allow any type", { type: "" }]);
      if (f.building) tries.push(["Allow any building", { building: "" }]);
      if (f.floor != null) tries.push(["Allow any floor", { floor: null }]);
      if (f.start) tries.push(["Ignore the time window", { start: null, end: null }]);
      if (f.text) tries.push(["Clear the search text", { text: "" }]);
    } else {
      const len = f.end - f.start;
      const shift = (ms, label) => { const s = new Date(f.start.getTime() + ms); if (s > nowDate()) tries.push([label, { start: s, end: new Date(s.getTime() + len) }]); };
      shift(3600e3, "1 hour later"); shift(-3600e3, "1 hour earlier"); shift(86400e3, "Same time the next day");
      const bigger = await findFacilities({ ...f, capMin: null });
      const maxCap = bigger.reduce((m, r) => Math.max(m, r.capacity), 0);
      if (maxCap && maxCap < f.capMin) tries.push([`Lower the group size to ${maxCap}`, { capMin: maxCap }]);
    }
    /* One change at a time first; if none helps, pairs of changes; then "clear all filters". */
    const merge = (a, b) => ({ ...a, ...b, ...(a.equipment && b.equipment ? { equipment: a.equipment.filter(e => b.equipment.includes(e)) } : {}) });
    const out = [];
    const attempt = async (label, patch) => {
      const n = await countFacilities({ ...f, ...patch });
      if (n > 0) out.push({ label, count: n, patch: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k === "text" ? "q" : k, v instanceof Date ? v.toISOString() : v])) });
    };
    for (const [label, patch] of tries) await attempt(label, patch);
    if (!out.length && kind === "search") {
      for (let i = 0; i < tries.length; i++) for (let j = i + 1; j < tries.length; j++)
        await attempt(`${tries[i][0]} and ${tries[j][0].charAt(0).toLowerCase() + tries[j][0].slice(1)}`, merge(tries[i][1], tries[j][1]));
      if (!out.length && tries.length) await attempt("Clear all filters", { text: "", type: "", building: "", floor: null, capMin: null, capMax: null, equipment: [], start: null, end: null });
    }
    return out.sort((a, b) => b.count - a.count).slice(0, 5);
  }

  /* US6: rule-based scoring. capacity fit 45 + equipment 25 + location 20 + history 10 = 100. */
  async function rank(user, f, preferredBuilding) {
    const rooms = await findFacilities(f);
    const hist = await q(`SELECT b.facility_id, f.building, count(*)::int AS n FROM bookings b LEFT JOIN facilities f ON f.id = b.facility_id
                          WHERE b.username = $1 AND b.status IN ${ACTIVE} GROUP BY 1, 2`, [user]);
    const byRoom = {}, byBuilding = {};
    for (const h of hist) { byRoom[h.facility_id] = h.n; byBuilding[h.building] = (byBuilding[h.building] || 0) + h.n; }
    return rooms.map(r => {
      const fit = f.capMin / r.capacity, reasons = [];
      reasons.push(fit >= 0.75 ? `${r.capacity} seats for ${f.capMin} people: close fit` : `${r.capacity} seats for ${f.capMin} people: larger than needed`);
      if (f.equipment.length) reasons.push("Has " + f.equipment.join(", "));
      let loc = 1;
      if (preferredBuilding) {
        loc = r.building === preferredBuilding ? 1 : 0;
        reasons.push(loc ? `In ${r.building}, your preferred building` : `In ${r.building}, not your preferred building`);
      }
      const h = byRoom[r.id] ? 1 : byBuilding[r.building] ? 0.5 : 0;
      if (byRoom[r.id]) reasons.push(`You have booked this room before (${plural(byRoom[r.id], "time")})`);
      else if (h) reasons.push(`You often book in ${r.building}`);
      reasons.push("Free for the whole requested time");
      const score = Math.round(45 * fit + 25 + 20 * loc + 10 * h);
      return { ...r, score, reasons };
    }).sort((a, b) => b.score - a.score || a.capacity - b.capacity || a.name.localeCompare(b.name));
  }

  function recommendInput(i) {
    const f = { capMin: posInt(i.capacity), equipment: list(i.equipment), start: time(i.start), end: time(i.end) };
    if (!f.capMin) fail("VALIDATION", "Enter how many people the room must hold (a whole number greater than 0).");
    if (!f.start || !f.end) fail("VALIDATION", "Choose the date, start time and end time.");
    if (f.end <= f.start) fail("VALIDATION", "End time must be after the start time.");
    return f;
  }

  const toBooking = r => ({ id: r.id, facilityId: r.facility_id, facilityName: r.facility_name, building: r.building || null, username: r.username, userName: r.user_name,
    start: new Date(r.start_ts).toISOString(), end: new Date(r.end_ts).toISOString(), purpose: r.purpose, attendees: r.attendees, status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    decidedBy: r.decided_by_name || r.decided_by || null, decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null, note: r.decision_note || null });
  const BOOKING_SELECT = `SELECT b.*, u.name AS user_name, f.building, d.name AS decided_by_name FROM bookings b JOIN users u USING (username)
    LEFT JOIN facilities f ON f.id = b.facility_id LEFT JOIN users d ON d.username = b.decided_by`;

  const api = {
    /* ===================== US1: Login & Authentication ===================== */
    async login(username, password) {
      username = str(username).toLowerCase();
      if (!username || !password) fail("VALIDATION", "Enter your username and password.");
      if (ssoDown) { await logLogin(username, false, "SSO unavailable"); fail("SSO_DOWN", "The university sign-in service is unavailable. Try again in a few minutes."); }
      const lock = await one("SELECT fails, locked_until FROM login_locks WHERE username = $1", [username]);
      if (lock && lock.locked_until && new Date(lock.locked_until).getTime() > now()) {
        await logLogin(username, false, "Blocked by rate limit");
        fail("RATE_LIMIT", `Too many failed attempts. Try again in ${Math.ceil((new Date(lock.locked_until).getTime() - now()) / 1000)} seconds.`);
      }
      const acc = SSO.verify(username, String(password));
      if (!acc) {
        const fails = (lock ? lock.fails : 0) + 1, locked = fails >= MAX_FAILS;
        await db.query(`INSERT INTO login_locks (username, fails, locked_until) VALUES ($1,$2,$3)
                        ON CONFLICT (username) DO UPDATE SET fails = EXCLUDED.fails, locked_until = EXCLUDED.locked_until`,
          [username, locked ? 0 : fails, locked ? new Date(now() + LOCK_SECONDS * 1000) : null]);
        await logLogin(username, false, "Invalid credentials");
        if (locked) await logLogin(username, false, `Locked for ${LOCK_SECONDS} s after ${MAX_FAILS} failed attempts`);
        fail("INVALID", "Invalid username or password");
      }
      await db.query("DELETE FROM login_locks WHERE username = $1", [username]);
      /* First sign-in creates the user with the default role. The role is read here and fixed for this session (US2). */
      const u = await one(`INSERT INTO users (username, name, email, role) VALUES ($1,$2,$3,'Student')
                           ON CONFLICT (username) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email RETURNING username, name, email, role`,
        [username, acc.name, acc.email]);
      const token = crypto.randomBytes(32).toString("hex");
      await db.query("DELETE FROM sessions WHERE last_seen < $1", [new Date(now() - SESSION_MINUTES * 60000)]);
      await db.query("INSERT INTO sessions (token_hash, username, role, created_at, last_seen) VALUES ($1,$2,$3,$4,$4)", [hash(token), u.username, u.role, nowDate()]);
      await logLogin(username, true, "Signed in as " + u.role);
      return { redirect: "dashboard", token, user: { username: u.username, name: u.name, role: u.role } };
    },
    async logout(token) {
      if (token) {
        const s = await one("DELETE FROM sessions WHERE token_hash = $1 RETURNING username", [hash(String(token))]);
        if (s) await logLogin(s.username, true, "Logged out");
      }
      return { redirect: "login" };
    },
    async me(token) {
      const s = await auth(token), p = await policyOf(s.role);
      const { n } = await one(`SELECT count(*)::int AS n FROM bookings WHERE username = $1 AND status IN ${ACTIVE} AND end_ts > $2`, [s.username, nowDate()]);
      return { username: s.username, name: s.name, email: s.email, role: s.role, limits: { active: n, maxActive: p.max_active, maxMinutes: p.max_minutes } };
    },

    /* ===================== US2: User Role Management ===================== */
    async listUsers(token) {
      await auth(token, "Admin");
      return q(`SELECT u.username, u.name, u.email, u.role, r.max_active AS "maxActive", r.max_minutes AS "maxMinutes"
                FROM users u JOIN roles r ON r.name = u.role ORDER BY r.sort_order, u.username`);
    },
    async setRole(token, username, role) {
      const s = await auth(token, "Admin");
      if (!ROLES.includes(role)) fail("VALIDATION", "Unknown role.");
      if (username === s.username) fail("VALIDATION", "You cannot change your own role. Ask another Admin.");
      const u = await one("SELECT username, name, role FROM users WHERE username = $1", [username]);
      if (!u) fail("NOT_FOUND", "User not found.");
      if (u.role === role) return u;
      await db.query("UPDATE users SET role = $2 WHERE username = $1", [username, role]);
      await audit(s.username, "Role changed", `${username}: ${u.role} → ${role}`);
      return { ...u, role };
    },
    async policy() { return q(`SELECT name AS role, max_active AS "maxActive", max_minutes AS "maxMinutes" FROM roles ORDER BY sort_order`); },
    async logs(token) {
      await auth(token, "Admin");
      return {
        audit: await q("SELECT ts, username AS user, action, detail FROM audit_log ORDER BY id DESC LIMIT 50"),
        loginLog: await q("SELECT ts, username, ok, detail FROM login_log ORDER BY id DESC LIMIT 50")
      };
    },

    /* ===================== US3: Facility Inventory Management ===================== */
    async listFacilities(token) { await auth(token, ...STAFF); return findFacilities({ includeInactive: true }); },
    async saveFacility(token, d) {
      const s = await auth(token, ...STAFF);
      d = d || {};
      const name = str(d.name), building = str(d.building), cap = str(d.capacity), floor = str(d.floor);
      if (!name) fail("VALIDATION", "Name is required.");
      if (!TYPES.includes(d.type)) fail("VALIDATION", "Choose a facility type.");
      if (!posInt(cap)) fail("VALIDATION", "Capacity must be a whole number greater than 0.");
      if (!building) fail("VALIDATION", "Building is required.");
      if (floor && !/^-?\d+$/.test(floor)) fail("VALIDATION", "Floor must be a whole number.");
      if (!STATUSES.includes(d.status)) fail("VALIDATION", "Choose a status.");
      const known = (await q("SELECT name FROM equipment ORDER BY sort_order")).map(r => r.name);
      const rec = { name, type: d.type, capacity: Number(cap), building, floor: floor ? Number(floor) : 0, status: d.status, equipment: known.filter(e => list(d.equipment).includes(e)) };
      const clash = await one("SELECT id FROM facilities WHERE lower(name) = lower($1) AND id <> $2", [name, d.id || ""]);
      if (clash) fail("VALIDATION", "A facility with this name already exists.");
      const old = d.id ? await getFacilityRow(d.id) : null;
      if (d.id && !old) fail("NOT_FOUND", "Facility not found.");
      return db.tx(async t => {
        let id = d.id, action, detail, cancelled = 0;
        if (id) {
          /* Bookings this edit would make invalid: all of them if the room leaves service, else those larger than the new capacity. */
          await t.query("SELECT id FROM facilities WHERE id = $1 FOR UPDATE", [id]);
          const hit = (await t.query(`SELECT b.id, b.start_ts, b.end_ts, b.status, b.attendees, u.name AS user_name FROM bookings b JOIN users u USING (username)
              WHERE b.facility_id = $1 AND b.status IN ${ACTIVE} AND b.end_ts > $2 AND ($3 OR b.attendees > $4) ORDER BY b.start_ts`,
            [id, nowDate(), rec.status !== "Active", rec.capacity])).rows;
          if (hit.length) {
            const why = rec.status !== "Active" ? `setting it to ${rec.status}` : `reducing it to ${rec.capacity} seats`;
            if (!d.force) fail("HAS_BOOKINGS", `${plural(hit.length, "future booking")} would become invalid by ${why}.`,
              { conflicts: hit.map(b => ({ id: b.id, start: new Date(b.start_ts).toISOString(), end: new Date(b.end_ts).toISOString(), status: b.status, user: b.user_name, attendees: b.attendees })) });
            if (s.role !== "Admin") fail("ACCESS_DENIED", "Access Denied");
            await t.query("UPDATE bookings SET status = 'Cancelled' WHERE id = ANY($1)", [hit.map(b => b.id)]);
            cancelled = hit.length;
          }
          await t.query("UPDATE facilities SET name=$2, type=$3, capacity=$4, building=$5, floor=$6, status=$7 WHERE id=$1", [id, rec.name, rec.type, rec.capacity, rec.building, rec.floor, rec.status]);
          await t.query("DELETE FROM facility_equipment WHERE facility_id = $1", [id]);
          const changes = Object.keys(rec).filter(k => JSON.stringify(old[k]) !== JSON.stringify(rec[k]))
            .map(k => `${k}: ${[].concat(old[k]).join(", ") || "—"} → ${[].concat(rec[k]).join(", ") || "—"}`);
          action = changes.length ? "Facility updated" : null;
          detail = `${id} ${rec.name} · ${changes.join("; ")}` + (cancelled ? ` · ${plural(cancelled, "booking")} cancelled` : "");
        } else {
          id = (await t.query(`INSERT INTO facilities (id, name, type, capacity, building, floor, status)
                VALUES ('F-' || lpad(nextval('facility_seq')::text, 3, '0'), $1,$2,$3,$4,$5,$6) RETURNING id`,
            [rec.name, rec.type, rec.capacity, rec.building, rec.floor, rec.status])).rows[0].id;
          action = "Facility created"; detail = `${id} ${rec.name} · ${rec.type}, ${rec.capacity} seats, ${rec.building}`;
        }
        for (const e of rec.equipment) await t.query("INSERT INTO facility_equipment (facility_id, equipment) VALUES ($1,$2)", [id, e]);
        if (action) await audit(s.username, action, detail, t);
        return { id, ...rec, cancelled };
      });
    },
    async futureBookings(token, id) { await auth(token, ...STAFF); return futureBookingsOf(id); },
    async deleteFacility(token, id, o) {
      const s = await auth(token, ...STAFF), force = !!(o && o.force);
      return db.tx(async t => {
        const f = (await t.query("SELECT id, name FROM facilities WHERE id = $1 FOR UPDATE", [id])).rows[0];
        if (!f) fail("NOT_FOUND", "Facility not found.");
        const conflicts = await futureBookingsOf(id, t);
        if (conflicts.length && !force) fail("HAS_BOOKINGS", `${f.name} cannot be deleted: it has ${plural(conflicts.length, "future booking")}.`, { conflicts });
        if (conflicts.length && s.role !== "Admin") fail("ACCESS_DENIED", "Access Denied");
        await t.query(`UPDATE bookings SET status = 'Cancelled' WHERE facility_id = $1 AND status IN ${ACTIVE} AND end_ts > $2`, [id, nowDate()]);
        await t.query("DELETE FROM facilities WHERE id = $1", [id]);
        await audit(s.username, conflicts.length ? "Facility force-deleted" : "Facility deleted",
          `${f.id} ${f.name}` + (conflicts.length ? ` · ${plural(conflicts.length, "booking")} cancelled` : ""), t);
        return { deleted: f.id, cancelled: conflicts.length };
      });
    },

    /* ===================== US4: Search & Browse Facilities ===================== */
    async search(token, input) {
      await auth(token);
      const f = searchFilters(input), t0 = Date.now();
      const results = await findFacilities(f);
      return { results, suggestions: results.length ? [] : await relaxations(f, "search"), message: results.length ? null : "No facilities match your criteria", ms: Date.now() - t0 };
    },
    async facility(token, id) {
      const s = await auth(token), staff = STAFF.includes(s.role);
      const f = await getFacilityRow(id, staff);
      if (!f) fail("NOT_FOUND", "Facility not found.");
      const sched = await q(`SELECT start_ts, end_ts, status, purpose FROM bookings WHERE facility_id = $1 AND status IN ${ACTIVE}
                             AND end_ts > $2 AND start_ts < $3 ORDER BY start_ts`, [id, nowDate(), new Date(now() + 14 * 86400e3)]);
      return { ...f, schedule: sched.map(b => ({ start: new Date(b.start_ts).toISOString(), end: new Date(b.end_ts).toISOString(), status: b.status, purpose: staff ? b.purpose : null })) };
    },
    async filterOptions(token) {
      await auth(token);
      return {
        buildings: (await q("SELECT DISTINCT building FROM facilities WHERE status <> 'Inactive' ORDER BY building")).map(r => r.building),
        floors: (await q("SELECT DISTINCT floor FROM facilities WHERE status <> 'Inactive' ORDER BY floor")).map(r => r.floor),
        equipment: (await q("SELECT name FROM equipment ORDER BY sort_order")).map(r => r.name)
      };
    },

    /* ===================== US5: Request Facility Allocation ===================== */
    async createBooking(token, d) {
      const s = await auth(token);
      d = d || {};
      const purpose = str(d.purpose), start = time(d.start), end = time(d.end), att = str(d.attendees);
      if (!start || !end) fail("VALIDATION", "Choose the date, start time and end time.");
      if (end <= start) fail("VALIDATION", "End time must be after the start time.");
      if (start.getTime() <= now()) fail("VALIDATION", "The start time must be in the future.");
      if (!purpose) fail("VALIDATION", "Enter the purpose of the booking.");
      if (purpose.length > 200) fail("VALIDATION", "Keep the purpose under 200 characters.");
      if (!posInt(att)) fail("VALIDATION", "Expected attendees must be a whole number greater than 0.");
      const attendees = Number(att), minutes = Math.round((end - start) / 60000);
      const p = await policyOf(s.role);
      if (minutes > p.max_minutes)
        fail("POLICY", `${s.role} accounts can book a room for at most ${fmtMinutes(p.max_minutes)} at a time. This request is ${fmtMinutes(minutes)}.`);
      let facilityId = str(d.facilityId), recommended = false;
      if (!facilityId) {
        const top = (await rank(s.username, { capMin: attendees, equipment: list(d.equipment), start, end }, str(d.building)))[0];
        if (!top) fail("NO_MATCH", "No room is free for that time and group size. Try another time or a smaller group.");
        facilityId = top.id; recommended = true;
      }
      return db.tx(async t => {
        /* Locks serialise concurrent requests by the same user (limit) and for the same room (double booking). */
        await t.query("SELECT username FROM users WHERE username = $1 FOR UPDATE", [s.username]);
        const { n } = (await t.query(`SELECT count(*)::int AS n FROM bookings WHERE username = $1 AND status IN ${ACTIVE} AND end_ts > $2`, [s.username, nowDate()])).rows[0];
        if (n >= p.max_active) fail("POLICY", `${s.role} accounts can hold ${plural(p.max_active, "active booking")} at a time. You have ${n}.`);
        const f = (await t.query("SELECT id, name, capacity, status FROM facilities WHERE id = $1 FOR UPDATE", [facilityId])).rows[0];
        if (!f || f.status === "Inactive") fail("NOT_FOUND", "Facility not found.");
        if (f.status !== "Active") fail("VALIDATION", `${f.name} is under maintenance and cannot be booked.`);
        if (attendees > f.capacity) fail("CAPACITY", `${f.name} seats ${f.capacity}, but you expect ${attendees} people.`);
        const clash = (await t.query(`SELECT id, start_ts, end_ts, status FROM bookings WHERE facility_id = $1 AND status IN ${ACTIVE} AND start_ts < $3 AND end_ts > $2 ORDER BY start_ts`,
          [f.id, start, end])).rows;
        if (clash.length) fail("CONFLICT", `${f.name} is already booked during that time.`,
          { conflicts: clash.map(c => ({ id: c.id, start: new Date(c.start_ts).toISOString(), end: new Date(c.end_ts).toISOString(), status: c.status })) });
        /* The same person cannot be in two rooms at once. */
        const mine = (await t.query(`SELECT id, facility_name, start_ts, end_ts, status FROM bookings WHERE username = $1 AND status IN ${ACTIVE}
                                     AND start_ts < $3 AND end_ts > $2 ORDER BY start_ts`, [s.username, start, end])).rows;
        if (mine.length) fail("CONFLICT", `You already have ${mine[0].facility_name} booked during that time (${mine[0].id}).`,
          { conflicts: mine.map(c => ({ id: c.id, start: new Date(c.start_ts).toISOString(), end: new Date(c.end_ts).toISOString(), status: c.status })) });
        const row = (await t.query(`INSERT INTO bookings (id, facility_id, facility_name, username, start_ts, end_ts, purpose, attendees, status, created_at)
              VALUES ('REQ-' || $8 || '-' || lpad(nextval('booking_seq')::text, 4, '0'), $1,$2,$3,$4,$5,$6,$7,'Pending',$9) RETURNING *`,
          [f.id, f.name, s.username, start, end, purpose, attendees, String(start.getFullYear()), nowDate()])).rows[0];
        await audit(s.username, "Booking requested", `${row.id} · ${f.name} · ${plural(attendees, "attendee")}`, t);
        return { ...toBooking({ ...row, user_name: s.name }), recommended };
      });
    },
    /* Own requests only, unless Admin / Facility Manager asks for all. */
    async listBookings(token, o) {
      const s = await auth(token), all = !!(o && o.all) && STAFF.includes(s.role);
      const rows = all ? await q(`${BOOKING_SELECT} ORDER BY b.start_ts DESC LIMIT 200`)
        : await q(`${BOOKING_SELECT} WHERE b.username = $1 ORDER BY b.start_ts DESC LIMIT 200`, [s.username]);
      return rows.map(toBooking);
    },

    /* ===================== Approval (Admin / Facility Manager) ===================== */
    /* Pending requests that have not started yet, soonest first. */
    async pendingBookings(token) {
      await auth(token, ...STAFF);
      return (await q(`${BOOKING_SELECT} WHERE b.status = 'Pending' AND b.start_ts > $1 ORDER BY b.start_ts LIMIT 200`, [nowDate()])).map(toBooking);
    },
    /* Approve or reject a Pending request. A rejection needs a reason; staff cannot decide their own requests. */
    async decideBooking(token, id, decision, note) {
      const s = await auth(token, ...STAFF);
      decision = str(decision); note = str(note);
      if (!["Approved", "Rejected"].includes(decision)) fail("VALIDATION", "Choose Approve or Reject.");
      if (decision === "Rejected" && !note) fail("VALIDATION", "Enter a reason for the rejection. The requester will see it.");
      if (note.length > 200) fail("VALIDATION", "Keep the reason under 200 characters.");
      return db.tx(async t => {
        const b = (await t.query("SELECT * FROM bookings WHERE id = $1 FOR UPDATE", [str(id)])).rows[0];
        if (!b) fail("NOT_FOUND", "Request not found.");
        if (b.username === s.username) fail("ACCESS_DENIED", "You cannot approve or reject your own request. Ask another staff member.");
        if (b.status !== "Pending") fail("VALIDATION", `Request ${b.id} is already ${b.status.toLowerCase()}.`);
        if (new Date(b.start_ts).getTime() <= now()) fail("VALIDATION", `Request ${b.id} has already started and can no longer be ${decision.toLowerCase()}.`);
        if (decision === "Approved") {
          /* Lock the room so two approvals for the same slot cannot pass at the same time. */
          const f = b.facility_id && (await t.query("SELECT id, name, status, capacity FROM facilities WHERE id = $1 FOR UPDATE", [b.facility_id])).rows[0];
          if (!f || f.status === "Inactive") fail("NOT_FOUND", `${b.facility_name} is no longer in the catalogue. Reject this request instead.`);
          if (f.status !== "Active") fail("VALIDATION", `${f.name} is under maintenance. Reject this request or set the room back to Active first.`);
          if (b.attendees > f.capacity) fail("CAPACITY", `${f.name} now seats ${f.capacity}, but this request is for ${b.attendees} people. Reject it instead.`);
          const clash = (await t.query(`SELECT id, start_ts, end_ts, status FROM bookings WHERE facility_id = $1 AND id <> $2 AND status = 'Approved'
                                        AND start_ts < $4 AND end_ts > $3 ORDER BY start_ts`, [f.id, b.id, b.start_ts, b.end_ts])).rows;
          if (clash.length) fail("CONFLICT", `${f.name} already has an approved booking during that time.`,
            { conflicts: clash.map(c => ({ id: c.id, start: new Date(c.start_ts).toISOString(), end: new Date(c.end_ts).toISOString(), status: c.status })) });
        }
        await t.query("UPDATE bookings SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1",
          [b.id, decision, s.username, nowDate(), note || null]);
        await audit(s.username, decision === "Approved" ? "Booking approved" : "Booking rejected",
          `${b.id} · ${b.facility_name} · requested by ${b.username}` + (note ? ` · ${note}` : ""), t);
        const row = (await t.query(`${BOOKING_SELECT} WHERE b.id = $1`, [b.id])).rows[0];
        return toBooking(row);
      });
    },

    /* ===================== US6: Intelligent Room Recommendations ===================== */
    async recommend(token, input) {
      const s = await auth(token), i = input || {}, f = recommendInput(i), t0 = Date.now();
      const results = (await rank(s.username, f, str(i.building))).slice(0, 10);
      return { results, message: results.length ? null : "No match: no free room meets all your requirements for that time.",
        suggestions: results.length ? [] : await relaxations(f, "recommend"), ms: Date.now() - t0 };
    },

    /* ===================== Dashboard ===================== */
    async dashboard(token) {
      const s = await auth(token);
      const c = await one(`SELECT count(*) FILTER (WHERE status = 'Active')::int AS active, count(*) FILTER (WHERE status = 'Under Maintenance')::int AS maint,
                           count(DISTINCT building) FILTER (WHERE status <> 'Inactive')::int AS buildings FROM facilities`);
      const pending = STAFF.includes(s.role) ? (await one("SELECT count(*)::int AS n FROM bookings WHERE status = 'Pending' AND start_ts > $1", [nowDate()])).n : null;
      const upcoming = (await q(`${BOOKING_SELECT} WHERE b.username = $1 AND b.status IN ${ACTIVE} AND b.end_ts > $2 ORDER BY b.start_ts LIMIT 5`, [s.username, nowDate()])).map(toBooking);
      return { activeFacilities: c.active, underMaintenance: c.maint, buildings: c.buildings, pendingRequests: pending, upcoming };
    },

    /* ===================== demo helpers (disabled with DEMO_TOOLS=off) ===================== */
    async demoAccounts() {
      const roles = Object.fromEntries((await q("SELECT username, role FROM users")).map(r => [r.username, r.role]));
      return Object.entries(SSO.DIRECTORY).map(([u, a]) => ({ username: u, name: a.name, role: roles[u] || "Student" }));
    },
    async simulateIdle(token) {
      const s = await auth(token);
      await db.query("UPDATE sessions SET last_seen = $2 WHERE token_hash = $1", [s.tokenHash, new Date(now() - (SESSION_MINUTES + 1) * 60000)]);
      return { ok: true };
    },
    setSsoDown(v) { ssoDown = !!v; return { ssoDown }; },
    isSsoDown() { return ssoDown; },
    async reset() { ssoDown = false; await seedData.reset(db, now()); return { ok: true }; }
  };
  return api;
}

module.exports = { createService, ApiError, ROLES, TYPES, STATUSES, SESSION_MINUTES, MAX_FAILS, LOCK_SECONDS };
