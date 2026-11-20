#!/usr/bin/env node
/**
 * Screen time: settings, parent adjustments, device tokens and device reports (idempotent running totals,
 * remaining time across computers, weekend allowance), access control and live updates.
 */

const { withTestServer } = require("./harness");

let BASE;
let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}

async function req(path, { method = "GET", body, cookie, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const firstCookie = (r) => (r.headers.get("set-cookie") || "").split(";")[0];

async function register(prefix = "ScreenTest") {
  const name = prefix + "_" + Date.now() + Math.random().toString(36).slice(2, 6);
  const res = await fetch(BASE + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ familyName: name, adminName: "Parent", password: "testpass123" }),
  });
  return { name, cookie: firstCookie(res) };
}

async function memberSession(fam, displayName, isAdmin) {
  const add = await req("/api/auth/add-member", { method: "POST", cookie: fam.cookie, body: { displayName, isAdmin } });
  const login = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ familyName: fam.name, password: "testpass123" }),
  });
  const cookie = firstCookie(login);
  await req("/api/auth/select-member", { method: "POST", cookie, body: { memberId: add.json.id } });
  await req("/api/auth/me", { cookie }); // creates the matching users row
  return { id: add.json.id, cookie };
}

async function streamSees(cookie, trigger, needle = "screentime:changed", ms = 3000) {
  const ctrl = new AbortController();
  const res = await fetch(BASE + "/api/events/stream", { headers: { Cookie: cookie }, signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => ctrl.abort(), ms);
  await reader.read();
  await trigger();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      if (buf.includes(needle)) return true;
    }
  } catch {} finally { clearTimeout(timer); ctrl.abort(); }
  return false;
}

// A weekday and a Saturday close to today (reports refuse dates far from the server's clock).
function nearbyDate(wantWeekend) {
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + (i - 1) * 86400000);
    const day = d.getUTCDay();
    if ((day === 0 || day === 6) === wantWeekend && i <= 2) return d.toISOString().slice(0, 10);
  }
  return null;
}

