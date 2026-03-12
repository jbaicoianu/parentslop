#!/usr/bin/env node
/**
 * ParentSlop Security Pen Test Suite
 *
 * Spins up a temporary server with a cloned DB, runs tests, then tears down.
 * Usage: node tests/security.test.js [base_url]
 *
 * If a base_url is provided, tests run against that server directly.
 * Otherwise, a temporary server is started automatically.
 */

const { withTestServer } = require("./harness");

let BASE = process.argv[2] || null;

let passed = 0;
let failed = 0;
let skipped = 0;
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

async function req(path, opts = {}) {
  const url = `${BASE}${path}`;
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

// Helper: register a new family and return { cookie, familyId, memberId }
async function registerFamily(familyName, adminName = "Admin", password = "testpass123") {
  const r = await req("/api/auth/register", {
    method: "POST",
    body: { familyName, adminName, password },
  });
  const setCookieHeaders = r.headers.getSetCookie?.() || [];
  const sessionCookie = setCookieHeaders.find(c => c.startsWith("session="));
  const cookie = sessionCookie?.split(";")[0] || null;
  return {
    cookie,
    familyId: r.json?.familyId,
    memberId: r.json?.memberId,
    status: r.status,
    setCookieRaw: sessionCookie || "",
  };
}

// Helper: login to a family and return { cookie }
async function loginFamily(familyName, password) {
  const r = await req("/api/auth/login", {
    method: "POST",
    body: { familyName, password },
  });
  const setCookieHeaders = r.headers.getSetCookie?.() || [];
  const sessionCookie = setCookieHeaders.find(c => c.startsWith("session="));
  const cookie = sessionCookie?.split(";")[0] || null;
  return { cookie, familyId: r.json?.familyId, status: r.status, setCookieRaw: sessionCookie || "" };
}

// Helper: add a non-admin child member and return a fresh session cookie with that member selected
async function setupChildSession(familyInfo) {
  const addRes = await req("/api/auth/add-member", {
    method: "POST",
    cookie: familyInfo.cookie,
    body: { displayName: "TestKid_" + Date.now(), isAdmin: false },
  });
  const kidId = addRes.json?.id;
  if (!kidId) return null;

  // Login fresh so we don't mess up the shared session
  const freshLogin = await loginFamily(familyInfo.name, "testpass123");
  if (!freshLogin.cookie) return null;

  // Select the non-admin member
  await req("/api/auth/select-member", {
    method: "POST",
    cookie: freshLogin.cookie,
    body: { memberId: kidId },
  });

  return { cookie: freshLogin.cookie, kidId };
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

async function testStaticFileIsolation() {
  console.log("\n--- Static File Isolation ---");

  const dbRes = await req("/parentslop.db");
  assert(dbRes.status === 404, "Database file not accessible via HTTP");

  const gitRes = await req("/.git/config");
  assert(gitRes.status === 404, ".git directory not accessible");

  const serverRes = await req("/server.js");
  assert(serverRes.status === 404, "server.js not accessible");

  const backupRes = await req("/backups/");
  assert(backupRes.status === 404, "backups directory not accessible");

  const pkgRes = await req("/package.json");
  assert(pkgRes.status === 404, "package.json not accessible");

  const nodeModRes = await req("/node_modules/express/package.json");
  assert(nodeModRes.status === 404, "node_modules not accessible");

  // Static files that SHOULD be accessible
  const indexRes = await req("/index.html");
  assert(indexRes.status === 200, "index.html is accessible");

  const manifestRes = await req("/manifest.json");
  assert(manifestRes.status === 200, "manifest.json is accessible");
}

async function testPathTraversal() {
  console.log("\n--- Path Traversal ---");

  const paths = [
    "/../parentslop.db",
    "/..%2Fparentslop.db",
    "/../server.js",
    "/..%2Fserver.js",
    "/tracker/../../parentslop.db",
    "/tracker/..%2F..%2Fparentslop.db",
    "/../../../etc/passwd",
    "/..%2F..%2F..%2Fetc%2Fpasswd",
  ];

  for (const p of paths) {
    const r = await req(p);
    // Server returns 400 or 404; 403 is not expected from express.static
    assert(r.status === 400 || r.status === 404, `Path traversal blocked: ${p} (got ${r.status})`);
  }
}

async function testAuthEnforcement() {
  console.log("\n--- Auth Enforcement (401 without session) ---");

  const protectedEndpoints = [
    { method: "GET", path: "/api/store/test" },
    { method: "PUT", path: "/api/store/test", body: { value: "x" } },
    { method: "POST", path: "/api/store/sync", body: { stores: {} } },
    { method: "POST", path: "/api/auth/select-member", body: { memberId: "x" } },
    { method: "POST", path: "/api/auth/switch-user", body: {} },
    { method: "POST", path: "/api/auth/add-member", body: { displayName: "X" } },
    { method: "PATCH", path: "/api/auth/member/x", body: {} },
    { method: "POST", path: "/api/auth/set-auth-level", body: { authLevel: "none" } },
    { method: "POST", path: "/api/auth/set-pin", body: {} },
    { method: "POST", path: "/api/auth/set-password", body: {} },
    { method: "POST", path: "/api/auth/change-family-password", body: { newPassword: "x" } },
    { method: "POST", path: "/api/feedback", body: { text: "x" } },
    { method: "GET", path: "/api/feedback" },
    { method: "PATCH", path: "/api/feedback/x", body: { completed: true } },
    { method: "POST", path: "/api/backup" },
    { method: "GET", path: "/api/backups" },
  ];

  for (const ep of protectedEndpoints) {
    const r = await req(ep.path, { method: ep.method, body: ep.body });
    assert(r.status === 401, `${ep.method} ${ep.path} returns 401 without session (got ${r.status})`);
    assert(r.json?.error === "not authenticated", `${ep.method} ${ep.path} error body says "not authenticated"`);
  }
}

async function testSessionLifecycle(sharedFamily) {
  console.log("\n--- Session Lifecycle ---");

  // Fresh login to test with
  const freshLogin = await loginFamily(sharedFamily.name, "testpass123");
  if (!freshLogin.cookie) { console.log("  SKIP (login failed)"); skipped++; return; }

  // Session works
  const meRes = await req("/api/auth/me", { cookie: freshLogin.cookie });
  assert(meRes.json?.authenticated === true, "Valid session returns authenticated=true");

  // Logout invalidates session
  await req("/api/auth/logout", { method: "POST", cookie: freshLogin.cookie });
  const afterLogout = await req("/api/auth/me", { cookie: freshLogin.cookie });
  assert(afterLogout.json?.authenticated === false, "Session invalid after logout");

  // Fake session rejected
  const fakeRes = await req("/api/auth/me", { cookie: "session=fake-session-id-12345" });
  assert(fakeRes.json?.authenticated === false, "Fake session ID rejected");

  // Password change invalidates other sessions (with try/finally for cleanup)
  const login1 = await loginFamily(sharedFamily.name, "testpass123");
  const login2 = await loginFamily(sharedFamily.name, "testpass123");
  if (login1.cookie && login2.cookie) {
    // Select admin member on login1 to allow password change
    const me1 = await req("/api/auth/me", { cookie: login1.cookie });
    const adminMember = me1.json?.members?.find(m => m.isAdmin);
    if (adminMember) {
      await req("/api/auth/select-member", {
        method: "POST",
        cookie: login1.cookie,
        body: { memberId: adminMember.id },
      });
    }

    try {
      // Change password from session 1
      await req("/api/auth/change-family-password", {
        method: "POST",
        cookie: login1.cookie,
        body: { newPassword: "newpassword123" },
      });

      // Session 2 should be invalidated
      const afterPwChange = await req("/api/auth/me", { cookie: login2.cookie });
      assert(afterPwChange.json?.authenticated === false, "Other sessions invalidated after password change");
    } finally {
      // Always restore the password, even if test assertions fail
      await req("/api/auth/change-family-password", {
        method: "POST",
        cookie: login1.cookie,
        body: { newPassword: "testpass123" },
      });
    }
  }
}

async function testAdminEnforcement(sharedFamily, childSession) {
  console.log("\n--- Admin Enforcement (403 for non-admin) ---");

  const adminEndpoints = [
    { method: "POST", path: "/api/auth/add-member", body: { displayName: "Hacker" } },
    { method: "PATCH", path: `/api/auth/member/${childSession.kidId}`, body: { isAdmin: true } },
    { method: "POST", path: "/api/auth/set-auth-level", body: { authLevel: "pin" } },
  ];

  for (const ep of adminEndpoints) {
    const r = await req(ep.path, { method: ep.method, cookie: childSession.cookie, body: ep.body });
    assert(r.status === 403, `${ep.method} ${ep.path} returns 403 for non-admin (got ${r.status})`);
    assert(r.json?.error === "admin required", `${ep.method} ${ep.path} error says "admin required"`);
  }
}

async function testStoreAdminAuthorization(sharedFamily, childSession) {
  console.log("\n--- Store API Admin Authorization ---");

  // Admin-only keys that children should NOT be able to write
  const adminKeys = [
    "parentslop.tasks.v1",
    "parentslop.shop.v1",
    "parentslop.currencies.v1",
    "parentslop.users.v1",
  ];

  for (const key of adminKeys) {
    const r = await req(`/api/store/${encodeURIComponent(key)}`, {
      method: "PUT",
      cookie: childSession.cookie,
      body: { value: '{"hacked": true}' },
    });
    assert(r.status === 403, `Child cannot write admin key ${key} via PUT (got ${r.status})`);
    assert(r.json?.error === "admin required", `PUT ${key} error says "admin required"`);
  }

  // Admin CAN write admin-only keys
  for (const key of adminKeys) {
    const r = await req(`/api/store/${encodeURIComponent(key)}`, {
      method: "PUT",
      cookie: sharedFamily.cookie,
      body: { value: '[]' },
    });
    assert(r.status === 200, `Admin can write admin key ${key} via PUT (got ${r.status})`);
  }

  // Kid-writable keys that children CAN write
  const kidKeys = [
    "parentslop.completions.v1",
    "parentslop.jobclaims.v1",
  ];

  for (const key of kidKeys) {
    const r = await req(`/api/store/${encodeURIComponent(key)}`, {
      method: "PUT",
      cookie: childSession.cookie,
      body: { value: '[]' },
    });
    assert(r.status === 200, `Child can write kid key ${key} via PUT (got ${r.status})`);
  }

  // Store sync with admin keys should be blocked for children
  const syncRes = await req("/api/store/sync", {
    method: "POST",
    cookie: childSession.cookie,
    body: { stores: { "parentslop.tasks.v1": "[]", "parentslop.completions.v1": "[]" } },
  });
  assert(syncRes.status === 403, `Child cannot sync admin keys (got ${syncRes.status})`);

  // Store sync with only kid keys should succeed for children
  const syncKidRes = await req("/api/store/sync", {
    method: "POST",
    cookie: childSession.cookie,
    body: { stores: { "parentslop.completions.v1": "[]", "parentslop.jobclaims.v1": "[]" } },
  });
  assert(syncKidRes.status === 200, `Child can sync kid-only keys (got ${syncKidRes.status})`);
}

async function testBackupAndFeedbackAuthorization(sharedFamily, childSession) {
  console.log("\n--- Backup & Feedback PATCH Authorization ---");

  // Non-admin cannot create backups
  const backupRes = await req("/api/backup", {
    method: "POST",
    cookie: childSession.cookie,
  });
  assert(backupRes.status === 403, `POST /api/backup returns 403 for non-admin (got ${backupRes.status})`);

  // Non-admin cannot list backups
  const backupsRes = await req("/api/backups", {
    method: "GET",
    cookie: childSession.cookie,
  });
  assert(backupsRes.status === 403, `GET /api/backups returns 403 for non-admin (got ${backupsRes.status})`);

  // Submit feedback as the child (this is allowed)
  const fbSubmit = await req("/api/feedback", {
    method: "POST",
    cookie: childSession.cookie,
    body: { text: "Test feedback from kid " + Date.now() },
  });
  const fbId = fbSubmit.json?.id;

  if (fbId) {
    // Non-admin cannot mark feedback completed
    const fbPatch = await req(`/api/feedback/${fbId}`, {
      method: "PATCH",
      cookie: childSession.cookie,
      body: { completed: true, note: "kid trying to close" },
    });
    assert(fbPatch.status === 403, `PATCH /api/feedback returns 403 for non-admin (got ${fbPatch.status})`);

    // Admin CAN mark feedback completed
    const fbPatchAdmin = await req(`/api/feedback/${fbId}`, {
      method: "PATCH",
      cookie: sharedFamily.cookie,
      body: { completed: true, note: "admin closing" },
    });
    assert(fbPatchAdmin.status === 200, `Admin can PATCH feedback (got ${fbPatchAdmin.status})`);
  }
}

async function testCrossFamilyIsolation(familyA, familyB) {
  console.log("\n--- Cross-Family Isolation ---");

  // Family A writes a store value
  await req("/api/store/secret", {
    method: "PUT",
    cookie: familyA.cookie,
    body: { value: "family-a-secret" },
  });

  // Family B tries to read Family A's store
  const readRes = await req("/api/store/secret", {
    method: "GET",
    cookie: familyB.cookie,
  });
  assert(readRes.status === 404, "Family B cannot read Family A's store (gets 404)");

  // Family A submits feedback
  await req("/api/feedback", {
    method: "POST",
    cookie: familyA.cookie,
    body: { text: "Family A private feedback " + Date.now() },
  });

  // Family B lists feedback — should not see Family A's
  const fbRes = await req("/api/feedback", {
    method: "GET",
    cookie: familyB.cookie,
  });
  assert(Array.isArray(fbRes.json), "Feedback response is an array");
  const hasFamilyAFeedback = Array.isArray(fbRes.json) && fbRes.json.some(f => f.text?.includes("Family A private feedback"));
  assert(!hasFamilyAFeedback, "Family B cannot see Family A's feedback");

  // Family B tries to select Family A's member
  const meA = await req("/api/auth/me", { cookie: familyA.cookie });
  const memberIdA = meA.json?.members?.[0]?.id;
  if (memberIdA) {
    const selectRes = await req("/api/auth/select-member", {
      method: "POST",
      cookie: familyB.cookie,
      body: { memberId: memberIdA },
    });
    assert(selectRes.status === 404, "Family B cannot select Family A's member (gets 404)");
  }
}

async function testIDOR(familyA, familyB) {
  console.log("\n--- IDOR (Insecure Direct Object Reference) ---");

  // Get Family A's member ID
  const meA = await req("/api/auth/me", { cookie: familyA.cookie });
  const memberA = meA.json?.members?.[0]?.id;

  // Family B tries to modify Family A's member
  if (memberA) {
    const patchRes = await req(`/api/auth/member/${memberA}`, {
      method: "PATCH",
      cookie: familyB.cookie,
      body: { isAdmin: true },
    });
    assert(patchRes.status === 404 || patchRes.status === 403, "Cannot modify another family's member via IDOR");
  }

  // Family B tries to set PIN on Family A's member
  if (memberA) {
    const pinRes = await req("/api/auth/set-pin", {
      method: "POST",
      cookie: familyB.cookie,
      body: { memberId: memberA, pin: "1234" },
    });
    assert(pinRes.status === 403 || pinRes.status === 404, "Cannot set PIN on another family's member");
  }

  // Family B tries to set password on Family A's member
  if (memberA) {
    const pwRes = await req("/api/auth/set-password", {
      method: "POST",
      cookie: familyB.cookie,
      body: { memberId: memberA, password: "hackedpw123" },
    });
    assert(pwRes.status === 403 || pwRes.status === 404, "Cannot set password on another family's member");
  }

  // Family B tries to PATCH Family A's feedback
  const fbSubmit = await req("/api/feedback", {
    method: "POST",
    cookie: familyA.cookie,
    body: { text: "Family A feedback for IDOR test " + Date.now() },
  });
  const fbId = fbSubmit.json?.id;
  if (fbId) {
    const fbPatch = await req(`/api/feedback/${fbId}`, {
      method: "PATCH",
      cookie: familyB.cookie,
      body: { completed: true, note: "hacked" },
    });
    assert(fbPatch.status === 403 || fbPatch.status === 404, "Cannot PATCH another family's feedback");
  }
}

async function testIntraFamilyPrivilegeEscalation(sharedFamily, childSession) {
  console.log("\n--- Intra-Family Privilege Escalation ---");

  // Add a second non-admin member (using admin cookie)
  const addRes = await req("/api/auth/add-member", {
    method: "POST",
    cookie: sharedFamily.cookie,
    body: { displayName: "OtherKid_" + Date.now(), isAdmin: false },
  });
  const otherKidId = addRes.json?.id;

  // Non-admin tries to set another member's PIN
  if (otherKidId) {
    const pinRes = await req("/api/auth/set-pin", {
      method: "POST",
      cookie: childSession.cookie,
      body: { memberId: otherKidId, pin: "9999" },
    });
    assert(pinRes.status === 403, "Non-admin cannot set another member's PIN (got " + pinRes.status + ")");
  }

  // Non-admin tries to change family password
  const changePwRes = await req("/api/auth/change-family-password", {
    method: "POST",
    cookie: childSession.cookie,
    body: { newPassword: "hackedpass123" },
  });
  assert(changePwRes.status === 403, "Non-admin cannot change family password (got " + changePwRes.status + ")");
}

async function testInputValidation(sharedFamily) {
  console.log("\n--- Input Validation ---");

  // SQL injection attempts in store keys
  const sqlPayloads = [
    "'; DROP TABLE stores; --",
    "' OR '1'='1",
    "\" UNION SELECT * FROM families --",
  ];

  for (const payload of sqlPayloads) {
    const r = await req(`/api/store/${encodeURIComponent(payload)}`, {
      method: "PUT",
      cookie: sharedFamily.cookie,
      body: { value: "test" },
    });
    assert(r.status === 200, `SQL injection in key doesn't crash: ${payload.substring(0, 30)}`);

    // Verify the literal payload was stored (not interpreted as SQL)
    const getRes = await req(`/api/store/${encodeURIComponent(payload)}`, {
      method: "GET",
      cookie: sharedFamily.cookie,
    });
    assert(getRes.json?.value === "test", `SQL payload stored as literal string: ${payload.substring(0, 30)}`);
  }

  // SQL injection in feedback text
  const sqlFbRes = await req("/api/feedback", {
    method: "POST",
    cookie: sharedFamily.cookie,
    body: { text: "'; DROP TABLE feedback; --" },
  });
  assert(sqlFbRes.status === 200, "SQL injection in feedback text doesn't crash");

  // XSS in feedback (should be stored as-is, rendering must escape)
  const xssRes = await req("/api/feedback", {
    method: "POST",
    cookie: sharedFamily.cookie,
    body: { text: '<script>alert("xss")</script>' },
  });
  assert(xssRes.status === 200, "XSS payload accepted in feedback (rendering must escape)");

  // Missing required fields
  const missingRes = await req("/api/auth/register", {
    method: "POST",
    body: { familyName: "X" },
  });
  assert(missingRes.status === 400, "Registration with missing fields returns 400");
  assert(missingRes.json?.error?.includes("required"), "Registration error mentions required fields");

  // Empty feedback
  const emptyFb = await req("/api/feedback", {
    method: "POST",
    cookie: sharedFamily.cookie,
    body: { text: "" },
  });
  assert(emptyFb.status === 400, "Empty feedback returns 400");

  // Short password
  const shortPwRes = await req("/api/auth/register", {
    method: "POST",
    body: { familyName: "ShortPw_" + Date.now(), adminName: "Admin", password: "abc" },
  });
  assert(shortPwRes.status === 400, "Short password rejected on register");
  assert(shortPwRes.json?.error?.includes("8 characters"), "Short password error mentions 8 characters");

  // Invalid PIN format
  const invalidPinRes = await req("/api/auth/set-pin", {
    method: "POST",
    cookie: sharedFamily.cookie,
    body: { pin: "abc" },
  });
  assert(invalidPinRes.status === 400, "Non-numeric PIN rejected");

  const longPinRes = await req("/api/auth/set-pin", {
    method: "POST",
    cookie: sharedFamily.cookie,
    body: { pin: "12345" },
  });
  assert(longPinRes.status === 400, "5-digit PIN rejected");
}

async function testAccountEnumeration() {
  console.log("\n--- Account Enumeration Prevention ---");

  // Register a family we know exists
  const ts = Date.now();
  const knownFamily = await registerFamily("EnumTest_" + ts, "Admin");
  if (!knownFamily.cookie) { console.log("  SKIP (registration failed)"); skipped++; return; }

  // Wrong family name
  const wrongFamily = await req("/api/auth/login", {
    method: "POST",
    body: { familyName: "NonExistentFamily_" + ts, password: "testpass123" },
  });

  // Wrong password for existing family
  const wrongPassword = await req("/api/auth/login", {
    method: "POST",
    body: { familyName: "EnumTest_" + ts, password: "wrongpassword123" },
  });

  // Both should return the same error message to prevent enumeration
  assert(
    wrongFamily.json?.error === wrongPassword.json?.error,
    `Login errors are identical for wrong-family vs wrong-password ("${wrongFamily.json?.error}" === "${wrongPassword.json?.error}")`
  );
}

async function testCookieSecurity(setCookieRaw) {
  console.log("\n--- Cookie Security ---");

  assert(setCookieRaw.toLowerCase().includes("httponly"), "Session cookie has httpOnly flag");
  assert(setCookieRaw.toLowerCase().includes("samesite"), "Session cookie has sameSite flag");
  // secure flag only present in production mode
}

async function testSecurityHeaders() {
  console.log("\n--- Security Response Headers ---");

  const r = await req("/");
  assert(
    r.headers.get("x-content-type-options") === "nosniff",
    "X-Content-Type-Options: nosniff header present"
  );
  assert(
    r.headers.get("x-frame-options") === "DENY",
    "X-Frame-Options: DENY header present"
  );
}

async function testSessionTokenEntropy() {
  console.log("\n--- Session Token Entropy ---");

  const ts = Date.now();
  const family = await registerFamily("EntropyTest_" + ts, "Admin");
  if (!family.cookie) { console.log("  SKIP (registration failed)"); skipped++; return; }

  // Extract session ID from cookie
  const sessionId = family.cookie.replace("session=", "");

  // Verify it matches UUID v4 format
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert(uuidV4Regex.test(sessionId), `Session ID is UUID v4 format: ${sessionId}`);
}

async function testRateLimiting() {
  console.log("\n--- Rate Limiting ---");

  // Use a login attempt that won't count against the shared PIN limiter
  const r = await req("/api/auth/login", {
    method: "POST",
    body: { familyName: "nonexistent", password: "test1234" },
  });
  const rateLimitHeader = r.headers.get("ratelimit-limit") || r.headers.get("x-ratelimit-limit");
  assert(rateLimitHeader !== null, "Rate limit headers present on login endpoint");
}

async function testRateLimiterFunctional() {
  console.log("\n--- Rate Limiter Functional Test ---");

  // Register limiter allows 10 per hour. We register with invalid data to trigger
  // the limiter without creating real accounts. We use short passwords to get 400s.
  // This counts against the register rate limiter.
  // We've already used ~4 registrations in this test run, so send 7 more to hit 10,
  // then the 11th should be rate limited.
  const needed = 7;
  for (let i = 0; i < needed; i++) {
    await req("/api/auth/register", {
      method: "POST",
      body: { familyName: `RateFill_${Date.now()}_${i}`, adminName: "Admin", password: "short" },
    });
  }

  // The next registration should be rate limited
  const rateLimited = await req("/api/auth/register", {
    method: "POST",
    body: { familyName: `RateOver_${Date.now()}`, adminName: "Admin", password: "short" },
  });
  assert(rateLimited.status === 429, `Rate limiter returns 429 after exceeding limit (got ${rateLimited.status})`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log(`\nParentSlop Security Pen Test Suite`);
  console.log(`Target: ${BASE}\n`);

  // Verify server is running
  try {
    const healthCheck = await req("/");
    if (healthCheck.status !== 200) {
      console.error("Server not responding at " + BASE);
      process.exit(1);
    }
  } catch (e) {
    console.error("Cannot connect to server at " + BASE + ": " + e.message);
    process.exit(1);
  }

  // Register test families up front (minimizes registrations)
  const ts = Date.now();
  console.log("Setting up test families...");
  const familyA = await registerFamily("SecTestA_" + ts, "ParentA");
  const familyB = await registerFamily("SecTestB_" + ts, "ParentB");

  if (!familyA.cookie || !familyB.cookie) {
    console.error("Failed to register test families. Are rate limits blocking? Restart the server and try again.");
    console.error("Family A status:", familyA.status, "Family B status:", familyB.status);
    process.exit(1);
  }

  // Store family name for login-based tests
  familyA.name = "SecTestA_" + ts;
  familyB.name = "SecTestB_" + ts;

  // Create a shared child session (1 select-member call) to reuse across tests
  // This minimizes pin rate limiter consumption
  const childSession = await setupChildSession(familyA);
  if (!childSession) {
    console.error("Failed to create child session for testing");
    process.exit(1);
  }

  // Tests that don't need any family sessions
  await testStaticFileIsolation();
  await testPathTraversal();
  await testAuthEnforcement();
  await testSecurityHeaders();
  await testCookieSecurity(familyA.setCookieRaw);

  // Tests using the shared child session (no additional select-member calls)
  await testAdminEnforcement(familyA, childSession);
  await testStoreAdminAuthorization(familyA, childSession);
  await testBackupAndFeedbackAuthorization(familyA, childSession);
  await testIntraFamilyPrivilegeEscalation(familyA, childSession);

  // Cross-family tests (1 select-member call in isolation test)
  await testCrossFamilyIsolation(familyA, familyB);
  await testIDOR(familyA, familyB);

  // Input validation uses familyA cookie
  await testInputValidation(familyA);

  // Tests that register their own families (independent of familyA sessions)
  await testAccountEnumeration();
  await testSessionTokenEntropy();
  await testRateLimiting();

  // Session lifecycle MUST run after all tests using familyA/childSession cookies,
  // because password change invalidates all sessions for the family
  await testSessionLifecycle(familyA);

  // Rate limiter functional test must run last (exhausts register limiter)
  await testRateLimiterFunctional();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

// If a URL was provided, run directly against it; otherwise spin up a temp server
if (BASE) {
  runTests().catch((err) => { console.error("Test suite error:", err); process.exit(1); });
} else {
  withTestServer(async (base) => {
    BASE = base;
    await runTests();
  }).catch((err) => { console.error("Test suite error:", err); process.exit(1); });
}
