#!/usr/bin/env node
/**
 * ParentSlop Fuzz Test Suite
 *
 * Throws malformed and unexpected payloads at every endpoint.
 * Verifies the server never crashes and never leaks stack traces.
 *
 * Usage: node tests/fuzz.js [base_url]
 * Default base_url: http://localhost:8080
 */

const BASE = process.argv[2] || "http://localhost:8080";

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, name) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}`);
  }
}

async function rawFetch(path, opts = {}) {
  const url = `${BASE}${path}`;
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  if (!headers["Content-Type"] && opts.body) headers["Content-Type"] = "application/json";

  const fetchOpts = { method: opts.method || "GET", headers, redirect: "manual" };
  if (opts.body !== undefined) {
    fetchOpts.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  if (opts.rawBody !== undefined) {
    fetchOpts.body = opts.rawBody;
  }

  const res = await fetch(url, fetchOpts);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

// Check response for security issues
function checkResponse(r, label) {
  // Server should never return 500 with a stack trace
  const hasStackTrace = r.text.includes("    at ") || r.text.includes("Error:") && r.text.includes(".js:");
  assert(!hasStackTrace, `${label}: no stack trace leaked (status ${r.status})`);

  // Should never expose internal file paths
  const hasInternalPath = r.text.includes("/home/") || r.text.includes("/usr/") || r.text.includes("node_modules/");
  assert(!hasInternalPath, `${label}: no internal paths leaked`);

  // Status should be a valid HTTP status
  assert(r.status >= 100 && r.status < 600, `${label}: valid HTTP status (${r.status})`);
}

// Helper: register a family for authenticated fuzzing
async function registerFamily(name) {
  const r = await rawFetch("/api/auth/register", {
    method: "POST",
    body: { familyName: name, adminName: "FuzzAdmin", password: "fuzzpass123" },
  });
  const setCookieHeaders = r.headers.getSetCookie?.() || [];
  const sessionCookie = setCookieHeaders.find(c => c.startsWith("session="));
  const cookie = sessionCookie?.split(";")[0] || null;
  let json;
  try { json = JSON.parse(r.text); } catch {}
  return { cookie, memberId: json?.memberId };
}

// Shared test family — set up in main()
let sharedFuzzFamily = null;

// ─── Fuzz Payloads ───────────────────────────────────────────────────────────

const TYPE_CONFUSION_PAYLOADS = [
  null,
  undefined,
  true,
  false,
  0,
  -1,
  NaN,
  Infinity,
  [],
  [1, 2, 3],
  [null],
  "",
  "a".repeat(100000),
  { nested: { deep: { very: { deep: "value" } } } },
  { toString: "hacked" },
  { __proto__: { admin: true } },
  { constructor: { prototype: { admin: true } } },
];

const STRING_PAYLOADS = [
  "",
  " ",
  "\t\n\r",
  "\0",
  "\0\0\0",
  "a".repeat(10000),
  "a".repeat(100000),
  "<script>alert(1)</script>",
  "{{7*7}}",
  "${7*7}",
  "%00",
  "%0a%0d",
  "\ud800", // lone surrogate
  "\uffff",
  "\\",
  '"',
  "'",
  "SELECT * FROM families",
  "'; DROP TABLE stores; --",
  "1; ATTACH DATABASE '/tmp/pwned.db' AS pwned; --",
  "../../../etc/passwd",
  "file:///etc/passwd",
];

const BOUNDARY_BODIES = [
  '{"key": "value"',  // truncated JSON
  '{',
  '}',
  '[]',
  'null',
  'true',
  '""',
  '0',
  'undefined',
  '',
  '{"a":'.repeat(100) + '"x"' + '}'.repeat(100), // deeply nested
];

// ─── Test Functions ──────────────────────────────────────────────────────────

async function fuzzRegistration() {
  console.log("\n--- Fuzz: Registration ---");
  let i = 0;

  for (const payload of TYPE_CONFUSION_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/auth/register", {
      method: "POST",
      body: { familyName: payload, adminName: "Test", password: "testpass123" },
    });
    checkResponse(r, `register familyName=${typeof payload}[${i}]`);
  }

  for (const payload of TYPE_CONFUSION_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/auth/register", {
      method: "POST",
      body: { familyName: "Test" + i, adminName: payload, password: "testpass123" },
    });
    checkResponse(r, `register adminName=${typeof payload}[${i}]`);
  }

  for (const payload of TYPE_CONFUSION_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/auth/register", {
      method: "POST",
      body: { familyName: "Test" + i, adminName: "Admin", password: payload },
    });
    checkResponse(r, `register password=${typeof payload}[${i}]`);
  }
}

async function fuzzLogin() {
  console.log("\n--- Fuzz: Login ---");
  let i = 0;

  for (const payload of STRING_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/auth/login", {
      method: "POST",
      body: { familyName: payload, password: "test1234" },
    });
    checkResponse(r, `login familyName string[${i}]`);
  }

  for (const payload of TYPE_CONFUSION_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/auth/login", {
      method: "POST",
      body: { familyName: payload, password: payload },
    });
    checkResponse(r, `login type confusion[${i}]`);
  }
}

async function fuzzStoreAPI() {
  console.log("\n--- Fuzz: Store API ---");

  const family = sharedFuzzFamily;
  if (!family?.cookie) { console.log("  SKIP (no auth)"); return; }

  let i = 0;

  // Fuzz store keys
  for (const key of STRING_PAYLOADS) {
    i++;
    try {
      const encoded = encodeURIComponent(key);
      const r = await rawFetch(`/api/store/${encoded}`, {
        method: "PUT",
        cookie: family.cookie,
        body: { value: "test" },
      });
      checkResponse(r, `store PUT key string[${i}]`);
    } catch (e) {
      // encodeURIComponent throws on lone surrogates — that's expected
      passed++;
    }
  }

  // Fuzz store values with type confusion
  for (const payload of TYPE_CONFUSION_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/store/fuzzkey", {
      method: "PUT",
      cookie: family.cookie,
      body: { value: payload },
    });
    checkResponse(r, `store PUT value type[${i}]`);
  }

  // Fuzz sync endpoint
  for (const payload of TYPE_CONFUSION_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/store/sync", {
      method: "POST",
      cookie: family.cookie,
      body: { stores: payload },
    });
    checkResponse(r, `store sync payload type[${i}]`);
  }

  // Large value near 5MB limit
  const largeValue = "x".repeat(4 * 1024 * 1024); // 4MB
  const largeR = await rawFetch("/api/store/bigkey", {
    method: "PUT",
    cookie: family.cookie,
    body: { value: largeValue },
  });
  checkResponse(largeR, "store PUT large value (4MB)");

  // Value exactly at 5MB limit should be rejected by express body parser
  const tooLargeValue = "x".repeat(5.5 * 1024 * 1024);
  const tooLargeR = await rawFetch("/api/store/toobig", {
    method: "PUT",
    cookie: family.cookie,
    body: { value: tooLargeValue },
  });
  checkResponse(tooLargeR, "store PUT over-limit value (5.5MB)");
}

async function fuzzFeedback() {
  console.log("\n--- Fuzz: Feedback ---");

  const family = sharedFuzzFamily;
  if (!family?.cookie) { console.log("  SKIP (no auth)"); return; }

  let i = 0;

  for (const payload of STRING_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/feedback", {
      method: "POST",
      cookie: family.cookie,
      body: { text: payload, userId: payload, userName: payload },
    });
    checkResponse(r, `feedback text string[${i}]`);
  }

  for (const payload of TYPE_CONFUSION_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/feedback", {
      method: "POST",
      cookie: family.cookie,
      body: { text: payload },
    });
    checkResponse(r, `feedback text type[${i}]`);
  }

  // PATCH with weird IDs
  const weirdIds = ["../../../etc/passwd", "' OR 1=1 --", "<script>", "\0", "a".repeat(10000)];
  for (const id of weirdIds) {
    i++;
    const r = await rawFetch(`/api/feedback/${encodeURIComponent(id)}`, {
      method: "PATCH",
      cookie: family.cookie,
      body: { completed: true, note: "fuzz" },
    });
    checkResponse(r, `feedback PATCH weird id[${i}]`);
  }
}

async function fuzzProtocolLevel() {
  console.log("\n--- Fuzz: Protocol-level ---");

  let i = 0;

  // Missing Content-Type with body
  const r1 = await rawFetch("/api/auth/login", {
    method: "POST",
    rawBody: '{"familyName":"test","password":"test"}',
    headers: {},
  });
  checkResponse(r1, "missing Content-Type with JSON body");

  // Wrong Content-Type
  const r2 = await rawFetch("/api/auth/login", {
    method: "POST",
    rawBody: '{"familyName":"test","password":"test"}',
    headers: { "Content-Type": "text/plain" },
  });
  checkResponse(r2, "wrong Content-Type (text/plain)");

  // Malformed JSON bodies
  for (const body of BOUNDARY_BODIES) {
    i++;
    const r = await rawFetch("/api/auth/login", {
      method: "POST",
      rawBody: body,
      headers: { "Content-Type": "application/json" },
    });
    checkResponse(r, `malformed JSON body[${i}]`);
  }

  // Wrong HTTP methods
  const wrongMethods = [
    { method: "DELETE", path: "/api/store/test" },
    { method: "PATCH", path: "/api/store/test" },
    { method: "PUT", path: "/api/feedback" },
    { method: "DELETE", path: "/api/feedback" },
    { method: "PUT", path: "/api/auth/login" },
    { method: "DELETE", path: "/api/auth/me" },
  ];

  for (const wm of wrongMethods) {
    const r = await rawFetch(wm.path, { method: wm.method });
    checkResponse(r, `wrong method ${wm.method} ${wm.path}`);
  }
}

async function fuzzAuthEndpoints() {
  console.log("\n--- Fuzz: Auth Endpoints ---");

  const family = sharedFuzzFamily;
  if (!family?.cookie) { console.log("  SKIP (no auth)"); return; }

  let i = 0;

  // Select member with weird IDs
  for (const payload of STRING_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/auth/select-member", {
      method: "POST",
      cookie: family.cookie,
      body: { memberId: payload },
    });
    checkResponse(r, `select-member weird id[${i}]`);
  }

  // Set PIN with various payloads
  const pinPayloads = [
    "0000", "9999", "abc", "12345", "", "0", "-1", "null",
    "1".repeat(1000), "\0\0\0\0", "١٢٣٤", // Arabic digits
  ];
  for (const pin of pinPayloads) {
    i++;
    const r = await rawFetch("/api/auth/set-pin", {
      method: "POST",
      cookie: family.cookie,
      body: { pin },
    });
    checkResponse(r, `set-pin payload[${i}]`);
  }

  // Set password with various payloads
  for (const payload of TYPE_CONFUSION_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/auth/set-password", {
      method: "POST",
      cookie: family.cookie,
      body: { password: payload },
    });
    checkResponse(r, `set-password type[${i}]`);
  }

  // Change family password with various payloads
  for (const payload of TYPE_CONFUSION_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/auth/change-family-password", {
      method: "POST",
      cookie: family.cookie,
      body: { newPassword: payload },
    });
    checkResponse(r, `change-password type[${i}]`);
  }

  // Add member with various payloads
  for (const payload of TYPE_CONFUSION_PAYLOADS) {
    i++;
    const r = await rawFetch("/api/auth/add-member", {
      method: "POST",
      cookie: family.cookie,
      body: { displayName: payload, isAdmin: payload },
    });
    checkResponse(r, `add-member type[${i}]`);
  }

  // Set auth level with wrong values
  const authLevels = ["admin", "root", "", null, 0, true, "pin; DROP TABLE families;--", "PIN"];
  for (const lvl of authLevels) {
    i++;
    const r = await rawFetch("/api/auth/set-auth-level", {
      method: "POST",
      cookie: family.cookie,
      body: { authLevel: lvl },
    });
    checkResponse(r, `set-auth-level wrong value[${i}]`);
  }
}

async function fuzzEncodingAttacks() {
  console.log("\n--- Fuzz: Encoding Attacks ---");

  const family = sharedFuzzFamily;
  if (!family?.cookie) { console.log("  SKIP (no auth)"); return; }

  let i = 0;

  // Null bytes in various positions
  const nullPayloads = [
    "test\x00value",
    "\x00",
    "test\x00",
    "\x00test",
    "te\x00st\x00va\x00lue",
  ];

  for (const payload of nullPayloads) {
    i++;
    const r = await rawFetch("/api/store/nulltest" + i, {
      method: "PUT",
      cookie: family.cookie,
      body: { value: payload },
    });
    checkResponse(r, `null byte in store value[${i}]`);
  }

  // Unicode edge cases
  const unicodePayloads = [
    "\uFEFF", // BOM
    "\u202E", // RTL override
    "\u0000", // null
    "\uD800", // lone high surrogate
    "\uDFFF", // lone low surrogate
    "🙂".repeat(10000), // lots of emoji
    "\u200B".repeat(1000), // zero-width spaces
  ];

  for (const payload of unicodePayloads) {
    i++;
    const r = await rawFetch("/api/feedback", {
      method: "POST",
      cookie: family.cookie,
      body: { text: "fuzz " + payload },
    });
    checkResponse(r, `unicode edge case[${i}]`);
  }

  // Control characters
  const controlChars = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("");
  const ccR = await rawFetch("/api/feedback", {
    method: "POST",
    cookie: family.cookie,
    body: { text: "control chars: " + controlChars },
  });
  checkResponse(ccR, "control characters in feedback");
}

async function fuzzCookies() {
  console.log("\n--- Fuzz: Cookie Manipulation ---");

  const weirdCookies = [
    "session=",
    "session=;",
    "session=undefined",
    "session=null",
    "session=true",
    "session=0",
    "session=" + "a".repeat(10000),
    "session=../../../etc/passwd",
    "session='; DROP TABLE sessions; --",
    "session=<script>alert(1)</script>",
    "",
    "other_cookie=value",
    "session=" + "a".repeat(36), // UUID-length but wrong
  ];

  let i = 0;
  for (const cookie of weirdCookies) {
    i++;
    const r = await rawFetch("/api/auth/me", { cookie });
    checkResponse(r, `weird cookie[${i}]`);
    assert(r.status === 200, `weird cookie returns 200 (not crash)[${i}]`);
  }
}

// ─── Server Health Check ─────────────────────────────────────────────────────

async function verifyServerStillRunning() {
  console.log("\n--- Server Health Check ---");
  try {
    const r = await rawFetch("/");
    assert(r.status === 200, "Server still responding after fuzz tests");
  } catch (e) {
    assert(false, `Server still responding after fuzz tests (${e.message})`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nParentSlop Fuzz Test Suite`);
  console.log(`Target: ${BASE}\n`);

  // Verify server is running
  try {
    const healthCheck = await rawFetch("/");
    if (healthCheck.status !== 200) {
      console.error("Server not responding at " + BASE);
      process.exit(1);
    }
  } catch (e) {
    console.error("Cannot connect to server at " + BASE + ": " + e.message);
    process.exit(1);
  }

  // Register a single shared family for authenticated tests
  sharedFuzzFamily = await registerFamily("FuzzFamily_" + Date.now());
  if (!sharedFuzzFamily.cookie) {
    console.error("Failed to register fuzz test family (rate limited?). Restart the server and try again.");
    process.exit(1);
  }
  console.log("Shared fuzz family registered.");

  await fuzzRegistration();
  await fuzzLogin();
  await fuzzStoreAPI();
  await fuzzFeedback();
  await fuzzProtocolLevel();
  await fuzzAuthEndpoints();
  await fuzzEncodingAttacks();
  await fuzzCookies();
  await verifyServerStillRunning();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fuzz suite error:", err);
  process.exit(1);
});
