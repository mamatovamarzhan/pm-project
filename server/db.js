/* Database connection. Two drivers behind one tiny interface: query(sql, params), tx(fn), exec(sql), close().
   - DATABASE_URL set  → node-postgres (Supabase or any PostgreSQL server).
   - DATABASE_URL empty → PGlite, a real PostgreSQL engine embedded in Node (data kept in ./data/pg),
                          so the app and tests run with no database server installed. */
"use strict";
const fs = require("fs");
const path = require("path");

async function connect(opts) {
  const o = opts || {};
  const url = o.url !== undefined ? o.url : process.env.DATABASE_URL;
  if (url) {
    if (!/^postgres(ql)?:\/\//.test(url))
      throw new Error("DATABASE_URL must be a PostgreSQL connection string starting with postgresql:// (in Supabase: Connect → Session pooler), not the project's https:// URL.");
    const { Pool } = require("pg");
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const pool = new Pool({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false }, max: 10 });
    await pool.query("select 1");
    return {
      kind: "postgres",
      label: url.replace(/:\/\/([^:]+):[^@]*@/, "://$1:****@"),
      query: (sql, params) => pool.query(sql, params),
      exec: sql => pool.query(sql),
      async tx(fn) {
        const c = await pool.connect();
        try { await c.query("BEGIN"); const r = await fn({ query: (s, p) => c.query(s, p) }); await c.query("COMMIT"); return r; }
        catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
        finally { c.release(); }
      },
      close: () => pool.end()
    };
  }
  const { PGlite } = require("@electric-sql/pglite");
  const dir = o.memory ? undefined : (o.dir || path.join(__dirname, "..", "data", "pg"));
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;
  return {
    kind: "pglite",
    label: dir ? "embedded PostgreSQL (PGlite) in " + path.relative(process.cwd(), dir) : "embedded PostgreSQL (in memory)",
    query: (sql, params) => db.query(sql, params),
    exec: sql => db.exec(sql),
    tx: fn => db.transaction(t => fn({ query: (s, p) => t.query(s, p) })),
    close: () => db.close()
  };
}

const migrate = db => db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

module.exports = { connect, migrate };
