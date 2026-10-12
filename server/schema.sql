-- Campus Facility Allocation System: PostgreSQL schema for user stories 1-6.
-- Safe to run more than once. The server runs it on start-up; you can also paste it into the Supabase SQL editor.

-- US2: the four roles and their booking policy (limits are configurable here, not in code).
CREATE TABLE IF NOT EXISTS roles (
  name          text PRIMARY KEY,
  max_active    int  NOT NULL CHECK (max_active > 0),     -- concurrent Pending/Approved future bookings
  max_minutes   int  NOT NULL CHECK (max_minutes > 0),    -- longest single booking
  sort_order    int  NOT NULL
);

-- US1/US2: users table with ONE role column and NO password column (passwords stay in the university SSO).
CREATE TABLE IF NOT EXISTS users (
  username      text PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL,
  role          text NOT NULL REFERENCES roles(name),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- US1: session tokens. Only a SHA-256 hash of the token is stored. The role is fixed at login (US2: changes apply on next login).
CREATE TABLE IF NOT EXISTS sessions (
  token_hash    text PRIMARY KEY,
  username      text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  role          text NOT NULL,
  created_at    timestamptz NOT NULL,
  last_seen     timestamptz NOT NULL
);

-- US1: failed sign-in rate limiting and the sign-in log.
CREATE TABLE IF NOT EXISTS login_locks (
  username      text PRIMARY KEY,
  fails         int NOT NULL DEFAULT 0,
  locked_until  timestamptz
);
CREATE TABLE IF NOT EXISTS login_log (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL,
  username      text NOT NULL,
  ok            boolean NOT NULL,
  detail        text NOT NULL
);

-- US3: facility catalogue with a structured equipment list.
CREATE SEQUENCE IF NOT EXISTS facility_seq;
CREATE TABLE IF NOT EXISTS facilities (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  type          text NOT NULL CHECK (type IN ('Classroom', 'Laboratory', 'Conference Room', 'Other')),
  capacity      int  NOT NULL CHECK (capacity > 0),
  building      text NOT NULL,
  floor         int  NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Under Maintenance', 'Inactive')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS facilities_name_uq ON facilities (lower(name));
CREATE INDEX IF NOT EXISTS facilities_search_idx ON facilities (status, type, building, capacity);

CREATE TABLE IF NOT EXISTS equipment (
  name          text PRIMARY KEY,
  sort_order    int NOT NULL
);
CREATE TABLE IF NOT EXISTS facility_equipment (
  facility_id   text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  equipment     text NOT NULL REFERENCES equipment(name),
  PRIMARY KEY (facility_id, equipment)
);
CREATE INDEX IF NOT EXISTS facility_equipment_eq_idx ON facility_equipment (equipment);

-- US5: booking requests. facility_name is a snapshot so history survives a (forced) facility delete.
CREATE SEQUENCE IF NOT EXISTS booking_seq;
CREATE TABLE IF NOT EXISTS bookings (
  id            text PRIMARY KEY,
  facility_id   text REFERENCES facilities(id) ON DELETE SET NULL,
  facility_name text NOT NULL,
  username      text NOT NULL REFERENCES users(username),
  start_ts      timestamptz NOT NULL,
  end_ts        timestamptz NOT NULL,
  purpose       text NOT NULL,
  attendees     int  NOT NULL CHECK (attendees > 0),
  status        text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_ts > start_ts)
);
CREATE INDEX IF NOT EXISTS bookings_facility_time_idx ON bookings (facility_id, start_ts, end_ts);
CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings (username, end_ts);

-- Approval: who approved or rejected a request, when, and the reason given (required for a rejection).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS decided_by    text REFERENCES users(username);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS decided_at    timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS decision_note text;
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status, start_ts);

-- Conflict detection in the database itself: a Pending/Approved booking may not overlap another Pending/Approved
-- booking of the same room, even if a row is written outside the app (e.g. in the Supabase table editor).
-- Locking the room row serialises concurrent inserts for the same room.
CREATE OR REPLACE FUNCTION bookings_no_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other text;
BEGIN
  IF NEW.status NOT IN ('Pending', 'Approved') OR NEW.facility_id IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM facilities WHERE id = NEW.facility_id FOR UPDATE;
  SELECT id INTO other FROM bookings
    WHERE facility_id = NEW.facility_id AND id <> NEW.id AND status IN ('Pending', 'Approved')
      AND start_ts < NEW.end_ts AND end_ts > NEW.start_ts
    LIMIT 1;
  IF other IS NOT NULL THEN
    RAISE EXCEPTION 'Booking % overlaps booking % for the same room.', NEW.id, other USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bookings_no_overlap ON bookings;
CREATE TRIGGER bookings_no_overlap BEFORE INSERT OR UPDATE OF facility_id, start_ts, end_ts, status ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_no_overlap();

-- US3: audit log of every change.
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL,
  username      text NOT NULL,
  action        text NOT NULL,
  detail        text NOT NULL
);
