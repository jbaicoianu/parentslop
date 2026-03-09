#!/usr/bin/env node
/**
 * ParentSlop Security Pen Test Suite
 *
 * Runs against a live server instance and verifies security properties.
 * Usage: node tests/security.test.js [base_url]
 * Default base_url: http://localhost:8080
 */

const BASE = process.argv[2] || "http://localhost:8080";

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
  // Use getSetCookie() for reliable set-cookie parsing
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
    assert(r.status === 400 || r.status === 403 || r.status === 404, `Path traversal blocked: ${p} (got ${r.status})`);
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
  }
}

async function testAdminEnforcement(sharedFamily) {
  console.log("\n--- Admin Enforcement (403 for non-admin) ---");

  // Add a non-admin member
  const addRes = await req("/api/auth/add-member", {
    method: "POST",
    cookie: sharedFamily.cookie,
    body: { displayName: "NonAdminKid_" + Date.now(), isAdmin: false },
  });
  const kidId = addRes.json?.id;
  if (!kidId) { console.log("  SKIP (failed to add member)"); skipped++; return; }

  // Login fresh so we don't mess up the shared session
  const freshLogin = await loginFamily(sharedFamily.name, "testpass123");
  if (!freshLogin.cookie) { console.log("  SKIP (login failed)"); skipped++; return; }

  // Select the non-admin member
  await req("/api/auth/select-member", {
    method: "POST",
    cookie: freshLogin.cookie,
    body: { memberId: kidId },
  });

  const adminEndpoints = [
    { method: "POST", path: "/api/auth/add-member", body: { displayName: "Hacker" } },
    { method: "PATCH", path: `/api/auth/member/${kidId}`, body: { isAdmin: true } },
    { method: "POST", path: "/api/auth/set-auth-level", body: { authLevel: "pin" } },
  ];

  for (const ep of adminEndpoints) {
    const r = await req(ep.path, { method: ep.method, cookie: freshLogin.cookie, body: ep.body });
    assert(r.status === 403, `${ep.method} ${ep.path} returns 403 for non-admin (got ${r.status})`);
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
  assert(
    readRes.status === 404 || (readRes.json?.value !== "family-a-secret"),
    "Family B cannot read Family A's store values"
  );

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
  const hasFamilyAFeedback = (fbRes.json || []).some(f => f.text?.includes("Family A private feedback"));
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
    assert(selectRes.status === 404 || selectRes.json?.error, "Family B cannot select Family A's member");
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

async function testCookieSecurity(setCookieRaw) {
  console.log("\n--- Cookie Security ---");

  assert(setCookieRaw.toLowerCase().includes("httponly"), "Session cookie has httpOnly flag");
  assert(setCookieRaw.toLowerCase().includes("samesite"), "Session cookie has sameSite flag");
  // secure flag only present in production mode
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

  // Password change invalidates other sessions
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

    // Change password from session 1
    await req("/api/auth/change-family-password", {
      method: "POST",
      cookie: login1.cookie,
      body: { newPassword: "newpassword123" },
    });

    // Session 2 should be invalidated
    const afterPwChange = await req("/api/auth/me", { cookie: login2.cookie });
    assert(afterPwChange.json?.authenticated === false, "Other sessions invalidated after password change");

    // Change password back for future test runs
    await req("/api/auth/change-family-password", {
      method: "POST",
      cookie: login1.cookie,
      body: { newPassword: "testpass123" },
    });
  }
}

async function testRateLimiting() {
  console.log("\n--- Rate Limiting ---");

  const r = await req("/api/auth/login", {
    method: "POST",
    body: { familyName: "nonexistent", password: "test1234" },
  });
  const rateLimitHeader = r.headers.get("ratelimit-limit") || r.headers.get("x-ratelimit-limit");
  assert(rateLimitHeader !== null, "Rate limit headers present on login endpoint");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
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

  await testStaticFileIsolation();
  await testPathTraversal();
  await testAuthEnforcement();
  await testAdminEnforcement(familyA);
  await testCrossFamilyIsolation(familyA, familyB);
  await testIDOR(familyA, familyB);
  await testInputValidation(familyA);
  await testCookieSecurity(familyA.setCookieRaw);
  await testSessionLifecycle(familyA);
  await testRateLimiting();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});
