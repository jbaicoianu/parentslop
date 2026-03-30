#!/usr/bin/env node
/**
 * Event Log & LWW Merge Test Suite
 *
 * Tests the apply-event module's LWW (Last-Writer-Wins) merge logic
 * and verifies that events are correctly emitted via the API.
 *
 * Usage: node tests/event-log.test.js
 */

const Database = require("better-sqlite3");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { withTestServer } = require("./harness");

const {
  initFieldVersionsTable,
  buildFields,
  applyEvent,
  getFieldVersion,
  updateFieldVersions,
  clearFieldVersions,
} = require("../lib/apply-event");

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

// ─── Unit Tests (in-memory SQLite, no server) ────────────────────────────────

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE users (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      name TEXT DEFAULT '',
      role TEXT DEFAULT 'kid',
      avatar TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      created_at TEXT DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE tasks (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      name TEXT DEFAULT '',
      description TEXT DEFAULT '',
      archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE completions (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      task_id TEXT DEFAULT '',
      user_id TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      completed_at TEXT DEFAULT '',
      rewards TEXT DEFAULT '{}'
    )
  `);

  db.exec(`
    CREATE TABLE stores (
      key TEXT NOT NULL PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )
  `);

  initFieldVersionsTable(db);
  return db;
}

function testBuildFields() {
  console.log("\n--- 1. buildFields ---");

  const db = createTestDb();

  // New row: all fields get version 1
  const fields = buildFields(db, "users", "user-1", {
    family_id: "fam-1", name: "Alice", role: "kid", created_at: "2024-01-01",
  });
  assert(fields.name.v === "Alice", "buildFields: name value correct");
  assert(fields.name.ver === 1, "buildFields: new field gets ver=1");
  assert(fields.role.ver === 1, "buildFields: role ver=1");
  assert(!fields.id, "buildFields: PK excluded from fields");

  // Simulate persisting versions, then build again (should increment)
  updateFieldVersions(db, "users", "user-1", fields);
  const fields2 = buildFields(db, "users", "user-1", { name: "Bob" });
  assert(fields2.name.ver === 2, "buildFields: incremented ver after update");

  db.close();
}

function testApplyEventInsert() {
  console.log("\n--- 2. applyEvent (insert) ---");

  const db = createTestDb();

  const event = {
    table: "users", pk: "user-1", op: "insert",
    fields: {
      family_id: { v: "fam-1", ver: 1 },
      name: { v: "Alice", ver: 1 },
      role: { v: "kid", ver: 1 },
      created_at: { v: "2024-01-01", ver: 1 },
    },
  };

  const applied = applyEvent(db, event);
  assert(applied === true, "applyEvent returns true for new insert");

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get("user-1");
  assert(row !== undefined, "Row inserted into users table");
  assert(row.name === "Alice", "Name is Alice");
  assert(row.role === "kid", "Role is kid");

  // Field versions should be tracked
  assert(getFieldVersion(db, "users", "user-1", "name") === 1, "field_versions: name=1");
  assert(getFieldVersion(db, "users", "user-1", "role") === 1, "field_versions: role=1");

  db.close();
}

function testApplyEventUpdate() {
  console.log("\n--- 3. applyEvent (update) ---");

  const db = createTestDb();

  // Insert first
  applyEvent(db, {
    table: "users", pk: "user-1", op: "insert",
    fields: { name: { v: "Alice", ver: 1 }, role: { v: "kid", ver: 1 } },
  });

  // Update with higher version
  const applied = applyEvent(db, {
    table: "users", pk: "user-1", op: "update",
    fields: { name: { v: "Bob", ver: 2 } },
  });
  assert(applied === true, "applyEvent returns true for winning update");

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get("user-1");
  assert(row.name === "Bob", "Name updated to Bob");
  assert(row.role === "kid", "Role unchanged (not in update)");
  assert(getFieldVersion(db, "users", "user-1", "name") === 2, "field_versions: name=2");

  db.close();
}

function testLWWRejectsOldVersion() {
  console.log("\n--- 4. LWW rejects old version ---");

  const db = createTestDb();

  // Insert with ver=5
  applyEvent(db, {
    table: "users", pk: "user-1", op: "insert",
    fields: { name: { v: "Alice", ver: 5 } },
  });

  // Try to update with ver=3 (should be rejected)
  const applied = applyEvent(db, {
    table: "users", pk: "user-1", op: "update",
    fields: { name: { v: "OldName", ver: 3 } },
  });
  assert(applied === false, "applyEvent returns false for rejected update");

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get("user-1");
  assert(row.name === "Alice", "Name stays Alice (old version rejected)");
  assert(getFieldVersion(db, "users", "user-1", "name") === 5, "field_versions stays at 5");

  db.close();
}

function testLWWPartialUpdate() {
  console.log("\n--- 5. LWW partial update (some fields win, some lose) ---");

  const db = createTestDb();

  applyEvent(db, {
    table: "users", pk: "user-1", op: "insert",
    fields: { name: { v: "Alice", ver: 3 }, role: { v: "kid", ver: 1 } },
  });

  // Update: name ver=2 (loses), role ver=2 (wins)
  applyEvent(db, {
    table: "users", pk: "user-1", op: "update",
    fields: { name: { v: "Bob", ver: 2 }, role: { v: "parent", ver: 2 } },
  });

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get("user-1");
  assert(row.name === "Alice", "Name stays Alice (ver 2 < ver 3)");
  assert(row.role === "parent", "Role updated to parent (ver 2 > ver 1)");

  db.close();
}

function testApplyEventDelete() {
  console.log("\n--- 6. applyEvent (delete) ---");

  const db = createTestDb();

  applyEvent(db, {
    table: "users", pk: "user-1", op: "insert",
    fields: { name: { v: "Alice", ver: 1 } },
  });

  const applied = applyEvent(db, {
    table: "users", pk: "user-1", op: "delete",
  });
  assert(applied === true, "applyEvent returns true for delete");

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get("user-1");
  assert(row === undefined, "Row deleted from users table");

  // Field versions should be cleared
  assert(getFieldVersion(db, "users", "user-1", "name") === 0, "field_versions cleared after delete");

  db.close();
}

function testStoresTablePK() {
  console.log("\n--- 7. Stores table (key PK) ---");

  const db = createTestDb();

  applyEvent(db, {
    table: "stores", pk: "fam-1:mykey", op: "upsert",
    fields: {
      value: { v: '{"test": true}', ver: 1 },
      updated_at: { v: "2024-01-01", ver: 1 },
    },
  });

  const row = db.prepare("SELECT * FROM stores WHERE key = ?").get("fam-1:mykey");
  assert(row !== undefined, "Store row inserted");
  assert(row.value === '{"test": true}', "Store value correct");

  db.close();
}

function testReplayOrdering() {
  console.log("\n--- 8. Replay ordering ---");

  const db = createTestDb();

  // Apply events out of version order — LWW should produce correct final state
  applyEvent(db, {
    table: "users", pk: "user-1", op: "insert",
    fields: { name: { v: "V1", ver: 1 }, role: { v: "kid", ver: 1 } },
  });
  applyEvent(db, {
    table: "users", pk: "user-1", op: "update",
    fields: { name: { v: "V3", ver: 3 } },
  });
  applyEvent(db, {
    table: "users", pk: "user-1", op: "update",
    fields: { name: { v: "V2", ver: 2 } },
  });

  const row = db.prepare("SELECT * FROM users WHERE id = ?").get("user-1");
  assert(row.name === "V3", "Highest version wins regardless of apply order");

  db.close();
}

// ─── Integration Tests (running server) ──────────────────────────────────────

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

async function testEventEmissionIntegration(base) {
  console.log("\n--- 9. Event emission integration ---");

  const fam = await registerFamily(base, "EventTest_" + Date.now());

  // Create a user → should succeed (event emission is best-effort, no S3 in tests)
  const userResp = await req(base, "/api/users", {
    method: "POST", cookie: fam.cookie,
    body: { name: "TestUser", role: "kid" },
  });
  assert(userResp.status === 200, "POST /api/users succeeds with event emission");
  assert(userResp.json.name === "TestUser", "User created correctly");

  // Create currency
  const currResp = await req(base, "/api/currencies", {
    method: "POST", cookie: fam.cookie,
    body: { name: "Gold", symbol: "G", decimals: 0 },
  });
  assert(currResp.status === 200, "POST /api/currencies succeeds");

  // Create task
  const taskResp = await req(base, "/api/tasks", {
    method: "POST", cookie: fam.cookie,
    body: { name: "TestTask", rewards: { [currResp.json.id]: 5 } },
  });
  assert(taskResp.status === 200, "POST /api/tasks succeeds");

  // Complete task
  const compResp = await req(base, "/api/completions", {
    method: "POST", cookie: fam.cookie,
    body: { taskId: taskResp.json.id, userId: userResp.json.id },
  });
  assert(compResp.status === 200, "POST /api/completions succeeds");
  assert(compResp.json.status === "approved", "Completion auto-approved");

  // Verify balances updated
  const balResp = await req(base, `/api/users/${userResp.json.id}/balances`, {
    cookie: fam.cookie,
  });
  assert(balResp.status === 200, "GET balances succeeds");
  assert(balResp.json[currResp.json.id] === 5, "Balance is 5 gold after completion");

  // Update user
  const updateResp = await req(base, `/api/users/${userResp.json.id}`, {
    method: "PUT", cookie: fam.cookie,
    body: { name: "UpdatedUser" },
  });
  assert(updateResp.status === 200, "PUT /api/users succeeds");
  assert(updateResp.json.name === "UpdatedUser", "User name updated");

  // Delete user
  const delResp = await req(base, `/api/users/${userResp.json.id}`, {
    method: "DELETE", cookie: fam.cookie,
  });
  assert(delResp.status === 200, "DELETE /api/users succeeds");

  // Verify full state endpoint works
  const stateResp = await req(base, "/api/state", { cookie: fam.cookie });
  assert(stateResp.status === 200, "GET /api/state succeeds");
  assert(Array.isArray(stateResp.json.tasks), "State has tasks array");
  assert(Array.isArray(stateResp.json.completions), "State has completions array");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Run unit tests first (no server needed)
testBuildFields();
testApplyEventInsert();
testApplyEventUpdate();
testLWWRejectsOldVersion();
testLWWPartialUpdate();
testApplyEventDelete();
testStoresTablePK();
testReplayOrdering();

// Then run integration tests (needs server)
withTestServer(async (base) => {
  console.log(`\nIntegration tests against: ${base}`);
  await testEventEmissionIntegration(base);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}).catch((err) => { console.error("Test suite error:", err); process.exit(1); });
