/* Vercel serverless entry point: every /api/* request is routed here (see vercel.json).
   The Express app and the database connection are created once per warm instance and reused.
   Vercel serves index.html, css/ and js/ as static files. Locally, use `npm run dev` instead. */
"use strict";
const { connect, migrate } = require("../server/db");
const { seedIfEmpty } = require("../server/seed");
const { createService } = require("../server/service");
const { buildApp } = require("../server/server");

let ready = null;
async function init() {
  const db = await connect();
  await migrate(db);
  await seedIfEmpty(db, Date.now());
  return buildApp(createService({ db }), { demo: (process.env.DEMO_TOOLS || "on").toLowerCase() !== "off" });
}

module.exports = async (req, res) => {
  let app;
  try { app = await (ready || (ready = init().catch(e => { ready = null; throw e; }))); }
  catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ code: "SERVER", message: "The server cannot reach the database: " + e.message }));
  }
  return app(req, res);
};
