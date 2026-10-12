/* Front end for User Stories 1–6. All data comes from the REST API (js/api.js → server/). */
"use strict";
const $ = id => document.getElementById(id);

/* Light / dark switch. index.html sets data-theme before first paint; an explicit choice is remembered,
   otherwise the theme follows the operating system. */
const THEME_KEY = "cfa-theme";
const sysDark = window.matchMedia("(prefers-color-scheme: dark)");
const isDark = () => document.documentElement.dataset.theme === "dark";
const themeLabel = () => `Switch to ${isDark() ? "light" : "dark"} mode`;
const themeBtn = () => `<button type="button" class="theme-btn" data-theme-toggle aria-label="${themeLabel()}" title="${themeLabel()}"><svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg><svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>`;
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelectorAll("[data-theme-toggle]").forEach(b => { b.setAttribute("aria-label", themeLabel()); b.title = themeLabel(); });
}
document.addEventListener("click", e => {
  if (!e.target.closest("[data-theme-toggle]")) return;
  const t = isDark() ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, t); } catch (x) {}
  setTheme(t);
});
sysDark.addEventListener("change", e => { let saved = null; try { saved = localStorage.getItem(THEME_KEY); } catch (x) {} if (!saved) setTheme(e.matches ? "dark" : "light"); });
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const opts = (list, v, first) => (first != null ? `<option value="">${esc(first)}</option>` : "") + list.map(x => {
  const [val, label] = Array.isArray(x) ? x : [x, x];
  return `<option value="${esc(val)}"${String(val) === String(v) ? " selected" : ""}>${esc(label)}</option>`;
}).join("");
const chips = (prefix, all, sel) => all.map((e, i) => `<label class="chip"><input type="checkbox" id="${prefix}${i}" value="${esc(e)}"${sel.includes(e) ? " checked" : ""}><span>${esc(e)}</span></label>`).join("");
const readChips = box => [...box.querySelectorAll("input:checked")].map(i => i.value);
const pad = n => String(n).padStart(2, "0");
const dateVal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeVal = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toIso = (date, t) => date && t ? new Date(`${date}T${t}`).toISOString() : "";
const fmtDay = d => new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const fmtTime = d => new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const fmtRange = (s, e) => `${fmtDay(s)}, ${fmtTime(s)}–${fmtTime(e)}`;
const fmtTs = t => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtMinutes = m => m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : m < 60 ? `${m} minutes` : `${Math.floor(m / 60)} h ${m % 60} min`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;
function nextSlot() { const d = new Date(); d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); return { date: dateVal(d), from: "10:00", to: "11:00" }; }

const STAFF = ["Admin", "Facility Manager"];
const ROUTES = {
  dashboard: { label: "Dashboard" },
  search: { label: "Find a room" },
  recommend: { label: "Recommendations" },
  book: { label: "Book a room" },
  requests: { label: "My requests" },
  approvals: { label: "Approvals", roles: STAFF },
  facilities: { label: "Facility management", roles: STAFF },
  admin: { label: "Users & roles", roles: ["Admin"] }
};
let meta = null, me = null, route = "dashboard", loginMsg = null, flash = null, options = null;
let searchState = { q: "", type: "", building: "", floor: "", capMin: "", capMax: "", equipment: [], date: "", from: "", to: "" };
let recState = null, bookPrefill = null;

function go(r) { route = r; try { history.replaceState(null, "", "#" + r); } catch (e) {} render(); window.scrollTo(0, 0); }
function toLogin(msg) { me = null; closeDlg(); loginMsg = msg || null; render(); }
/* Every API call from a page goes through here: session expiry → login page; other errors → onError (or rethrow). */
async function call(fn, onError) {
  try { return await fn(); }
  catch (e) {
    if (e.code === "EXPIRED") { toLogin({ kind: "note", text: "Session expired, please log in again" }); return undefined; }
    if (e.code === "UNAUTH") { toLogin(); return undefined; }
    if (onError) { onError(e); return undefined; }
    throw e;
  }
}
const showErr = (el, e) => { el.hidden = false; el.textContent = e.message; };

