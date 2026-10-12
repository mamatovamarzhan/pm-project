# Campus Facility Allocation — User Stories 1–6

Facility Allocation System with a Node.js (Express) backend on PostgreSQL.

| # | User story | Where in the app |
|---|-----------|------------------|
| US1 | Login & Authentication | Login page, 30-minute session timeout, logout, rate-limited sign-in |
| US2 | User Role Management | Users & roles (Admin only); Access Denied for other roles; role-based booking limits |
| US3 | Facility Inventory Management | Facility management (Admin / Facility Manager): create, edit, delete |
| US4 | Search & Browse Facilities | Find a room: filters, availability status, facility detail, relaxation suggestions |
| US5 | Request Facility Allocation | Book a room → request saved as Pending with a request ID; My requests |
| US6 | Intelligent Room Recommendations | Recommendations: ranked free rooms with match % and reasons → pre-filled booking |
| — | Request Approval | Approvals (Admin / Facility Manager): approve or reject Pending requests (reason required to reject); decision shown in My requests |

## Run

```
npm install
npm start
```

Open http://localhost:3000. Demo accounts (password for all: `campus2026`): `student`, `student2`, `faculty`, `faculty2`, `manager`, `admin`.

## Database

The server reads `.env` (copy `.env.example`).

- **`DATABASE_URL` empty**: an embedded PostgreSQL engine (PGlite) stores the data in `data/pg`. Nothing to install.
- **Supabase**: in your Supabase project click **Connect**, copy the **Session pooler** connection string, put your database password in it, and set it as `DATABASE_URL` in `.env`. Restart `npm start`. The server creates the tables and loads the demo data into an empty database on first start.
- Any other PostgreSQL server works the same way: `DATABASE_URL=postgresql://user:password@host:port/dbname`.

The schema is in `server/schema.sql` (you can also paste it into the Supabase SQL editor). Tables: `roles` (booking policy per role), `users` (one role column, **no password column**), `sessions` (hashed tokens), `login_locks`, `login_log`, `facilities`, `equipment`, `facility_equipment`, `bookings`, `audit_log`.

Role limits live in the `roles` table: Student 2 active bookings / 2 hours each, Faculty 5 / 8 hours, Facility Manager and Admin 10 / 12 hours.

## QA tests

The acceptance scenarios from the `US1QATest` … `US6QATest` sheets are automated in `tests/qa.test.js` (50 tests). They run against a real PostgreSQL engine in memory, so they need no database setup:

```
npm test
```

## Structure

```
index.html            page shell
css/styles.css        styles (light + dark)
js/api.js             browser client for the REST API
js/app.js             UI: login, dashboard, search, recommendations, booking, requests, facility management, users & roles
server/server.js      Express: REST endpoints + static files
server/service.js     business logic: sessions, role checks, validation, search, booking, recommendation scoring
server/db.js          PostgreSQL connection (Supabase / any Postgres, or embedded PGlite)
server/schema.sql     database schema
server/seed.js        demo data
server/sso.js         mock university SSO directory (replace verify() with the real SSO/LDAP call)
tests/qa.test.js      acceptance tests from the QA sheets
docs/                 user stories and QA scenarios
```

## Demo tools

The login page and the footer have demo tools: simulate an SSO outage, simulate 30 minutes of inactivity, open the admin URL as a non-admin, reset the demo data. Set `DEMO_TOOLS=off` in `.env` to remove them (do this on any shared deployment; "Reset demo data" wipes the database).
