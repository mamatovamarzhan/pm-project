# QA scenarios (Given / When / Then) and where each is tested

## US1QATest
1. Successful login with valid credentials → redirected to the dashboard. `tests/qa.test.js` "US1 Scenario 1"; manual: log in as `student` / `campus2026`.
2. Login with invalid credentials → "Invalid username or password". "US1 Scenario 2"; manual: wrong password.
3. Logout → session terminated, login page shown. "US1 Scenario 3"; manual: Logout button.
4. Session timeout after 30 min inactivity → "Session expired, please log in again". "US1 Scenario 4"; manual: "Simulate 30 min of inactivity" then click anything.
Rules: Login button disabled until both fields are filled; SSO unavailable → cannot log in (checkbox on login page); passwords never stored; failures rate-limited (5 attempts → 60 s lock) and shown in the sign-in log.

## US2QATest
1. Admin assigns Facility Manager to a Faculty user → saved immediately, permissions on next login. "US2 Scenario 1"; manual: admin → Users & roles → change `faculty2`, log out, log in as `faculty2`.
2. Student opens the admin panel URL → "Access Denied". "US2 Scenario 2"; manual: as student click "Open the admin URL directly" or go to `#admin`.
3. Student with 2 active bookings cannot create a third. "US2 Scenario 3"; manual: as `student` (has 1 request) book two rooms on the Book a room page.
Rules: exactly one role; only Admin changes roles; a user cannot change their own role.

## US3QATest
1. Admin creates a classroom (capacity 40) → stored, appears in catalogue search as Active. "US3 Scenario 1"; manual: admin → Facility management → Add facility → then Facility catalogue.
2. Facility Manager changes lab capacity 25 → 30 → search reflects it. "US3 Scenario 2"; manual: manager → edit EB-112.
3. Delete a facility with future bookings → blocked, conflicting bookings listed; Admin may force. "US3 Scenario 3"; manual: delete MB-210.
4. Student tries to edit a facility → "Access Denied". "US3 Scenario 4"; manual: student → `#facilities`.
Rules: capacity positive integer; required fields name/type/capacity/building; fixed type and status lists; audit log of all changes.

## US4QATest
1. Capacity ≥ 30 and type = Classroom → only such classrooms, sorted by name. "US4 Scenario 1"; manual: Find a room → Type Classroom, Seats min 30.
2. Projector filter → only rooms listing a Projector. "US4 Scenario 2"; manual: tick Projector.
3. No match → "No facilities match your criteria" and suggested relaxations. "US4 Scenario 3"; manual: Conference Room + min 100 seats + Fume hood, then click a suggestion.
Rules: filters for capacity range, type, building, floor, equipment, availability date/time; results show attributes + availability ("Available now", "In use until …", "Free for your selected time"); clicking a card opens the detail with the 14-day schedule and "Request this room"; response time shown under the results (limit 2 s).

## US5QATest
1. Faculty submits a valid request → saved as Pending, request ID shown. "US5 Scenario 1"; manual: faculty → Book a room.
2. Student books 4 hours → rejected, duration limit explained (Students: 2 hours). "US5 Scenario 2"; manual: student → 10:00–14:00.
3. End time before start time → validation error. "US5 Scenario 3".
Rules: required start, end, purpose, attendees; role-based limits configurable in the `roles` table; overlapping or over-capacity requests and rooms under maintenance are refused; blank room = system picks the best free room; users see only their own requests (Admin / Facility Manager can switch to "Everyone").

## US6QATest
1. Capacity ≥ 35 + Projector → only free rooms that qualify, ranked by match. "US6 Scenario 1"; manual: Recommendations → People 35, Projector.
2. No suitable room → "No match" message with relaxation suggestions. "US6 Scenario 2"; manual: People 50 + Fume hood.
3. Preferred building ranks higher. "US6 Scenario 3"; manual: People 40, Projector + Whiteboard, switch Preferred building between Main Building and Engineering Block.
Scoring (rule-based, 100 points): capacity fit 45 (people ÷ seats), required equipment 25, preferred building 20, booking history 10. Only rooms free for the whole window are considered; each result shows its score and reasons; "Book this room" pre-fills the booking form.
