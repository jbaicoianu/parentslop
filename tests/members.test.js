#!/usr/bin/env node
/**
 * Login members and users rows: every family member must have a users row with the same id,
 * or the client can't find the current user and shows an empty app with no "Switch User".
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

async function req(path, { method = "GET", body, cookie } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
}

async function run(base) {
  BASE = base;
  const name = "MemberTest_" + Date.now();
  const reg = await req("/api/auth/register", { method: "POST", body: { familyName: name, adminName: "Parent", password: "testpass123" } });
  const cookie = (reg.headers.get("set-cookie") || "").split(";")[0];
  let users = (await req("/api/users", { cookie })).json;
  const parent = users.find((u) => u.id === reg.json.memberId);
  assert(parent && parent.role === "parent" && parent.name === "Parent", "registering creates the parent's users row with the member id");

  // The admin UI's add-user flow: add-member, then createUser with the member id.
  const add = await req("/api/auth/add-member", { method: "POST", cookie, body: { displayName: "Kiddo", isAdmin: false } });
  const created = await req("/api/users", { method: "POST", cookie, body: { id: add.json.id, name: "Kiddo", role: "kid", tags: [] } });
  users = (await req("/api/users", { cookie })).json;
  assert(created.json.id === add.json.id, "createUser for a member returns the row keyed by the member id");
  assert(users.filter((u) => u.name === "Kiddo").length === 1, "adding a kid doesn't create a duplicate users row");

  const pet = await req("/api/users", { method: "POST", cookie, body: { id: "made-up-id", name: "Rex", role: "pet" } });
  assert(pet.status === 200 && pet.json.id !== "made-up-id", "non-member users get a fresh id (client ids aren't trusted)");

  // Switching to the kid: the session's member must resolve to a users row.
  await req("/api/auth/switch-user", { method: "POST", cookie });
  await req("/api/auth/select-member", { method: "POST", cookie, body: { memberId: add.json.id } });
  const me = (await req("/api/auth/me", { cookie })).json;
  users = (await req("/api/users", { cookie })).json;
  assert(me.currentMember.id === add.json.id && users.some((u) => u.id === me.currentMember.id), "the selected kid has a matching users row");
}

(async () => {
  console.log("Members/users tests");
  try { await withTestServer(run); } catch (e) { failed++; failures.push(`crashed: ${e.stack}`); console.log(e); }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:\n  " + failures.join("\n  ")); process.exit(1); }
})();