async function render() {
  const app = $("app");
  let metaErr = null;
  if (!meta) meta = await Api.meta().catch(e => { metaErr = e; return null; });
  if (!meta) {
    const detail = metaErr && metaErr.code !== "NETWORK" ? metaErr.message : "Running locally? Start it with npm run dev and reload this page.";
    app.innerHTML = `<div class="empty"><h1>Cannot reach the server</h1><p class="muted">${esc(detail)}</p><div><button type="button" class="primary" id="retry">Try again</button></div></div>`;
    $("retry").onclick = () => render();
    return;
  }
  if (!Api.hasToken()) { renderLogin(app); return; }
  me = await call(() => Api.me());
  if (!me) return;
  if (!ROUTES[route]) route = "dashboard";
  const def = ROUTES[route], staff = STAFF.includes(me.role);
  const nav = Object.keys(ROUTES).filter(k => !ROUTES[k].roles || ROUTES[k].roles.includes(me.role));
  const label = k => k === "requests" && staff ? "Requests" : ROUTES[k].label;
  app.innerHTML = `<div class="bar"><div class="brand"><i><b></b><b></b><b></b><b></b></i>Campus Facility Allocation</div>
      <div class="me"><span><b>${esc(me.name)}</b> <span class="pill role">${esc(me.role)}</span></span>${themeBtn()}<button id="logout" type="button">Logout</button></div></div>
    <nav class="tabs" aria-label="Main">${nav.map(k => `<a href="#${k}" data-go="${k}"${k === route ? ' aria-current="page"' : ""}>${label(k)}</a>`).join("")}</nav>
    <main id="page" class="stack" tabindex="-1"></main>
    ${meta.demo ? `<div class="demo"><b>Demo tools</b>
      <button class="sm" id="dIdle" type="button">Simulate ${meta.sessionMinutes} min of inactivity</button>
      <button class="sm" id="dAdmin" type="button">Open the admin URL directly</button></div>` : ""}`;
  $("logout").onclick = async () => { await Api.logout().catch(() => {}); toLogin({ kind: "ok", text: "You have logged out." }); };
  if (meta.demo) {
    $("dIdle").onclick = async () => { await call(() => Api.demo.idle()); flash = { kind: "note", text: "Idle time simulated. Click any tab to see the session expire." }; renderFlash(); };
    $("dAdmin").onclick = () => go("admin");
  }
  app.querySelectorAll("[data-go]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); go(a.dataset.go); }));
  const page = $("page");
  if (def.roles && !def.roles.includes(me.role)) {
    page.innerHTML = `<div class="empty"><h1>Access Denied</h1><p class="muted">The ${def.label.toLowerCase()} page is open to ${def.roles.join(" and ")} accounts only. You are signed in as ${esc(me.role)}.</p><div><button type="button" class="primary" id="back">Back to dashboard</button></div></div>`;
    $("back").onclick = () => go("dashboard"); return;
  }
  await ({ dashboard: pageDashboard, search: pageSearch, recommend: pageRecommend, book: pageBook, requests: pageRequests, approvals: pageApprovals, facilities: pageFacilities, admin: pageAdmin })[route](page);
  renderFlash();
}
function renderFlash() {
  const page = $("page"); if (!page || !flash) return;
  const old = page.querySelector(":scope > .flash"); if (old) old.remove();
  page.insertAdjacentHTML("afterbegin", `<div class="${flash.kind || "ok"} flash" role="status">${esc(flash.text)}</div>`); flash = null;
}

/* ===== US1: Login page ===== */
function renderLogin(app) {
  const demo = meta.demo;
  app.innerHTML = `<div class="bar"><div class="brand"><i><b></b><b></b><b></b><b></b></i>Campus Facility Allocation</div><div class="me">${themeBtn()}</div></div>
    <section class="hero"><div><span class="eyebrow">University facilities</span><h1 class="display">The right room, booked in a minute.</h1>
      <p class="lead">Search classrooms, labs and meeting rooms, get recommendations that fit your group, and send a booking request.</p></div>
      <div class="clay" aria-hidden="true"><i class="sun"></i><i class="hill h1"></i><i class="hill h2"></i><i class="bld"><b></b><b></b><b></b><b></b></i><i class="tower"></i><i class="door"></i><i class="tree"></i></div></section>
    <div class="login">
    <form class="panel" id="loginForm" novalidate autocomplete="off">
      <div class="brand"><i><b></b><b></b><b></b><b></b></i>Campus Facility Allocation</div>
      <div><h1>Log in</h1><p class="muted small">Use your university account.</p></div>
      ${loginMsg ? `<div class="${loginMsg.kind}" role="status">${esc(loginMsg.text)}</div>` : ""}
      <div class="field"><label for="username">Username</label><input type="text" id="username" autocapitalize="none" spellcheck="false" autocomplete="username"></div>
      <div class="field"><label for="password">Password</label><input type="password" id="password" autocomplete="current-password"></div>
      <div class="err" id="loginErr" hidden role="alert"></div>
      <button class="primary" type="submit" id="loginBtn" disabled>Login</button>
      <p class="muted small">Sign-in is verified by the university SSO. This system never stores your password.</p>
    </form>
    ${demo ? `<div class="stack">
      <div class="panel cream"><h2>Demo accounts</h2><p class="muted small">All use the password <span class="mono">${esc(demo.password)}</span>. Click one to fill the form.</p>
        <div class="accts">${demo.accounts.map(a => `<button type="button" data-u="${esc(a.username)}"><span class="mono">${esc(a.username)}</span><span class="muted">${esc(a.name)} · ${esc(a.role)}</span></button>`).join("")}</div></div>
      <div class="panel cream"><h2>Demo tools</h2>
        <label class="check"><input type="checkbox" id="ssoDown"${demo.ssoDown ? " checked" : ""}> Simulate SSO server outage</label>
        <p class="muted small">${meta.maxFails} wrong passwords in a row lock a username for ${meta.lockSeconds} seconds. Sessions end after ${meta.sessionMinutes} minutes without activity.</p>
        <div><button type="button" class="sm" id="reset">Reset demo data</button></div></div>
    </div>` : ""}</div>`;
  loginMsg = null;
  const u = $("username"), p = $("password"), btn = $("loginBtn"), sync = () => { btn.disabled = !(u.value.trim() && p.value); };
  u.oninput = sync; p.oninput = sync; u.focus();
  if (demo) {
    app.querySelectorAll("[data-u]").forEach(b => b.onclick = () => { u.value = b.dataset.u; p.value = demo.password; sync(); btn.focus(); });
    $("ssoDown").onchange = async e => { await Api.demo.sso(e.target.checked); meta.demo.ssoDown = e.target.checked; };
    $("reset").onclick = async () => { await Api.demo.reset(); meta = null; loginMsg = { kind: "ok", text: "Demo data was reset." }; render(); };
  }
  $("loginForm").onsubmit = async e => {
    e.preventDefault(); btn.disabled = true;
    try { route = (await Api.login(u.value, p.value)).redirect; meta = null; options = null; render(); }
    catch (x) { showErr($("loginErr"), x); p.value = ""; sync(); p.focus(); }
  };
}

/* ===== Dashboard ===== */
async function pageDashboard(el) {
  const d = await call(() => Api.dashboard()); if (!d) return;
  const staff = STAFF.includes(me.role), L = me.limits;
  const links = [["search", "Find a room", "Search and filter the catalogue."], ["recommend", "Get recommendations", "Tell us what you need; we rank the best free rooms."], ["book", "Book a room", "Send a booking request for a date and time."]];
  if (staff) links.push(["approvals", "Review requests", "Approve or reject pending booking requests."], ["facilities", "Manage facilities", "Create, edit and delete rooms in the catalogue."]);
  if (me.role === "Admin") links.push(["admin", "Users & roles", "Assign roles and read the audit and sign-in logs."]);
  const stats = [["Active facilities", d.activeFacilities], ["Under maintenance", d.underMaintenance], ["Buildings", d.buildings],
    staff ? ["Pending requests", d.pendingRequests] : ["Your active bookings", `${L.active}/${L.maxActive}`]];
  el.innerHTML = `<div><span class="eyebrow">Dashboard</span><h1>Welcome, ${esc(me.name)}</h1>
      <p class="muted">${esc(me.role)} account. Up to ${plural(L.maxActive, "active booking")} at a time, ${fmtMinutes(L.maxMinutes)} per booking.</p></div>
    <div class="grid4">${stats.map((s, i) => `<div class="card stat ${["pink", "ochre", "lavender", "peach"][i]}"><b>${s[1]}</b><span class="muted small">${s[0]}</span></div>`).join("")}</div>
    <div class="panel cream"><div class="between"><h2>Your upcoming bookings</h2><a href="#requests" data-go2="requests" class="small">All requests</a></div>
      ${d.upcoming.length ? `<ul class="list">${d.upcoming.map(b => `<li><div class="l1"><b>${esc(b.facilityName)}</b>${statusPill(b.status)}</div><div class="small">${esc(fmtRange(b.start, b.end))} · ${esc(b.purpose)}</div><div class="muted small mono">${esc(b.id)}</div></li>`).join("")}</ul>`
        : `<p class="muted">Nothing booked yet. <a href="#book" data-go2="book">Book a room</a>.</p>`}</div>
    <div class="grid3">${links.map((l, i) => `<a class="qlink ${["teal", "lavender", "peach", "ochre", "pink", "teal"][i]}" href="#${l[0]}" data-go2="${l[0]}"><b>${l[1]}</b><span class="muted small">${l[2]}</span></a>`).join("")}</div>`;
  el.querySelectorAll("[data-go2]").forEach(a => a.onclick = e => { e.preventDefault(); go(a.dataset.go2); });
}
const statusPill = s => `<span class="pill ${({ Pending: "pending", Approved: "approved", Rejected: "fail", Cancelled: "" })[s] || ""}">${esc(s)}</span>`;
async function getOptions() { if (!options) options = await call(() => Api.searchOptions()); return options; }

/* ===== US4: Search & browse ===== */
function availability(f, windowed) {
  if (f.status === "Under Maintenance") return `<span class="avail maint">Under maintenance</span>`;
  if (windowed) return `<span class="avail free">Free for your selected time</span>`;
  if (f.busyUntil) return `<span class="avail busy">In use until ${esc(fmtTime(f.busyUntil))}</span>`;
  return `<span class="avail free">Available now</span>`;
}
async function pageSearch(el) {
  const o = await getOptions(); if (!o) return;
  const s = searchState;
  el.innerHTML = `<div><span class="eyebrow">User story 4</span><h1>Find a room</h1></div>
    <form class="panel" id="sForm" novalidate role="search" aria-label="Facility search">
      <div class="field"><label for="s-q">Search</label><input type="search" id="s-q" value="${esc(s.q)}" placeholder="Name, building or equipment"></div>
      <div class="grid4">
        <div class="field"><label for="s-type">Type</label><select id="s-type">${opts(meta.types, s.type, "Any type")}</select></div>
        <div class="field"><label for="s-building">Building</label><select id="s-building">${opts(o.buildings, s.building, "Any building")}</select></div>
        <div class="field"><label for="s-floor">Floor</label><select id="s-floor">${opts(o.floors.map(String), s.floor, "Any floor")}</select></div>
        <div class="field"><span class="lbl" id="s-cap-l">Seats</span><div class="row2"><input type="number" id="s-min" min="1" value="${esc(s.capMin)}" placeholder="Min" aria-label="Minimum seats"><input type="number" id="s-max" min="1" value="${esc(s.capMax)}" placeholder="Max" aria-label="Maximum seats"></div></div>
      </div>
      <fieldset class="field"><legend class="lbl">Free during (optional)</legend><div class="grid3">
        <input type="date" id="s-date" value="${esc(s.date)}" aria-label="Date"><input type="time" id="s-from" step="900" value="${esc(s.from)}" aria-label="From"><input type="time" id="s-to" step="900" value="${esc(s.to)}" aria-label="To"></div></fieldset>
      <fieldset class="field"><legend class="lbl">Equipment</legend><div class="chips" id="s-eq">${chips("s-eq", o.equipment, s.equipment)}</div></fieldset>
      <div class="err" id="s-err" hidden role="alert"></div>
      <div class="actions" style="justify-content:flex-start"><button class="primary" type="submit">Search</button><button type="button" id="s-clear">Clear filters</button></div>
    </form>
    <div class="between" id="s-sum" aria-live="polite"></div><div class="grid3" id="s-res"></div>`;
  const read = () => Object.assign(searchState, { q: $("s-q").value, type: $("s-type").value, building: $("s-building").value, floor: $("s-floor").value,
    capMin: $("s-min").value, capMax: $("s-max").value, equipment: readChips($("s-eq")), date: $("s-date").value, from: $("s-from").value, to: $("s-to").value });
  let seq = 0;
  const show = async () => {
    const st = read(), my = ++seq; $("s-err").hidden = true;
    const windowed = !!(st.date && st.from && st.to);
    const r = await call(() => Api.search({ q: st.q, type: st.type, building: st.building, floor: st.floor, capMin: st.capMin, capMax: st.capMax, equipment: st.equipment,
      start: windowed ? toIso(st.date, st.from) : "", end: windowed ? toIso(st.date, st.to) : "" }), e => showErr($("s-err"), e));
    if (!r || my !== seq) return;
    $("s-sum").innerHTML = `<h2>${plural(r.results.length, "facility", "facilities")}</h2><span class="muted small">${windowed ? `Free on ${esc(fmtRange(toIso(st.date, st.from), toIso(st.date, st.to)))} · ` : ""}${r.ms} ms</span>`;
    $("s-res").innerHTML = r.results.length ? r.results.map(f => `<button type="button" class="fcard" data-f="${esc(f.id)}" aria-label="${esc(f.name)}, open details">
        <div class="top"><div><div class="code">${esc(f.name)}</div><div class="muted small">${esc(f.type)} · ${esc(f.building)} · floor ${f.floor}</div></div><span class="seats"><b>${f.capacity}</b> seats</span></div>
        ${availability(f, windowed)}
        <div class="tags">${f.equipment.map(e => `<span class="tag">${esc(e)}</span>`).join("") || '<span class="muted small">No equipment listed</span>'}</div></button>`).join("")
      : `<div class="empty" style="grid-column:1/-1"><h3>${esc(r.message)}</h3>${r.suggestions.length ? `<p class="muted small">Try one of these:</p><div class="chips">${r.suggestions.map((x, i) => `<button type="button" class="sm" data-sug="${i}">${esc(x.label)} (${plural(x.count, "room")})</button>`).join("")}</div>` : ""}</div>`;
    el.querySelectorAll("[data-f]").forEach(b => b.onclick = () => facilityDlg(b.dataset.f, windowed ? { date: st.date, from: st.from, to: st.to } : null));
    el.querySelectorAll("[data-sug]").forEach(b => b.onclick = () => {
      const p = r.suggestions[b.dataset.sug].patch;
      if ("equipment" in p) searchState.equipment = p.equipment;
      for (const k of ["q", "type", "building"]) if (k in p) searchState[k] = p[k] || "";
      if ("floor" in p) searchState.floor = "";
      if ("capMin" in p) searchState.capMin = ""; if ("capMax" in p) searchState.capMax = "";
      if ("start" in p) Object.assign(searchState, { date: "", from: "", to: "" });
      pageSearch(el);
    });
  };
  let timer;
  $("sForm").oninput = e => { if (e.target.type === "date" || e.target.type === "time") return; clearTimeout(timer); timer = setTimeout(show, 250); };
  $("sForm").onchange = () => { clearTimeout(timer); show(); };
  $("sForm").onsubmit = e => { e.preventDefault(); clearTimeout(timer); show(); };
  $("s-clear").onclick = () => { searchState = { q: "", type: "", building: "", floor: "", capMin: "", capMax: "", equipment: [], date: "", from: "", to: "" }; pageSearch(el); };
  await show();
}
async function facilityDlg(id, slot) {
  const f = await call(() => Api.facility(id), e => { flash = { kind: "err", text: e.message }; renderFlash(); }); if (!f) return;
  openDlg(`<div><span class="eyebrow">${esc(f.id)} · ${esc(f.type)}</span><h2>${esc(f.name)}</h2></div>
    <dl class="facts"><div><dt>Building</dt><dd>${esc(f.building)}, floor ${f.floor}</dd></div><div><dt>Capacity</dt><dd>${f.capacity} seats</dd></div>
      <div><dt>Status</dt><dd>${esc(f.status)}</dd></div><div><dt>Equipment</dt><dd>${esc(f.equipment.join(", ")) || "None listed"}</dd></div></dl>
    <div><h3>Next 14 days</h3>${f.schedule.length ? `<ul class="list small" style="margin-top:8px">${f.schedule.map(b => `<li><div class="l1"><span>${esc(fmtRange(b.start, b.end))}</span>${statusPill(b.status === "Approved" ? "Approved" : "Pending")}</div>${b.purpose ? `<div class="muted">${esc(b.purpose)}</div>` : ""}</li>`).join("")}</ul>` : `<p class="muted small">No bookings. The room is free.</p>`}</div>
    <div class="actions"><button type="button" id="d-close">Close</button>${f.status === "Active" ? `<button type="button" class="primary" id="d-book">Request this room</button>` : ""}</div>`);
  $("d-close").onclick = closeDlg;
  if ($("d-book")) $("d-book").onclick = () => { closeDlg(); bookPrefill = { facilityId: f.id, ...(slot || {}) }; go("book"); };
}

/* ===== US6: Recommendations ===== */
async function pageRecommend(el) {
  const o = await getOptions(); if (!o) return;
  const s = recState || (recState = { capacity: "", equipment: [], building: "", purpose: "", ...nextSlot() });
  el.innerHTML = `<div><span class="eyebrow">User story 6</span><h1>Room recommendations</h1><p class="muted">Tell us what you need. We rank the rooms that are free for the whole time by seat fit, equipment, building and your booking history.</p></div>
    <form class="panel" id="rForm" novalidate>
      <div class="grid4">
        <div class="field"><label for="r-cap">People</label><input type="number" id="r-cap" min="1" value="${esc(s.capacity)}" placeholder="e.g. 35"></div>
        <div class="field"><label for="r-date">Date</label><input type="date" id="r-date" value="${esc(s.date)}"></div>
        <div class="field"><label for="r-from">From</label><input type="time" id="r-from" step="900" value="${esc(s.from)}"></div>
        <div class="field"><label for="r-to">To</label><input type="time" id="r-to" step="900" value="${esc(s.to)}"></div>
      </div>
      <div class="row2"><div class="field"><label for="r-building">Preferred building</label><select id="r-building">${opts(o.buildings, s.building, "No preference")}</select></div>
        <div class="field"><label for="r-purpose">Purpose</label><input type="text" id="r-purpose" value="${esc(s.purpose)}" placeholder="e.g. Seminar"></div></div>
      <fieldset class="field"><legend class="lbl">Needed equipment</legend><div class="chips" id="r-eq">${chips("r-eq", o.equipment, s.equipment)}</div></fieldset>
      <div class="err" id="r-err" hidden role="alert"></div>
      <div class="actions" style="justify-content:flex-start"><button class="primary" type="submit">Recommend rooms</button></div>
    </form><div id="r-res" class="stack" aria-live="polite"></div>`;
  const read = () => Object.assign(recState, { capacity: $("r-cap").value, date: $("r-date").value, from: $("r-from").value, to: $("r-to").value, building: $("r-building").value, purpose: $("r-purpose").value, equipment: readChips($("r-eq")) });
  const run = async () => {
    const st = read(); $("r-err").hidden = true;
    const r = await call(() => Api.recommend({ capacity: st.capacity, equipment: st.equipment, building: st.building, purpose: st.purpose, start: toIso(st.date, st.from), end: toIso(st.date, st.to) }), e => showErr($("r-err"), e));
    if (!r) return;
    const box = $("r-res");
    if (!r.results.length) {
      box.innerHTML = `<div class="empty"><h3>${esc(r.message)}</h3>${r.suggestions.length ? `<p class="muted small">You could:</p><div class="chips">${r.suggestions.map((x, i) => `<button type="button" class="sm" data-sug="${i}">${esc(x.label)} (${plural(x.count, "room")})</button>`).join("")}</div>` : "<p class=\"muted small\">Try another day, a smaller group or fewer equipment needs.</p>"}</div>`;
      box.querySelectorAll("[data-sug]").forEach(b => b.onclick = () => {
        const p = r.suggestions[b.dataset.sug].patch;
        if (p.equipment) recState.equipment = p.equipment;
        if (p.capMin) recState.capacity = String(p.capMin);
        if (p.start) { const a = new Date(p.start), z = new Date(p.end); Object.assign(recState, { date: dateVal(a), from: timeVal(a), to: timeVal(z) }); }
        pageRecommend(el).then(() => $("rForm").requestSubmit());
      });
      return;
    }
    box.innerHTML = `<div class="between"><h2>${plural(r.results.length, "room")} free ${esc(fmtRange(toIso(st.date, st.from), toIso(st.date, st.to)))}</h2><span class="muted small">${r.ms} ms</span></div>
      <ol class="recs">${r.results.map((f, i) => `<li class="panel rec">
        <div class="between"><div><span class="rank">#${i + 1}</span> <b class="code">${esc(f.name)}</b><div class="muted small">${esc(f.type)} · ${esc(f.building)} · floor ${f.floor} · ${f.capacity} seats</div></div>
          <div class="score" aria-label="Match ${f.score} percent"><b>${f.score}%</b><span class="meter"><span style="width:${f.score}%"></span></span></div></div>
        <ul class="reasons small">${f.reasons.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
        <div><button type="button" class="${i === 0 ? "primary" : ""}" data-book="${esc(f.id)}">Book this room</button></div></li>`).join("")}</ol>`;
    box.querySelectorAll("[data-book]").forEach(b => b.onclick = () => {
      bookPrefill = { facilityId: b.dataset.book, date: st.date, from: st.from, to: st.to, purpose: st.purpose, attendees: st.capacity }; go("book");
    });
  };
  $("rForm").onsubmit = e => { e.preventDefault(); run(); };
}

/* ===== US5: Booking request ===== */
async function pageBook(el) {
  const o = await getOptions(); if (!o) return;
  const all = await call(() => Api.search({})); if (!all) return;
  const rooms = all.results.filter(f => f.status === "Active");
  const p = { facilityId: "", purpose: "", attendees: "", ...nextSlot(), ...(bookPrefill || {}) }; bookPrefill = null;
  const L = me.limits;
  el.innerHTML = `<div><span class="eyebrow">User story 5</span><h1>Book a room</h1>
      <p class="muted">As ${/^[AEIOU]/.test(me.role) ? "an" : "a"} ${esc(me.role)} you can hold ${plural(L.maxActive, "active booking")} (you have ${L.active}) and book up to ${fmtMinutes(L.maxMinutes)} at a time. Requests stay <b>Pending</b> until a facility manager or admin approves or rejects them.</p></div>
    <form class="panel" id="bForm" novalidate>
      <div class="field"><label for="b-fac">Room</label><select id="b-fac">${opts(rooms.map(f => [f.id, `${f.name} · ${f.building} · ${f.capacity} seats`]), p.facilityId, "Recommend the best free room for me")}</select></div>
      <div class="grid3">
        <div class="field"><label for="b-date">Date</label><input type="date" id="b-date" value="${esc(p.date)}" required></div>
        <div class="field"><label for="b-from">Start time</label><input type="time" id="b-from" step="900" value="${esc(p.from)}" required></div>
        <div class="field"><label for="b-to">End time</label><input type="time" id="b-to" step="900" value="${esc(p.to)}" required></div>
      </div>
      <div class="row2"><div class="field"><label for="b-att">Expected attendees</label><input type="number" id="b-att" min="1" value="${esc(p.attendees)}" required></div>
        <div class="field"><label for="b-purpose">Purpose</label><input type="text" id="b-purpose" maxlength="200" value="${esc(p.purpose)}" placeholder="e.g. Database lab session" required></div></div>
      <fieldset class="field" id="b-eqbox"${p.facilityId ? " hidden" : ""}><legend class="lbl">Needed equipment (used to choose the room)</legend><div class="chips" id="b-eq">${chips("b-eq", o.equipment, [])}</div></fieldset>
      <div class="err" id="b-err" hidden role="alert"></div>
      <div class="actions" style="justify-content:flex-start"><button class="primary" type="submit" id="b-submit">Submit request</button></div>
    </form><div id="b-done"></div>`;
  $("b-fac").onchange = () => { $("b-eqbox").hidden = !!$("b-fac").value; };
  $("bForm").onsubmit = async e => {
    e.preventDefault();
    const err = $("b-err"); err.hidden = true;
    const date = $("b-date").value, from = $("b-from").value, to = $("b-to").value;
    if (date && from && to && to <= from) { showErr(err, "End time must be after the start time."); $("b-to").focus(); return; }
    $("b-submit").disabled = true;
    const b = await call(() => Api.book({ facilityId: $("b-fac").value, start: toIso(date, from), end: toIso(date, to), attendees: $("b-att").value, purpose: $("b-purpose").value, equipment: readChips($("b-eq")) }),
      x => { showErr(err, x.message); if (x.extra.conflicts) err.innerHTML += `<ul class="small" style="margin:6px 0 0;padding-left:18px">${x.extra.conflicts.map(c => `<li>${esc(fmtRange(c.start, c.end))} · ${esc(c.status)}</li>`).join("")}</ul>`; });
    $("b-submit").disabled = false;
    if (!b) return;
    me = await call(() => Api.me()) || me;
    $("bForm").reset(); $("bForm").hidden = true;
    $("b-done").innerHTML = `<div class="panel done" role="status" tabindex="-1" id="b-ok"><span class="eyebrow">Request submitted</span>
      <h2>Your request ID is <span class="mono">${esc(b.id)}</span></h2>
      <p>${esc(b.facilityName)}${b.recommended ? " (chosen for you as the best match)" : ""} · ${esc(fmtRange(b.start, b.end))} · ${plural(b.attendees, "attendee")}</p>
      <p>Status: ${statusPill(b.status)} A facility manager will review it.</p>
      <div class="actions" style="justify-content:flex-start"><button type="button" class="primary" id="b-again">Make another request</button><button type="button" id="b-list">View my requests</button></div></div>`;
    $("b-ok").focus();
    $("b-again").onclick = () => pageBook(el);
    $("b-list").onclick = () => go("requests");
  };
}
async function pageRequests(el, everyone) {
  const staff = STAFF.includes(me.role);
  const list = await call(() => Api.bookings(staff && everyone)); if (!list) return;
  el.innerHTML = `<div class="between"><div><span class="eyebrow">User story 5</span><h1>${staff && everyone ? "All requests" : "My requests"}</h1></div>
      ${staff ? `<div class="seg" role="group" aria-label="Show"><button type="button" id="q-mine" aria-pressed="${!everyone}">Mine</button><button type="button" id="q-all" aria-pressed="${!!everyone}">Everyone</button></div>` : ""}</div>
    ${list.length ? `<div class="scroll"><table><thead><tr><th>Request ID</th><th>Room</th><th>When</th>${staff && everyone ? "<th>Requested by</th>" : ""}<th style="text-align:right">People</th><th>Purpose</th><th>Status</th></tr></thead><tbody>
      ${list.map(b => `<tr><td class="mono">${esc(b.id)}</td><td style="font-weight:600">${esc(b.facilityName)}</td><td>${esc(fmtRange(b.start, b.end))}</td>${staff && everyone ? `<td>${esc(b.userName)}</td>` : ""}<td class="num">${b.attendees}</td><td>${esc(b.purpose)}</td><td>${statusPill(b.status)}${decisionInfo(b)}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty"><h3>No requests yet</h3><div><button type="button" class="primary" id="q-book">Book a room</button></div></div>`}`;
  if ($("q-mine")) { $("q-mine").onclick = () => pageRequests(el, false); $("q-all").onclick = () => pageRequests(el, true); }
  if ($("q-book")) $("q-book").onclick = () => go("book");
}

const decisionInfo = b => b.decidedBy ? `<div class="muted small">${esc(b.status === "Rejected" ? "Rejected" : "Approved")} by ${esc(b.decidedBy)}${b.decidedAt ? ", " + esc(fmtTs(b.decidedAt)) : ""}</div>${b.note ? `<div class="small">${b.status === "Rejected" ? "Reason: " : "Note: "}${esc(b.note)}</div>` : ""}` : "";

/* ===== Approval: Admin / Facility Manager review Pending requests ===== */
async function pageApprovals(el) {
  const list = await call(() => Api.approvals(), e => { el.innerHTML = `<div class="empty"><h1>${esc(e.message)}</h1></div>`; }); if (!list) return;
  el.innerHTML = `<div><span class="eyebrow">Approval</span><h1>Pending requests</h1>
      <p class="muted">Approve a request to confirm the room, or reject it with a reason the requester will see. You cannot decide your own requests. Every decision is written to the audit log.</p></div>
    ${list.length ? `<div class="scroll"><table><thead><tr><th>Request ID</th><th>Room</th><th>When</th><th>Requested by</th><th style="text-align:right">People</th><th>Purpose</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${list.map(b => `<tr><td class="mono">${esc(b.id)}</td><td style="font-weight:600">${esc(b.facilityName)}</td><td>${esc(fmtRange(b.start, b.end))}</td><td>${esc(b.userName)}</td><td class="num">${b.attendees}</td><td>${esc(b.purpose)}</td>
        <td style="white-space:nowrap">${b.username === me.username ? '<span class="muted small">Your request</span>' : `<button class="sm primary" type="button" data-ok="${esc(b.id)}">Approve</button> <button class="sm" type="button" data-no="${esc(b.id)}">Reject</button>`}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty"><h3>No pending requests</h3><p class="muted small">New booking requests will appear here.</p></div>`}`;
  const find = id => list.find(b => b.id === id);
  el.querySelectorAll("[data-ok]").forEach(btn => btn.onclick = async () => {
    btn.disabled = true;
    const b = find(btn.dataset.ok);
    const r = await call(() => Api.decide(b.id, "Approved"), x => {
      flash = { kind: "err", text: x.message + (x.extra.conflicts ? " Conflicting: " + x.extra.conflicts.map(c => `${c.id} (${fmtRange(c.start, c.end)})`).join(", ") : "") };
    });
    if (r) flash = { text: `${r.id} approved. ${r.facilityName} is booked for ${r.userName}.` };
    if (Api.hasToken()) render();
  });
  el.querySelectorAll("[data-no]").forEach(btn => btn.onclick = () => rejectDlg(find(btn.dataset.no)));
}
function rejectDlg(b) {
  openDlg(`<form id="jForm" novalidate><div><span class="eyebrow mono">${esc(b.id)}</span><h2>Reject this request?</h2></div>
    <p class="muted">${esc(b.facilityName)} · ${esc(fmtRange(b.start, b.end))} · requested by ${esc(b.userName)}</p>
    <div class="field"><label for="j-note">Reason (shown to the requester)</label><input type="text" id="j-note" maxlength="200" placeholder="e.g. Room is reserved for exams that week"></div>
    <div class="err" id="j-err" hidden role="alert"></div>
    <div class="actions"><button type="button" id="j-cancel">Cancel</button><button class="danger" type="submit">Reject request</button></div></form>`);
  $("j-note").focus();
  $("j-cancel").onclick = closeDlg;
  $("jForm").onsubmit = async e => {
    e.preventDefault();
    const note = $("j-note").value.trim();
    if (!note) { showErr($("j-err"), { message: "Enter a reason for the rejection." }); $("j-note").focus(); return; }
    const r = await call(() => Api.decide(b.id, "Rejected", note), x => showErr($("j-err"), x));
    if (r) { closeDlg(); flash = { text: `${r.id} rejected. ${r.userName} will see your reason.` }; render(); }
  };
}

/* ===== US3: Facility management ===== */
async function pageFacilities(el) {
  const list = await call(() => Api.facilities(), e => { el.innerHTML = `<div class="empty"><h1>${esc(e.message)}</h1></div>`; }); if (!list) return;
  const o = await getOptions();
  el.innerHTML = `<div class="between"><div><span class="eyebrow">User story 3</span><h1>Facility inventory</h1></div><button class="primary" type="button" id="f-add">Add facility</button></div>
    <div class="scroll"><table><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Building</th><th style="text-align:right">Floor</th><th style="text-align:right">Seats</th><th>Equipment</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
    ${list.map(f => `<tr><td class="mono">${esc(f.id)}</td><td style="font-weight:600">${esc(f.name)}</td><td>${esc(f.type)}</td><td>${esc(f.building)}</td><td class="num">${f.floor}</td><td class="num">${f.capacity}</td><td class="small">${esc(f.equipment.join(", ")) || "—"}</td><td><span class="pill ${f.status === "Active" ? "active" : f.status === "Inactive" ? "" : "maint"}">${esc(f.status)}</span></td>
      <td style="white-space:nowrap"><button class="link" type="button" data-edit="${esc(f.id)}">Edit</button> &nbsp; <button class="link danger-link" type="button" data-del="${esc(f.id)}">Delete</button></td></tr>`).join("")}
    </tbody></table></div><p class="muted small">Every change is written to the audit log (Users &amp; roles page, Admin only).</p>`;
  $("f-add").onclick = () => editFacility(null, list, o);
  el.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => editFacility(list.find(f => f.id === b.dataset.edit), list, o));
  el.querySelectorAll("[data-del]").forEach(b => b.onclick = () => deleteFacilityDlg(list.find(f => f.id === b.dataset.del)));
}
function editFacility(f, list, o) {
  const v = f || { name: "", type: "Classroom", capacity: "", building: "", floor: "", equipment: [], status: "Active" };
  const buildings = [...new Set(list.map(x => x.building))].sort();
  openDlg(`<form id="fForm" novalidate><div><span class="eyebrow">${f ? esc(f.id) : "New facility"}</span><h2>${f ? "Edit " + esc(f.name) : "Add a facility"}</h2></div>
    <div class="field"><label for="f-name">Name</label><input type="text" id="f-name" value="${esc(v.name)}" placeholder="e.g. MB-220 Classroom"></div>
    <div class="row2"><div class="field"><label for="f-type">Type</label><select id="f-type">${opts(meta.types, v.type)}</select></div><div class="field"><label for="f-cap">Capacity (seats)</label><input type="text" inputmode="numeric" id="f-cap" value="${esc(v.capacity)}"></div></div>
    <div class="row2"><div class="field"><label for="f-building">Building</label><input type="text" id="f-building" list="f-blist" value="${esc(v.building)}"><datalist id="f-blist">${buildings.map(b => `<option value="${esc(b)}">`).join("")}</datalist></div><div class="field"><label for="f-floor">Floor</label><input type="text" inputmode="numeric" id="f-floor" value="${esc(v.floor)}"></div></div>
    <fieldset class="field"><legend class="lbl">Equipment</legend><div class="chips" id="f-eq">${chips("f-eq", o.equipment, v.equipment)}</div></fieldset>
    <div class="field"><label for="f-status">Status</label><select id="f-status">${opts(meta.statuses, v.status)}</select></div>
    <div class="err" id="f-err" hidden role="alert"></div><div class="actions"><button type="button" id="f-cancel">Cancel</button><button class="primary" type="submit">${f ? "Save changes" : "Create facility"}</button></div></form>`);
  $("f-cancel").onclick = closeDlg;
  const save = async force => {
    const err = $("f-err");
    const saved = await call(() => Api.saveFacility({ id: f && f.id, name: $("f-name").value, type: $("f-type").value, capacity: $("f-cap").value, building: $("f-building").value, floor: $("f-floor").value, equipment: readChips($("f-eq")), status: $("f-status").value, force }), x => {
      showErr(err, x);
      if (x.code !== "HAS_BOOKINGS") return;
      /* The edit would invalidate existing bookings: list them; only an Admin may save anyway (they are cancelled). */
      err.innerHTML += `<ul class="small" style="margin:6px 0 0;padding-left:18px">${x.extra.conflicts.map(c => `<li><span class="mono">${esc(c.id)}</span> · ${esc(fmtRange(c.start, c.end))} · ${esc(c.user)} · ${plural(c.attendees, "person", "people")}</li>`).join("")}</ul>
        <p class="small" style="margin:6px 0 0">${me.role === "Admin" ? "As an Admin you can save anyway. These bookings will be cancelled." : "Only an Admin can save this change. Cancel or move these bookings first."}</p>
        ${me.role === "Admin" ? `<div style="margin-top:8px"><button type="button" class="danger sm" id="f-force">Save and cancel ${plural(x.extra.conflicts.length, "booking")}</button></div>` : ""}`;
      if ($("f-force")) $("f-force").onclick = () => save(true);
    });
    if (saved) { closeDlg(); options = null; flash = { text: `${saved.name} was ${f ? "updated" : "created"}${saved.cancelled ? `, ${plural(saved.cancelled, "booking")} cancelled` : ""}.` }; render(); }
  };
  $("fForm").onsubmit = e => { e.preventDefault(); save(false); };
}
async function deleteFacilityDlg(f) {
  const conflicts = await call(() => Api.futureBookings(f.id)); if (!conflicts) return;
  const admin = me.role === "Admin";
  openDlg(`<h2>Delete ${esc(f.name)}?</h2>${conflicts.length ? `<div class="err">Deletion is blocked. This facility has ${plural(conflicts.length, "future booking")}:</div><ul class="small" style="margin:0;padding-left:18px">${conflicts.map(c => `<li><span class="mono">${esc(c.id)}</span> · ${esc(fmtRange(c.start, c.end))} · ${esc(c.status)} · ${esc(c.user)}</li>`).join("")}</ul>
      <p class="muted small">${admin ? "As an Admin you can force the deletion. The bookings above will be cancelled." : "Only an Admin can force the deletion. Cancel or move these bookings first."}</p>` : `<p class="muted">It has no future bookings. This removes it from the catalogue.</p>`}
    <div class="err" id="x-err" hidden role="alert"></div><div class="actions"><button type="button" id="x-cancel">Keep facility</button>${conflicts.length ? (admin ? `<button class="danger" type="button" id="x-force">Force delete and cancel bookings</button>` : "") : `<button class="danger" type="button" id="x-del">Delete facility</button>`}</div>`);
  $("x-cancel").onclick = closeDlg;
  const doIt = async force => { const r = await call(() => Api.deleteFacility(f.id, force), x => showErr($("x-err"), x)); if (r) { closeDlg(); options = null; flash = { text: `${f.name} was deleted${r.cancelled ? `, ${plural(r.cancelled, "booking")} cancelled` : ""}.` }; render(); } };
  if ($("x-del")) $("x-del").onclick = () => doIt(false);
  if ($("x-force")) $("x-force").onclick = () => doIt(true);
}

/* ===== US2: Users & roles ===== */
async function pageAdmin(el) {
  const users = await call(() => Api.users(), e => { el.innerHTML = `<div class="empty"><h1>${esc(e.message)}</h1></div>`; }); if (!users) return;
  const logs = await call(() => Api.logs()); if (!logs) return;
  el.innerHTML = `<div><span class="eyebrow">User story 2</span><h1>Users &amp; roles</h1><p class="muted">Each user has exactly one role. A change is saved at once and applies from that user's next login.</p></div>
    <div class="scroll"><table><thead><tr><th>Username</th><th>Name</th><th>Email</th><th>Role</th><th>Booking limits</th></tr></thead><tbody>
    ${users.map(u => `<tr><td class="mono">${esc(u.username)}</td><td>${esc(u.name)}</td><td class="small">${esc(u.email)}</td><td><select data-role="${esc(u.username)}" id="role-${esc(u.username)}" aria-label="Role for ${esc(u.name)}"${u.username === me.username ? " disabled" : ""}>${opts(meta.roles, u.role)}</select>${u.username === me.username ? '<div class="muted small">You cannot change your own role.</div>' : ""}</td><td class="small">${u.maxActive} active · ${fmtMinutes(u.maxMinutes)} each</td></tr>`).join("")}
    </tbody></table></div>
    <div class="grid3" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
      <div class="panel"><h2>Audit log</h2><ul class="list">${logs.audit.length ? logs.audit.slice(0, 15).map(a => `<li><div class="l1"><b>${esc(a.action)}</b><span class="muted small mono">${esc(fmtTs(a.ts))}</span></div><div class="small">${esc(a.detail)}</div><div class="muted small">by ${esc(a.user)}</div></li>`).join("") : '<li class="muted">No changes recorded yet.</li>'}</ul></div>
      <div class="panel"><h2>Sign-in log</h2><ul class="list">${logs.loginLog.length ? logs.loginLog.slice(0, 15).map(a => `<li><div class="l1"><span><span class="mono">${esc(a.username)}</span> <span class="pill ${a.ok ? "pass" : "fail"}">${a.ok ? "OK" : "Failed"}</span></span><span class="muted small mono">${esc(fmtTs(a.ts))}</span></div><div class="small muted">${esc(a.detail)}</div></li>`).join("") : '<li class="muted">No sign-ins recorded yet.</li>'}</ul></div></div>`;
  el.querySelectorAll("[data-role]").forEach(s => s.onchange = async () => {
    const u = await call(() => Api.setRole(s.dataset.role, s.value), x => { flash = { kind: "err", text: x.message }; });
    if (u) flash = { text: `${u.name} is now ${u.role}. Saved; it applies from their next login.` };
    if (Api.hasToken()) render();
  });
}

function openDlg(html) { $("dlgBody").innerHTML = html; const d = $("dlg"); if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute("open", ""); } }
function closeDlg() { const d = $("dlg"); if (d.open) { if (d.close) d.close(); else d.removeAttribute("open"); } }

/* Boot */
try { const h = location.hash.slice(1); if (ROUTES[h]) route = h; } catch (e) {}
window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (ROUTES[h] && h !== route) { route = h; render(); } });
$("dlg").addEventListener("click", e => { if (e.target === $("dlg")) closeDlg(); });
render();
