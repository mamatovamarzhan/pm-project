# User stories 1–6 (from User_story_team_special.xlsx)

## US1 — Login & Authentication  (5 pts · LC&HV · Iteration 1 · Vakhitova Dilyara)
As a student/faculty/admin/facility manager, I want to log in with my university credentials, so that I can securely access the facility allocation system.

Responsibilities: SSO/LDAP authentication before any content; session expires after 30 min inactivity; passwords never stored locally; failed attempts rate-limited and logged.
Constraints: integrate with university SSO/LDAP API; JWT or session tokens for subsequent requests.
Implemented in: `server/service.js` → `login`, `logout`, `auth()`; `server/sso.js`; `js/app.js` → `renderLogin`, `toLogin`.

## US2 — User Role Management  (3 pts · LC&HV · Iteration 1 · Vakhitova Dilyara)
As an admin, I want to assign roles (Student, Faculty, Facility Manager, Admin) to users, so that each user has the correct permissions for booking and management.

Responsibilities: four roles; one primary role per user; only Admin changes roles; change takes effect on next login.
Constraints: role stored in users table; RBAC enforced on the backend.
Implemented in: `server/service.js` → `listUsers`, `setRole`, `auth(token, ...roles)`, booking limit in `createBooking`; `js/app.js` → `pageAdmin`, Access Denied page.

## US3 — Facility Inventory Management  (5 pts · LC&HV · Iteration 1 · Mamatova Marjan)
As a facility manager or admin, I want to create, update and delete facility records (classrooms, labs, conference rooms) with attributes (capacity, equipment, location, type), so that the system has an accurate catalogue of resources.

Responsibilities: unique ID, name, type, capacity, building, floor, equipment list, status; only Admin/Facility Manager edit; delete with future bookings is blocked or force-cancelled.
Constraints: relational storage; structured equipment list.
Implemented in: `server/service.js` → `listFacilities`, `saveFacility`, `deleteFacility`, `futureBookings`; `js/app.js` → `pageFacilities`, `editFacility`, `deleteFacilityDlg`.

## US4 — Search & Browse Facilities  (3 pts · Iteration 2 · Oteukyzy Dana)
As a user, I want a clean search and filter interface for facilities, so that I can quickly find rooms by capacity, equipment, building, or availability.

Responsibilities: visible search bar and filters (capacity range, type, building, floor, equipment, availability date/time); results with key attributes and availability status; responsive.
Constraints: results within 2 seconds.
Implemented in: `server/service.js` → `search`, `facility`, `filterOptions`, `facilityQuery`, `relaxations`; `js/app.js` → `pageSearch`, `facilityDlg`.

## US5 — Request Facility Allocation  (5 pts · Iteration 2 · Oteukyzy Dana)
As a faculty or student, I want to submit a booking request for a classroom, lab or meeting room for a specific date and time range, so that I can reserve the space I need.

Responsibilities: facility (or blank for recommendation), start, end, purpose, attendees; end > start and within policy; saved as Pending.
Constraints: role-based duration limit (Student 2 h, Faculty 8 h); request linked to the authenticated user.
Implemented in: `server/service.js` → `createBooking`, `listBookings`; `bookings` table; `js/app.js` → `pageBook`, `pageRequests`.

## US6 — Intelligent Room Recommendations  (8 pts · Iteration 2 · Ramazan Gulnur)
As a user, I want the system to recommend the most suitable rooms based on my requirements (capacity, equipment, preferred building, time), so that I do not have to manually search through all options.

Responsibilities: ranked list of available rooms considering capacity fit, equipment, location and historical preference.
Constraints: rule-based scoring; only rooms without conflicts.
Implemented in: `server/service.js` → `recommend`, `rank`; `js/app.js` → `pageRecommend`.