async function run(base) {
  BASE = base;
  const fam = await register();
  const P = { cookie: fam.cookie };
  const kid = await memberSession(fam, "Kiddo", false);
  const kid2 = await memberSession(fam, "Sib", false);
  const other = await register("OtherFam");
  const today = new Date().toISOString().slice(0, 10);

  console.log("\n-- settings --");
  assert((await req("/api/screentime/state")).status === 401, "state requires login");
  let st = (await req(`/api/screentime/state?date=${today}`, P)).json;
  assert(st.isAdmin && st.people.length === 2 && st.people.every((p) => !p.settings.enabled), "parent sees both kids, off by default");
  assert(Array.isArray(st.devices) && st.devices.length === 0, "parent sees the (empty) computer list");

  assert((await req(`/api/screentime/members/${kid.id}`, { method: "PUT", cookie: kid.cookie, body: { enabled: true } })).status === 403, "kids can't change settings");
  assert((await req(`/api/screentime/members/${kid.id}`, { method: "PUT", ...P, body: { weekdayMinutes: -5 } })).status === 400, "minutes validated");
  assert((await req(`/api/screentime/members/${kid.id}`, { method: "PUT", ...P, body: { loginName: "Not A Login!" } })).status === 400, "login name validated");
  assert((await req(`/api/screentime/members/nope`, { method: "PUT", ...P, body: { enabled: true } })).status === 404, "unknown person is 404");
  const set = await req(`/api/screentime/members/${kid.id}`, { method: "PUT", ...P, body: { enabled: true, weekdayMinutes: 60, weekendMinutes: 90, loginName: "Kiddo", warnMinutes: [1, 10, 5, 5], graceMinutes: 2 } });
  assert(set.status === 200 && set.json.settings.loginName === "kiddo", "parent turns it on; login lowercased");
  assert(JSON.stringify(set.json.settings.warnMinutes) === "[10,5,1]", "warnings sorted and de-duplicated");
  assert((await req(`/api/screentime/members/${kid2.id}`, { method: "PUT", ...P, body: { enabled: true, loginName: "kiddo" } })).status === 409, "two people can't share a login");
  await req(`/api/screentime/members/${kid2.id}`, { method: "PUT", ...P, body: { enabled: true, weekdayMinutes: 30, weekendMinutes: 30, loginName: "sib" } });
  assert((await req(`/api/screentime/members/${kid.id}`, { method: "PUT", cookie: other.cookie, body: { enabled: false } })).status === 404, "other families can't touch our kids");

  const kidView = (await req(`/api/screentime/state?date=${today}`, { cookie: kid.cookie })).json;
  assert(!kidView.isAdmin && kidView.people.length === 1 && kidView.people[0].id === kid.id && kidView.devices === undefined, "kids see only themselves, no computers");

  console.log("\n-- computers --");
  assert((await req("/api/screentime/devices", { method: "POST", cookie: kid.cookie, body: { name: "x" } })).status === 403, "kids can't add computers");
  assert((await req("/api/screentime/devices", { method: "POST", ...P, body: { name: " " } })).status === 400, "computer name required");
  const dev = await req("/api/screentime/devices", { method: "POST", ...P, body: { name: "Kidputer" } });
  assert(dev.status === 200 && /^psd_[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}$/.test(dev.json.token), "parent adds a computer and gets a token");
  const token = dev.json.token;
  const dev2 = (await req("/api/screentime/devices", { method: "POST", ...P, body: { name: "Laptop" } })).json;

  const R = "/api/screentime/device/report";
  assert((await req(R, { method: "POST", body: { date: today } })).status === 401, "report needs a token");
  assert((await req(R, { method: "POST", token: token.slice(0, -2) + "xx", body: { date: today } })).status === 401, "wrong secret refused");
  assert((await req(R, { method: "POST", token, body: { date: "2001-01-01" } })).status === 400, "date far from now refused");

  const wd = nearbyDate(false);
  const we = nearbyDate(true);
  let r = await req(R, { method: "POST", token, body: { date: wd, usage: {}, active: [] } });
  assert(r.status === 200 && r.json.members.length === 2, "report lists everyone with a login");
  let k = r.json.members.find((m) => m.login === "kiddo");
  assert(k.allowanceSeconds === 3600 && k.remainingSeconds === 3600 && k.usedSeconds === 0, "weekday allowance, nothing used yet");
  assert(JSON.stringify(k.warnMinutes) === "[10,5,1]" && k.graceMinutes === 2, "warnings and grace sent to the computer");

  r = await req(R, { method: "POST", token, body: { date: wd, usage: { kiddo: 600, stranger: 999 }, active: ["kiddo"], states: { kiddo: "ok" } } });
  k = r.json.members.find((m) => m.login === "kiddo");
  assert(k.usedSeconds === 600 && k.deviceSeconds === 600 && k.remainingSeconds === 3000, "usage recorded, unknown logins ignored");
  r = await req(R, { method: "POST", token, body: { date: wd, usage: { kiddo: 600 } } });
  assert(r.json.members.find((m) => m.login === "kiddo").usedSeconds === 600, "same total again doesn't double count");
  r = await req(R, { method: "POST", token, body: { date: wd, usage: { kiddo: 300 } } });
  assert(r.json.members.find((m) => m.login === "kiddo").usedSeconds === 600, "a lower total (agent restarted) doesn't lose time");
  r = await req(R, { method: "POST", token: dev2.token, body: { date: wd, usage: { kiddo: 900 } } });
  k = r.json.members.find((m) => m.login === "kiddo");
  assert(k.usedSeconds === 1500 && k.deviceSeconds === 900 && k.remainingSeconds === 2100, "time adds up across computers");

  if (we) {
    r = await req(R, { method: "POST", token, body: { date: we, usage: {} } });
    assert(r.json.members.find((m) => m.login === "kiddo").allowanceSeconds === 5400, "weekend allowance on Saturday/Sunday");
  }

  console.log("\n-- adjustments --");
  assert((await req(`/api/screentime/members/${kid.id}/adjust`, { method: "POST", cookie: kid.cookie, body: { date: wd, minutes: 60 } })).status === 403, "kids can't give themselves time");
  assert((await req(`/api/screentime/members/${kid.id}/adjust`, { method: "POST", ...P, body: { date: wd, minutes: 0 } })).status === 400, "zero minutes refused");
  assert((await req(`/api/screentime/members/${kid.id}/adjust`, { method: "POST", ...P, body: { date: "today", minutes: 5 } })).status === 400, "date validated");
  const adj = await req(`/api/screentime/members/${kid.id}/adjust`, { method: "POST", ...P, body: { date: wd, minutes: 30, note: "Finished homework" } });
  assert(adj.status === 200 && adj.json.today.bonusSeconds === 1800 && adj.json.today.remainingSeconds === 3900, "bonus time adds to remaining");
  r = await req(R, { method: "POST", token, body: { date: wd, usage: { kiddo: 600 } } });
  assert(r.json.members.find((m) => m.login === "kiddo").remainingSeconds === 3900, "computer sees the bonus");
  await req(`/api/screentime/members/${kid.id}/adjust`, { method: "POST", ...P, body: { date: wd, minutes: -120 } });
  r = await req(R, { method: "POST", token, body: { date: wd, usage: { kiddo: 600 } } });
  assert(r.json.members.find((m) => m.login === "kiddo").remainingSeconds === -3300, "taking time away can go below zero");

  // Computers send who is logged in with every report; the latest report wins.
  await req(R, { method: "POST", token, body: { date: wd, usage: { kiddo: 600 }, active: ["kiddo"], states: { kiddo: "grace" }, graceEndsAt: { kiddo: new Date(Date.now() + 90000).toISOString() } } });
  st = (await req(`/api/screentime/state?date=${wd}`, P)).json;
  const kp = st.people.find((p) => p.id === kid.id);
  assert(kp.today.usedSeconds === 1500 && kp.today.adjustments.length === 2 && kp.today.byDevice.length === 2, "state shows usage by computer and adjustments");
  assert(kp.week.length === 7 && kp.week[6].date === wd && kp.week[6].usedSeconds === 1500 && kp.week[6].allowanceSeconds === 3600 - 90 * 60, "week history includes adjustments");
  assert(kp.live && kp.live.deviceName === "Kidputer" && kp.live.state === "grace" && kp.live.graceEndsAt, "live: who is on which computer, and their state");
  assert(st.devices.length === 2 && st.devices.every((d) => d.online), "computers show as online");
  assert((await req(`/api/screentime/adjustments/${adj.json.id}`, { method: "DELETE", cookie: kid.cookie })).status === 403, "kids can't undo adjustments");
  assert((await req(`/api/screentime/adjustments/${adj.json.id}`, { method: "DELETE", cookie: other.cookie })).status === 404, "other families can't undo ours");
  assert((await req(`/api/screentime/adjustments/${adj.json.id}`, { method: "DELETE", ...P })).status === 200, "parent undoes an adjustment");

  console.log("\n-- agent files --");
  const agentFile = await fetch(BASE + "/screentime-agent/install.sh");
  assert(agentFile.status === 200 && (await agentFile.text()).includes("parentslop-screentime"), "install script is downloadable");
  assert((await fetch(BASE + "/screentime-agent/test_agent.py")).status === 404, "only the install files are served");
  assert((await fetch(BASE + "/screentime-agent/..%2Fserver.js")).status === 404, "no path tricks");

  console.log("\n-- turning off, live updates, removing a computer --");
  assert(await streamSees(fam.cookie, () => req(`/api/screentime/members/${kid2.id}`, { method: "PUT", ...P, body: { enabled: false } })), "settings change pushes screentime:changed");
  r = await req(R, { method: "POST", token, body: { date: wd, usage: { sib: 100 } } });
  assert(!r.json.members.some((m) => m.login === "sib"), "people with it off aren't sent to computers");
  assert(await streamSees(fam.cookie, () => req(R, { method: "POST", token, body: { date: wd, usage: { kiddo: 700 }, active: ["kiddo"] } })), "a device report pushes screentime:changed");
  assert((await req(`/api/screentime/devices/${dev.json.id}`, { method: "DELETE", ...P })).status === 200, "parent removes a computer");
  assert((await req(R, { method: "POST", token, body: { date: wd, usage: {} } })).status === 401, "a removed computer's token stops working");
  st = (await req(`/api/screentime/state?date=${wd}`, P)).json;
  assert(st.people.find((p) => p.id === kid.id).today.usedSeconds === 1600, "its recorded time still counts");
}

(async () => {
  console.log("Screen time tests");
  try {
    await withTestServer(run);
  } catch (e) {
    failed++;
    failures.push(`crashed: ${e.stack}`);
    console.log(e);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:\n  " + failures.join("\n  ")); process.exit(1); }
})();
