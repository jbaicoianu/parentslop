#!/usr/bin/env node
/**
 * CR-SQLite Sync Integration Test Suite
 *
 * Spins up two independent server instances with fresh databases and exercises
 * pod-to-pod sync scenarios end-to-end via the /api/sync/* endpoints.
 *
 * Usage: node tests/sync.test.js
 */

const { withTwoServers } = require("./harness");

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}`);
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function req(base, path, opts = {}) {
  const url = `${base}${path}`;
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (opts.cookie) headers["Cookie"] = opts.cookie;

  const fetchOpts = { method: opts.method || "GET", headers, redirect: "manual" };
  if (opts.body !== undefined) fetchOpts.body = JSON.stringify(opts.body);

  const res = await fetch(url, fetchOpts);
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function syncReq(base, path, secret, opts = {}) {
  return req(base, path, {
    ...opts,
    headers: { "x-sync-secret": secret, ...(opts.headers || {}) },
  });
}

// ─── Data creation helpers ────────────────────────────────────────────────────

async function registerFamily(base, name) {
  const r = await req(base, "/api/auth/register", {
    method: "POST",
    body: { familyName: name, adminName: "Admin", password: "testpass123" },
  });
  const setCookieHeaders = r.headers.getSetCookie?.() || [];
  const sessionCookie = setCookieHeaders.find(c => c.startsWith("session="));
  const cookie = sessionCookie?.split(";")[0] || null;
  return { cookie, familyId: r.json?.familyId };
}

async function createUser(base, cookie, name) {
  const r = await req(base, "/api/users", {
    method: "POST", cookie,
    body: { name, role: "kid" },
  });
  return r.json;
}

async function createCurrency(base, cookie, name, symbol) {
  const r = await req(base, "/api/currencies", {
    method: "POST", cookie,
    body: { name, symbol, decimals: 0 },
  });
  return r.json;
}

async function createTask(base, cookie, name, rewards = {}) {
  const r = await req(base, "/api/tasks", {
    method: "POST", cookie,
    body: { name, rewards },
  });
  return r.json;
}

async function createCompletion(base, cookie, taskId, userId) {
  const r = await req(base, "/api/completions", {
    method: "POST", cookie,
    body: { taskId, userId },
  });
  return r.json;
}

async function deleteUser(base, cookie, userId) {
  return req(base, `/api/users/${userId}`, { method: "DELETE", cookie });
}

// ─── Sync helpers ─────────────────────────────────────────────────────────────

/** Pull changes from `fromBase` and push them to `toBase`. Returns pull data. */
async function pullAndPush(fromBase, toBase, secret, since = 0) {
  const pull = await syncReq(fromBase, `/api/sync/changes?since=${since}`, secret);
  if (pull.json.changes.length > 0) {
    await syncReq(toBase, "/api/sync/changes", secret, {
      method: "POST",
      body: { changes: pull.json.changes },
    });
  }
  return pull.json;
}

/** Bidirectional sync: A→B then B→A */
async function syncBidirectional(baseA, baseB, secret, sinceA = 0, sinceB = 0) {
  const pullA = await pullAndPush(baseA, baseB, secret, sinceA);
  const pullB = await pullAndPush(baseB, baseA, secret, sinceB);
  return { pullA, pullB };
}

// ─── Test Suites ──────────────────────────────────────────────────────────────

async function testSyncAuth(baseA, secret) {
  console.log("\n--- 1. Sync Auth ---");

  const endpoints = [
    { path: "/api/sync/version", method: "GET" },
    { path: "/api/sync/changes?since=0", method: "GET" },
    { path: "/api/sync/changes", method: "POST", body: { changes: [] } },
  ];

  for (const ep of endpoints) {
    // No header
    const noHeader = await req(baseA, ep.path, { method: ep.method, body: ep.body });
    assert(noHeader.status === 401, `${ep.method} ${ep.path} → 401 without header`);

    // Wrong secret
    const wrongSecret = await syncReq(baseA, ep.path, "wrong-secret", { method: ep.method, body: ep.body });
    assert(wrongSecret.status === 401, `${ep.method} ${ep.path} → 401 with wrong secret`);

    // Correct secret
    const correct = await syncReq(baseA, ep.path, secret, { method: ep.method, body: ep.body });
    assert(correct.status === 200, `${ep.method} ${ep.path} → 200 with correct secret`);
  }
}

async function testBasicSync(baseA, baseB, secret) {
  console.log("\n--- 2. Basic Sync ---");

  const famA = await registerFamily(baseA, "SyncBasicA_" + Date.now());
  const user = await createUser(baseA, famA.cookie, "Alice");

  // Pull changes from A, push to B
  const pull = await pullAndPush(baseA, baseB, secret);
  assert(pull.changes.length > 0, "A has changes to sync");

  // Verify B received changes for the users table
  const bChanges = await syncReq(baseB, "/api/sync/changes?since=0", secret);
  const userChanges = bChanges.json.changes.filter(c => c.table === "users");
  assert(userChanges.length > 0, "B has user changes after sync");

  // Verify the user name is in the synced changes
  const nameChange = userChanges.find(c => c.cid === "name" && c.val === "Alice");
  assert(nameChange !== undefined, "B has Alice's name in synced changes");
}

async function testBidirectionalSync(baseA, baseB, secret) {
  console.log("\n--- 3. Bidirectional Sync ---");

  const famA = await registerFamily(baseA, "SyncBidiA_" + Date.now());
  const famB = await registerFamily(baseB, "SyncBidiB_" + Date.now());
  await createUser(baseA, famA.cookie, "AliceOnA");
  await createUser(baseB, famB.cookie, "BobOnB");

  // Sync both ways
  await syncBidirectional(baseA, baseB, secret);

  // Check A has both users' changes
  const aChanges = await syncReq(baseA, "/api/sync/changes?since=0", secret);
  const aUserNames = aChanges.json.changes
    .filter(c => c.table === "users" && c.cid === "name")
    .map(c => c.val);
  assert(aUserNames.includes("AliceOnA"), "A has AliceOnA after bidirectional sync");
  assert(aUserNames.includes("BobOnB"), "A has BobOnB after bidirectional sync");

  // Check B has both users' changes
  const bChanges = await syncReq(baseB, "/api/sync/changes?since=0", secret);
  const bUserNames = bChanges.json.changes
    .filter(c => c.table === "users" && c.cid === "name")
    .map(c => c.val);
  assert(bUserNames.includes("AliceOnA"), "B has AliceOnA after bidirectional sync");
  assert(bUserNames.includes("BobOnB"), "B has BobOnB after bidirectional sync");
}

async function testConcurrentDifferentRows(baseA, baseB, secret) {
  console.log("\n--- 4. Concurrent Writes (different rows) ---");

  const famA = await registerFamily(baseA, "SyncConcA_" + Date.now());
  const famB = await registerFamily(baseB, "SyncConcB_" + Date.now());

  // Create users simultaneously on both
  await createUser(baseA, famA.cookie, "UserFromA");
  await createUser(baseB, famB.cookie, "UserFromB");

  // Sync both ways
  await syncBidirectional(baseA, baseB, secret);

  // Both should coexist on both instances
  const aChanges = await syncReq(baseA, "/api/sync/changes?since=0", secret);
  const aNames = aChanges.json.changes
    .filter(c => c.table === "users" && c.cid === "name")
    .map(c => c.val);
  assert(aNames.includes("UserFromA") && aNames.includes("UserFromB"),
    "A has both users after concurrent writes sync");

  const bChanges = await syncReq(baseB, "/api/sync/changes?since=0", secret);
  const bNames = bChanges.json.changes
    .filter(c => c.table === "users" && c.cid === "name")
    .map(c => c.val);
  assert(bNames.includes("UserFromA") && bNames.includes("UserFromB"),
    "B has both users after concurrent writes sync");
}

async function testConcurrentSameRowLWW(baseA, baseB, secret) {
  console.log("\n--- 5. Concurrent Writes (same row, LWW conflict) ---");

  // Create user on A, sync to B so both have the same row
  const famA = await registerFamily(baseA, "SyncLWWA_" + Date.now());
  const user = await createUser(baseA, famA.cookie, "OriginalName");
  await pullAndPush(baseA, baseB, secret);

  // Update user name on A via API
  await req(baseA, `/api/users/${user.id}`, {
    method: "PUT", cookie: famA.cookie,
    body: { name: "UpdatedOnA" },
  });

  // Get A's changes to find the col_version for the name update
  const aChanges = await syncReq(baseA, "/api/sync/changes?since=0", secret);
  const aNameChange = aChanges.json.changes
    .filter(c => c.table === "users" && c.cid === "name" && c.val === "UpdatedOnA")[0];

  // Inject a competing change to B with a higher col_version
  if (aNameChange) {
    const competingChange = {
      ...aNameChange,
      val: "UpdatedOnB",
      col_version: aNameChange.col_version + 10,
      // Use B's own site_id to make it look like a local change
      site_id: (await syncReq(baseB, "/api/sync/version", secret)).json.siteId,
    };

    await syncReq(baseB, "/api/sync/changes", secret, {
      method: "POST",
      body: { changes: [competingChange] },
    });
  }

  // Sync both ways
  await syncBidirectional(baseA, baseB, secret);

  // Higher col_version should win on both
  const finalA = await syncReq(baseA, "/api/sync/changes?since=0", secret);
  const finalANames = finalA.json.changes
    .filter(c => c.table === "users" && c.cid === "name")
    .sort((a, b) => b.col_version - a.col_version);
  assert(finalANames[0]?.val === "UpdatedOnB",
    "Higher col_version wins on A (LWW)");

  const finalB = await syncReq(baseB, "/api/sync/changes?since=0", secret);
  const finalBNames = finalB.json.changes
    .filter(c => c.table === "users" && c.cid === "name")
    .sort((a, b) => b.col_version - a.col_version);
  assert(finalBNames[0]?.val === "UpdatedOnB",
    "Higher col_version wins on B (LWW)");
}

async function testDeleteSync(baseA, baseB, secret) {
  console.log("\n--- 6. Delete Sync ---");

  const famA = await registerFamily(baseA, "SyncDelA_" + Date.now());
  const user = await createUser(baseA, famA.cookie, "ToBeDeleted");

  // Sync to B
  await pullAndPush(baseA, baseB, secret);

  // Verify B has the user
  let bChanges = await syncReq(baseB, "/api/sync/changes?since=0", secret);
  let bHasUser = bChanges.json.changes.some(
    c => c.table === "users" && c.cid === "name" && c.val === "ToBeDeleted"
  );
  assert(bHasUser, "B has user before delete");

  // Delete user on A
  const versionBeforeDelete = (await syncReq(baseA, "/api/sync/version", secret)).json.dbVersion;
  await deleteUser(baseA, famA.cookie, user.id);

  // Pull only new changes (post-delete) from A to B
  await pullAndPush(baseA, baseB, secret, versionBeforeDelete);

  // Check B received a delete sentinel (cr-sqlite uses cid === "-1" for deletes)
  bChanges = await syncReq(baseB, "/api/sync/changes?since=0", secret);
  const deleteSentinels = bChanges.json.changes.filter(
    c => c.table === "users" && c.cid === "-1"
  );
  assert(deleteSentinels.length > 0, "B received delete sentinel after sync");
}

async function testMultiTableSync(baseA, baseB, secret) {
  console.log("\n--- 7. Multi-Table Consistency ---");

  const famA = await registerFamily(baseA, "SyncMultiA_" + Date.now());
  const currency = await createCurrency(baseA, famA.cookie, "Gold", "G");
  const user = await createUser(baseA, famA.cookie, "MultiUser");
  const task = await createTask(baseA, famA.cookie, "MultiTask", { [currency.id]: 5 });
  const completion = await createCompletion(baseA, famA.cookie, task.id, user.id);

  // Sync to B
  await pullAndPush(baseA, baseB, secret);

  // Verify all 4 tables arrived
  const bChanges = await syncReq(baseB, "/api/sync/changes?since=0", secret);
  const tables = new Set(bChanges.json.changes.map(c => c.table));

  assert(tables.has("currencies"), "B has currencies changes");
  assert(tables.has("users"), "B has users changes");
  assert(tables.has("tasks"), "B has tasks changes");
  assert(tables.has("completions"), "B has completions changes");
}

async function testIncrementalSync(baseA, baseB, secret) {
  console.log("\n--- 8. Incremental Sync ---");

  const famA = await registerFamily(baseA, "SyncIncrA_" + Date.now());
  await createUser(baseA, famA.cookie, "Alice");

  // Note current version after Alice
  const versionAfterAlice = (await syncReq(baseA, "/api/sync/version", secret)).json.dbVersion;

  // Initial full sync
  await pullAndPush(baseA, baseB, secret);

  // Create Bob
  await createUser(baseA, famA.cookie, "Bob");

  // Pull only changes since Alice's version
  const incremental = await syncReq(baseA, `/api/sync/changes?since=${versionAfterAlice}`, secret);
  const incrementalNames = incremental.json.changes
    .filter(c => c.table === "users" && c.cid === "name")
    .map(c => c.val);

  assert(!incrementalNames.includes("Alice"), "Incremental pull does NOT include Alice");
  assert(incrementalNames.includes("Bob"), "Incremental pull includes Bob");

  // Push incremental to B
  if (incremental.json.changes.length > 0) {
    await syncReq(baseB, "/api/sync/changes", secret, {
      method: "POST",
      body: { changes: incremental.json.changes },
    });
  }

  // B should now have both
  const bChanges = await syncReq(baseB, "/api/sync/changes?since=0", secret);
  const bNames = bChanges.json.changes
    .filter(c => c.table === "users" && c.cid === "name")
    .map(c => c.val);
  assert(bNames.includes("Alice"), "B has Alice after full + incremental sync");
  assert(bNames.includes("Bob"), "B has Bob after incremental sync");
}

async function testNonCrrTablesStayLocal(baseA, secret) {
  console.log("\n--- 9. Non-CRR Tables Stay Local ---");

  // Register a family (creates entries in families, family_members, sessions)
  await registerFamily(baseA, "SyncLocalA_" + Date.now());

  // Pull all changes
  const all = await syncReq(baseA, "/api/sync/changes?since=0", secret);
  const tables = new Set(all.json.changes.map(c => c.table));

  const nonCrrTables = ["families", "family_members", "sessions", "user_balances", "sync_state"];
  for (const t of nonCrrTables) {
    assert(!tables.has(t), `Non-CRR table "${t}" not in sync changes`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

withTwoServers(async (baseA, baseB, secret) => {
  console.log("\nCR-SQLite Sync Integration Test Suite");
  console.log(`Server A: ${baseA}`);
  console.log(`Server B: ${baseB}`);

  await testSyncAuth(baseA, secret);
  await testBasicSync(baseA, baseB, secret);
  await testBidirectionalSync(baseA, baseB, secret);
  await testConcurrentDifferentRows(baseA, baseB, secret);
  await testConcurrentSameRowLWW(baseA, baseB, secret);
  await testDeleteSync(baseA, baseB, secret);
  await testMultiTableSync(baseA, baseB, secret);
  await testIncrementalSync(baseA, baseB, secret);
  await testNonCrrTablesStayLocal(baseA, secret);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}).catch((err) => { console.error("Test suite error:", err); process.exit(1); });
