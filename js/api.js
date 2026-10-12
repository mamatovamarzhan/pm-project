/* Browser client for the REST API in server/server.js. Keeps the session token and turns HTTP errors into ApiError. */
"use strict";
const Api = (() => {
  const KEY = "cfa-token";
  let token = null;
  try { token = sessionStorage.getItem(KEY); } catch (e) {}
  const setToken = t => { token = t; try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch (e) {} };

  class ApiError extends Error { constructor(code, message, extra) { super(message); this.code = code; this.extra = extra || {}; } }

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { throw new ApiError("NETWORK", "Cannot reach the server. Is it running?"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.code === "EXPIRED" || data.code === "UNAUTH") setToken(null);
      const { code, message, ...extra } = data;
      throw new ApiError(code || "SERVER", message || "Something went wrong.", extra);
    }
    return data;
  }
  const qs = o => Object.entries(o).filter(([, v]) => v !== "" && v != null && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(Array.isArray(v) ? v.join(",") : v)).join("&");

  return {
    ApiError,
    hasToken: () => !!token,
    meta: () => call("GET", "/api/meta"),
    async login(username, password) { const r = await call("POST", "/api/login", { username, password }); setToken(r.token); return r; },
    async logout() { try { await call("POST", "/api/logout"); } finally { setToken(null); } },
    me: () => call("GET", "/api/me"),
    dashboard: () => call("GET", "/api/dashboard"),
    users: () => call("GET", "/api/users"),
    setRole: (username, role) => call("PUT", `/api/users/${encodeURIComponent(username)}/role`, { role }),
    logs: () => call("GET", "/api/logs"),
    facilities: () => call("GET", "/api/facilities"),
    saveFacility: f => f.id ? call("PUT", `/api/facilities/${encodeURIComponent(f.id)}`, f) : call("POST", "/api/facilities", f),
    futureBookings: id => call("GET", `/api/facilities/${encodeURIComponent(id)}/future-bookings`),
    deleteFacility: (id, force) => call("DELETE", `/api/facilities/${encodeURIComponent(id)}${force ? "?force=1" : ""}`),
    search: f => call("GET", "/api/search?" + qs(f)),
    searchOptions: () => call("GET", "/api/search/options"),
    facility: id => call("GET", `/api/catalogue/${encodeURIComponent(id)}`),
    bookings: all => call("GET", "/api/bookings" + (all ? "?all=1" : "")),
    book: b => call("POST", "/api/bookings", b),
    approvals: () => call("GET", "/api/approvals"),
    decide: (id, decision, note) => call("POST", `/api/bookings/${encodeURIComponent(id)}/decision`, { decision, note }),
    recommend: r => call("POST", "/api/recommendations", r),
    demo: {
      reset: () => call("POST", "/api/demo/reset"),
      sso: down => call("POST", "/api/demo/sso", { down }),
      idle: () => call("POST", "/api/demo/idle")
    }
  };
})();
