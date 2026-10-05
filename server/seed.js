/* Demo data: roles and booking policy, users, equipment list, facility catalogue and some bookings.
   Booking times are relative to "now" so the demo always has future, current and past bookings. */
"use strict";

const ROLE_POLICY = [
  // name, max active bookings, max minutes per booking
  ["Student", 2, 120],
  ["Faculty", 5, 480],
  ["Facility Manager", 10, 720],
  ["Admin", 10, 720]
];
const EQUIPMENT = ["Projector", "Whiteboard", "Microphone", "Video conferencing", "Computers", "Lab instruments", "Smart display", "Fume hood"];
const USERS = [
  ["student", "Aruzhan K.", "student@campus.example", "Student"],
  ["student2", "Nurlan O.", "student2@campus.example", "Student"],
  ["faculty", "Dr. Bekov", "faculty@campus.example", "Faculty"],
  ["faculty2", "Dr. Sadykova", "faculty2@campus.example", "Faculty"],
  ["manager", "Timur I.", "manager@campus.example", "Facility Manager"],
  ["admin", "Saule A.", "admin@campus.example", "Admin"]
];
/* University catalogue: blocks D-I, floors 1-3, rooms <block><floor>01..05 on every floor,
   a lecture hall <block><floor>13 on every floor (D113, E213 ...), and ground-floor rooms H01-H05.
   Room kinds and seat counts are defaults; change them on the Facility management page or here before the first start. */
const BLOCKS = ["D", "E", "F", "G", "H", "I"];
const ROOM_KINDS = {
  // room number on the floor -> [type, capacity, equipment, label]
  "01": ["Classroom", 30, ["Projector", "Whiteboard"]],
  "02": ["Classroom", 30, ["Projector", "Whiteboard"]],
  "03": ["Classroom", 30, ["Projector", "Whiteboard"]],
  "04": ["Laboratory", 25, ["Computers", "Projector", "Whiteboard"], "Computer Lab"],
  "05": ["Conference Room", 12, ["Smart display", "Video conferencing", "Whiteboard"], "Meeting Room"],
  "13": ["Classroom", 120, ["Projector", "Microphone", "Video conferencing", "Whiteboard"], "Lecture Hall"]
};
const FACILITIES = [];
for (const block of BLOCKS) {
  for (const floor of [1, 2, 3]) {
    for (const [no, [type, capacity, equipment, label]] of Object.entries(ROOM_KINDS)) {
      const code = `${block}${floor}${no}`;
      // G-block labs are science labs
      const eq = block === "G" && no === "04" ? ["Lab instruments", "Fume hood", "Whiteboard"] : equipment;
      FACILITIES.push([label ? `${code} ${block === "G" && no === "04" ? "Science Lab" : label}` : code, type, `Block ${block}`, floor, capacity, eq]);
    }
  }
}
for (let i = 1; i <= 5; i++) FACILITIES.push([`H0${i}`, "Classroom", "Block H", 0, 20, ["Whiteboard"]]);
FACILITIES.find(f => f[0] === "I305 Meeting Room").push("Under Maintenance");

/* Local date `days` weekdays from now, at hh:mm. */
function weekdayAt(nowMs, days, hh, mm) {
  const d = new Date(nowMs);
  let k = days;
  while (k > 0) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) k--; }
  while (k < 0) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0 && d.getDay() !== 6) k++; }
  d.setHours(hh, mm || 0, 0, 0);
  return d;
}

async function seed(db, nowMs) {
  const q = (s, p) => db.query(s, p);
  for (const [i, r] of ROLE_POLICY.entries()) await q("INSERT INTO roles (name, max_active, max_minutes, sort_order) VALUES ($1,$2,$3,$4)", [...r, i]);
  for (const [i, e] of EQUIPMENT.entries()) await q("INSERT INTO equipment (name, sort_order) VALUES ($1,$2)", [e, i]);
  for (const u of USERS) await q("INSERT INTO users (username, name, email, role) VALUES ($1,$2,$3,$4)", u);
  const ids = {};
  for (const [name, type, building, floor, capacity, eq, status] of FACILITIES) {
    const { rows: [r] } = await q(
      "INSERT INTO facilities (id, name, type, building, floor, capacity, status) VALUES ('F-' || lpad(nextval('facility_seq')::text, 3, '0'), $1,$2,$3,$4,$5,$6) RETURNING id",
      [name, type, building, floor, capacity, status || "Active"]);
    ids[name.split(" ")[0]] = r.id;
    for (const e of eq) await q("INSERT INTO facility_equipment (facility_id, equipment) VALUES ($1,$2)", [r.id, e]);
  }
  const now = new Date(nowMs), hourStart = new Date(nowMs); hourStart.setMinutes(0, 0, 0);
  const B = [
    // code, user, start, end, purpose, attendees, status
    ["D101", "faculty", weekdayAt(nowMs, 3, 14), weekdayAt(nowMs, 3, 16), "Midterm exam", 28, "Approved"],
    ["E205", "student", weekdayAt(nowMs, 1, 13), weekdayAt(nowMs, 1, 14, 30), "Study group", 6, "Pending"],
    ["F113", "faculty2", weekdayAt(nowMs, 2, 10), weekdayAt(nowMs, 2, 12), "Guest lecture", 100, "Approved"],
    ["E113", "faculty2", new Date(hourStart.getTime() - 3600e3), new Date(hourStart.getTime() + 2 * 3600e3), "Lecture: Databases", 90, "Approved"],
    // history (used by the recommendation engine's "historical preference")
    ["F113", "faculty", weekdayAt(nowMs, -5, 10), weekdayAt(nowMs, -5, 12), "Lecture", 95, "Approved"],
    ["F113", "faculty", weekdayAt(nowMs, -10, 10), weekdayAt(nowMs, -10, 12), "Lecture", 98, "Approved"],
    ["E205", "student", weekdayAt(nowMs, -3, 15), weekdayAt(nowMs, -3, 16), "Project meeting", 5, "Approved"],
    ["G305", "manager", weekdayAt(nowMs, -2, 9), weekdayAt(nowMs, -2, 10), "Facilities review", 8, "Approved"]
  ];
  for (const [code, user, s, e, purpose, att, status] of B) {
    const fname = FACILITIES.find(f => f[0] === code || f[0].startsWith(code + " "))[0];
    await q(
      "INSERT INTO bookings (id, facility_id, facility_name, username, start_ts, end_ts, purpose, attendees, status, created_at) " +
      "VALUES ('REQ-' || $9 || '-' || lpad(nextval('booking_seq')::text, 4, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$10)",
      [ids[code], fname, user, s, e, purpose, att, status, String(now.getFullYear()), new Date(Math.min(s.getTime(), nowMs) - 86400e3)]);
  }
}

/* Empty every table and load the demo data again. */
async function reset(db, nowMs) {
  await db.exec(`TRUNCATE audit_log, bookings, facility_equipment, equipment, facilities, login_log, login_locks, sessions, users, roles RESTART IDENTITY CASCADE;
                 ALTER SEQUENCE facility_seq RESTART WITH 1; ALTER SEQUENCE booking_seq RESTART WITH 1;`);
  await seed(db, nowMs);
}

/* Seed only an empty database (first start). */
async function seedIfEmpty(db, nowMs) {
  const { rows: [r] } = await db.query("SELECT count(*)::int AS n FROM roles");
  if (r.n === 0) { await seed(db, nowMs); return true; }
  return false;
}

module.exports = { seed, reset, seedIfEmpty, ROLE_POLICY, EQUIPMENT, FACILITIES, weekdayAt };
