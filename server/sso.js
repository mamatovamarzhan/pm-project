/* Mock university SSO / LDAP directory (US1).
   This stands in for the university identity provider: it is the ONLY place a password exists, and it is never
   written to the database. To connect the real SSO/LDAP, replace verify() with a call to that service; the rest of
   the login flow (rate limiting, sessions, roles) stays as it is. */
"use strict";
const crypto = require("crypto");

const DEMO_PASSWORD = "campus2026";
const DIRECTORY = {
  student:  { name: "Aruzhan K.",   email: "student@campus.example" },
  student2: { name: "Nurlan O.",    email: "student2@campus.example" },
  faculty:  { name: "Dr. Bekov",    email: "faculty@campus.example" },
  faculty2: { name: "Dr. Sadykova", email: "faculty2@campus.example" },
  manager:  { name: "Timur I.",     email: "manager@campus.example" },
  admin:    { name: "Saule A.",     email: "admin@campus.example" }
};

const same = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

/* Returns the directory entry for valid credentials, otherwise null. */
function verify(username, password) {
  const acc = DIRECTORY[username];
  return acc && same(password, DEMO_PASSWORD) ? { username, ...acc } : null;
}

module.exports = { verify, DIRECTORY, DEMO_PASSWORD };
