const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const CRSQLITE_EXT = path.join(__dirname, "node_modules/@vlcn.io/crsqlite/dist/crsqlite");
const BACKUP_BUCKET = process.env.BACKUP_BUCKET || null;
const s3 = BACKUP_BUCKET ? new S3Client() : null;

const app = express();
const PORT = process.env.PORT || 8080;

// --- SQLite setup ------------------------------------------------------------

const dbArg = process.argv.indexOf("--db");
const DB_PATH = dbArg !== -1 && process.argv[dbArg + 1]
  ? path.resolve(process.argv[dbArg + 1])
  : path.join(__dirname, "parentslop.db");

// Check DB integrity before doing anything else. If corrupt, try restoring from S3.
async function ensureHealthyDb() {
  if (!fs.existsSync(DB_PATH)) return;
  let testDb;
  try {
    // Clean up stale SHM file (shared-memory index — safely reconstructed by SQLite).
    // Do NOT delete the WAL file: it may contain committed transactions that haven't
    // been checkpointed into the main DB yet (e.g. recent sessions). SQLite will
    // replay/recover it automatically on open.
    const shmPath = DB_PATH + "-shm";
    if (fs.existsSync(shmPath)) {
      console.log("Removing stale -shm file");
      fs.unlinkSync(shmPath);
    }
    testDb = new Database(DB_PATH);
    testDb.loadExtension(CRSQLITE_EXT);
    const result = testDb.pragma("integrity_check");
    if (result[0]?.integrity_check !== "ok") throw new Error(`integrity_check: ${result[0]?.integrity_check}`);
    // Also verify tables are actually readable
    testDb.prepare("SELECT count(*) FROM stores").get();
    testDb.prepare("SELECT count(*) FROM feedback").get();
    try { testDb.exec("SELECT crsql_finalize()"); } catch {}
    testDb.close();
  } catch (e) {
    if (testDb) try { testDb.exec("SELECT crsql_finalize()"); } catch {}
    if (testDb) try { testDb.close(); } catch {}
    console.error(`DB corrupt: ${e.message}`);
    if (!s3) { console.error("No BACKUP_BUCKET configured — cannot auto-restore"); return; }
    console.log("Attempting restore from S3...");
    try {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: BACKUP_BUCKET, Prefix: "backups/parentslop-" }));
      const backups = (list.Contents || []).sort((a, b) => b.LastModified - a.LastModified);
      if (backups.length === 0) { console.error("No backups found in S3"); return; }
      const latest = backups[0];
      console.log(`Restoring from ${latest.Key} (${latest.LastModified.toISOString()})`);
      const resp = await s3.send(new GetObjectCommand({ Bucket: BACKUP_BUCKET, Key: latest.Key }));
      const chunks = []; for await (const chunk of resp.Body) chunks.push(chunk);
      // Move corrupt DB aside
      fs.renameSync(DB_PATH, DB_PATH + ".corrupt");
      for (const suf of ["-wal", "-shm"]) { try { fs.unlinkSync(DB_PATH + suf); } catch {} }
      fs.writeFileSync(DB_PATH, Buffer.concat(chunks));
      console.log("Restore complete");
    } catch (restoreErr) {
      console.error("Restore failed:", restoreErr.message);
    }
  }
}

// DB is opened in initDb(), called during async startup after integrity check.
let db;

function initDb() {
  db = new Database(DB_PATH);
  db.loadExtension(CRSQLITE_EXT);
  db.pragma("journal_mode = WAL");
  if (BACKUP_BUCKET) db.pragma("locking_mode = EXCLUSIVE"); // Required for NFS/EFS — avoids shared memory issues

  db.exec(`
    CREATE TABLE IF NOT EXISTS stores (
      key TEXT NOT NULL PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT,
      text TEXT DEFAULT '',
      user_id TEXT,
      user_name TEXT,
      current_view TEXT,
      user_agent TEXT,
      created_at TEXT,
      completed_at TEXT,
      resolution_note TEXT
    )
  `);

  // Migrate: add columns if missing (existing databases)
  try { db.prepare("SELECT completed_at FROM feedback LIMIT 1").get(); } catch {
    db.exec("ALTER TABLE feedback ADD COLUMN completed_at TEXT");
  }
  try { db.prepare("SELECT resolution_note FROM feedback LIMIT 1").get(); } catch {
    db.exec("ALTER TABLE feedback ADD COLUMN resolution_note TEXT");
  }
  try { db.prepare("SELECT family_id FROM feedback LIMIT 1").get(); } catch {
    db.exec("ALTER TABLE feedback ADD COLUMN family_id TEXT");
  }

  // --- Auth tables ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS families (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      auth_level TEXT NOT NULL DEFAULT 'none',
      needs_password_reset INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS family_members (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL REFERENCES families(id),
      display_name TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      pin_hash TEXT,
      password_hash TEXT,
      salt TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL REFERENCES families(id),
      member_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  // --- CR-SQLite CRR setup ---
  // Migrate existing tables for cr-sqlite compatibility (in a transaction for safety):
  // - PK columns must be NOT NULL
  // - Non-PK NOT NULL columns must have a DEFAULT value
  function migrateToCrrCompatible(tableName, pkCol) {
    const cols = db.pragma(`table_info(${tableName})`);
    const pk = cols.find(c => c.name === pkCol);
    const needsPkFix = pk && !pk.notnull;
    const needsNotNullFix = cols.some(c => !c.pk && c.notnull && c.dflt_value === null);
    if (!needsPkFix && !needsNotNullFix) return;

    console.log(`Migrating ${tableName} for cr-sqlite compatibility`);
    const colDefs = cols.map(c => {
      let def = `${c.name} ${c.type || 'TEXT'}`;
      if (c.pk) {
        def += ' NOT NULL PRIMARY KEY';
      } else if (c.notnull && c.dflt_value === null) {
        def += ` DEFAULT ''`;
      } else {
        if (c.notnull) def += ' NOT NULL';
        if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
      }
      return def;
    }).join(', ');
    db.transaction(() => {
      db.exec(`CREATE TABLE ${tableName}_migrate (${colDefs})`);
      db.exec(`INSERT INTO ${tableName}_migrate SELECT * FROM ${tableName}`);
      db.exec(`DROP TABLE ${tableName}`);
      db.exec(`ALTER TABLE ${tableName}_migrate RENAME TO ${tableName}`);
    })();
  }

  migrateToCrrCompatible('stores', 'key');
  migrateToCrrCompatible('feedback', 'id');

  // Mark tables as CRRs (idempotent — no-ops if already CRRs)
  try { db.exec("SELECT crsql_as_crr('stores')"); } catch (e) {
    if (!e.message.includes('already')) throw e;
  }
  try { db.exec("SELECT crsql_as_crr('feedback')"); } catch (e) {
    if (!e.message.includes('already')) throw e;
  }

  // --- Event-sourced data tables (Phase 1) ---

  // Config tables (CRRs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      name TEXT DEFAULT '',
      description TEXT DEFAULT '',
      recurrence TEXT DEFAULT 'daily',
      available INTEGER DEFAULT 1,
      category TEXT DEFAULT 'routine',
      pay_type TEXT DEFAULT 'fixed',
      rewards TEXT DEFAULT '{}',
      streak_bonus TEXT,
      timer_bonus TEXT,
      bonus_criteria TEXT,
      assigned_users TEXT DEFAULT '[]',
      required_tags TEXT DEFAULT '[]',
      active_days TEXT DEFAULT '[]',
      multi_user INTEGER DEFAULT 1,
      max_payout TEXT,
      is_penalty INTEGER DEFAULT 0,
      requires_approval INTEGER DEFAULT 0,
      last_activated_at TEXT,
      archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
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
    CREATE TABLE IF NOT EXISTS currencies (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      name TEXT DEFAULT '',
      symbol TEXT DEFAULT '',
      decimals INTEGER DEFAULT 0,
      color TEXT DEFAULT '#66d9ef',
      created_at TEXT DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_items (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      name TEXT DEFAULT '',
      description TEXT DEFAULT '',
      costs TEXT DEFAULT '{}',
      archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT ''
    )
  `);

  // Event tables (CRRs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS completions (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      task_id TEXT DEFAULT '',
      user_id TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      completed_at TEXT DEFAULT '',
      approved_at TEXT,
      rejected_at TEXT,
      rejection_note TEXT,
      rewards TEXT DEFAULT '{}',
      timer_seconds INTEGER,
      streak_count INTEGER DEFAULT 0,
      streak_multiplier REAL DEFAULT 1,
      timer_multiplier REAL DEFAULT 1,
      bonus_criteria_checked TEXT,
      bonus_criteria_multiplier REAL,
      note TEXT DEFAULT '',
      is_penalty INTEGER DEFAULT 0,
      is_hourly INTEGER DEFAULT 0,
      total_seconds INTEGER,
      worklog TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS redemptions (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      shop_item_id TEXT DEFAULT '',
      user_id TEXT DEFAULT '',
      costs TEXT DEFAULT '{}',
      purchased_at TEXT DEFAULT '',
      fulfilled INTEGER DEFAULT 0,
      fulfilled_at TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS balance_adjustments (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      user_id TEXT DEFAULT '',
      currency_id TEXT DEFAULT '',
      delta REAL DEFAULT 0,
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS job_claims (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      task_id TEXT DEFAULT '',
      user_id TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      accepted_at TEXT DEFAULT ''
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS worklog_entries (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      task_id TEXT DEFAULT '',
      user_id TEXT DEFAULT '',
      clock_in TEXT DEFAULT '',
      clock_out TEXT
    )
  `);

  // Migrate: add _client_id columns for offline queue idempotency
  const clientIdTables = ['completions', 'redemptions', 'job_claims', 'worklog_entries'];
  for (const table of clientIdTables) {
    try { db.prepare(`SELECT _client_id FROM ${table} LIMIT 1`).get(); } catch {
      db.exec(`ALTER TABLE ${table} ADD COLUMN _client_id TEXT`);
    }
  }

  // Derived table (NOT a CRR — recomputed from events)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_balances (
      user_id TEXT NOT NULL,
      family_id TEXT NOT NULL DEFAULT '',
      currency_id TEXT NOT NULL,
      balance REAL DEFAULT 0,
      PRIMARY KEY (user_id, currency_id)
    )
  `);

  // Mark new tables as CRRs
  const crrTables = ['tasks', 'users', 'currencies', 'shop_items', 'completions', 'redemptions', 'balance_adjustments', 'job_claims', 'worklog_entries'];
  for (const table of crrTables) {
    migrateToCrrCompatible(table, 'id');
    try { db.exec(`SELECT crsql_as_crr('${table}')`); } catch (e) {
      if (!e.message.includes('already')) throw e;
    }
  }

  // Local bookkeeping for sync state (NOT a CRR)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      peer_url TEXT PRIMARY KEY,
      last_pushed_version INTEGER DEFAULT 0,
      last_pulled_version INTEGER DEFAULT 0,
      last_sync_at TEXT
    )
  `);
}

// --- Password hashing utilities ----------------------------------------------

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve({ hash: derivedKey.toString("hex"), salt });
    });
  });
}

function verifyPassword(password, hash, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      const hashBuffer = Buffer.from(hash, "hex");
      resolve(crypto.timingSafeEqual(derivedKey, hashBuffer));
    });
  });
}

// --- Session helpers ---------------------------------------------------------

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function createSession(familyId, memberId = null) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  db.prepare("INSERT INTO sessions (id, family_id, member_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(id, familyId, memberId, now, expiresAt);
  return { id, familyId, memberId, expiresAt };
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    return null;
  }
  return session;
}

// --- Auth middleware ----------------------------------------------------------

function requireFamilyAuth(req, res, next) {
  const sessionId = req.cookies?.session;
  const session = getSession(sessionId);
  if (!session) {
    return res.status(401).json({ error: "not authenticated" });
  }
  req.familyId = session.family_id;
  req.memberId = session.member_id;
  req.sessionId = session.id;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.memberId) return res.status(403).json({ error: "no member selected" });
  const member = db.prepare("SELECT * FROM family_members WHERE id = ? AND family_id = ?").get(req.memberId, req.familyId);
  if (!member || !member.is_admin) return res.status(403).json({ error: "admin required" });
  next();
}

// --- Rate limiting -----------------------------------------------------------

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "too many login attempts, try again later" },
});

const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "too many PIN attempts, try again later" },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many registration attempts, try again later" },
});

// --- Admin-only store keys ---------------------------------------------------

const ADMIN_WRITE_KEYS = new Set([
  "parentslop.tasks.v1",
  "parentslop.currencies.v1",
  "parentslop.shop.v1",
  "parentslop.users.v1",
]);

// --- Middleware ---------------------------------------------------------------

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

// Security response headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use(express.static(path.join(__dirname, "static")));

// --- Routes ------------------------------------------------------------------

// GET /api/health — lightweight health check (no auth required)
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// GET /api/store/:key — read a single store
app.get("/api/store/:key", requireFamilyAuth, (req, res) => {
  const nsKey = `${req.familyId}:${req.params.key}`;
  const row = db.prepare("SELECT key, value, updated_at FROM stores WHERE key = ?").get(nsKey);
  if (!row) return res.status(404).json({ error: "not found" });
  // Return un-namespaced key to client
  res.json({ key: req.params.key, value: row.value, updated_at: row.updated_at });
});

// PUT /api/store/:key — upsert a single store
app.put("/api/store/:key", requireFamilyAuth, (req, res) => {
  // Admin-only key authorization
  if (ADMIN_WRITE_KEYS.has(req.params.key)) {
    if (!req.memberId) return res.status(403).json({ error: "no member selected" });
    const member = db.prepare("SELECT is_admin FROM family_members WHERE id = ? AND family_id = ?").get(req.memberId, req.familyId);
    if (!member || !member.is_admin) return res.status(403).json({ error: "admin required" });
  }

  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: "missing value" });
  const now = new Date().toISOString();
  const nsKey = `${req.familyId}:${req.params.key}`;
  db.prepare(
    "INSERT INTO stores (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(nsKey, typeof value === "string" ? value : JSON.stringify(value), now);
  res.json({ ok: true });
});

// POST /api/store/sync — bulk upsert
app.post("/api/store/sync", requireFamilyAuth, (req, res) => {
  const { stores } = req.body;
  if (!stores || typeof stores !== "object") return res.status(400).json({ error: "missing stores object" });

  // Admin-only key authorization
  const hasAdminKeys = Object.keys(stores).some(k => ADMIN_WRITE_KEYS.has(k));
  if (hasAdminKeys) {
    if (!req.memberId) return res.status(403).json({ error: "no member selected" });
    const member = db.prepare("SELECT is_admin FROM family_members WHERE id = ? AND family_id = ?").get(req.memberId, req.familyId);
    if (!member || !member.is_admin) return res.status(403).json({ error: "admin required" });
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(
    "INSERT INTO stores (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) {
      const nsKey = `${req.familyId}:${key}`;
      upsert.run(nsKey, typeof value === "string" ? value : JSON.stringify(value), now);
    }
  });
  tx(Object.entries(stores));
  res.json({ ok: true, count: Object.keys(stores).length });
});

// --- Auth endpoints ----------------------------------------------------------

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function setCookie(res, sessionId) {
  res.cookie("session", sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DURATION_MS,
    path: "/",
  });
}

// POST /api/auth/register — create family + admin member + session
app.post("/api/auth/register", registerLimiter, async (req, res) => {
  try {
    const { familyName, adminName, password } = req.body;
    if (!familyName || typeof familyName !== "string" || !familyName.trim() ||
        !adminName || typeof adminName !== "string" || !adminName.trim() ||
        !password || typeof password !== "string") {
      return res.status(400).json({ error: "familyName, adminName, and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }

    const slug = slugify(familyName.trim());
    if (!slug) return res.status(400).json({ error: "invalid family name" });

    // Check uniqueness
    const existing = db.prepare("SELECT id FROM families WHERE slug = ?").get(slug);
    if (existing) return res.status(409).json({ error: "family name already taken" });

    const familyId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const { hash, salt } = await hashPassword(password);
    const now = new Date().toISOString();

    db.prepare("INSERT INTO families (id, name, slug, password_hash, salt, auth_level, created_at) VALUES (?, ?, ?, ?, ?, 'none', ?)").run(familyId, familyName.trim(), slug, hash, salt, now);
    db.prepare("INSERT INTO family_members (id, family_id, display_name, is_admin, created_at) VALUES (?, ?, ?, 1, ?)").run(memberId, familyId, adminName.trim(), now);

    const session = createSession(familyId, memberId);
    setCookie(res, session.id);

    res.json({ ok: true, familyId, memberId });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "registration failed" });
  }
});

// POST /api/auth/login — verify family password, create session
app.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const { familyName, password } = req.body;
    if (!familyName || typeof familyName !== "string" || !familyName.trim() ||
        !password || typeof password !== "string") {
      return res.status(400).json({ error: "familyName and password are required" });
    }

    const slug = slugify(familyName.trim());
    const family = db.prepare("SELECT * FROM families WHERE slug = ?").get(slug);
    if (!family) return res.status(401).json({ error: "invalid family name or password" });

    const valid = await verifyPassword(password, family.password_hash, family.salt);
    if (!valid) return res.status(401).json({ error: "invalid family name or password" });

    const session = createSession(family.id);
    setCookie(res, session.id);

    res.json({ ok: true, familyId: family.id, needsPasswordReset: !!family.needs_password_reset });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "login failed" });
  }
});

// GET /api/auth/me — session state
app.get("/api/auth/me", (req, res) => {
  const sessionId = req.cookies?.session;
  const session = getSession(sessionId);
  if (!session) return res.json({ authenticated: false });

  const family = db.prepare("SELECT id, name, slug, auth_level, needs_password_reset FROM families WHERE id = ?").get(session.family_id);
  if (!family) return res.json({ authenticated: false });

  const members = db.prepare("SELECT id, display_name, is_admin, pin_hash IS NOT NULL as has_pin, password_hash IS NOT NULL as has_password FROM family_members WHERE family_id = ?").all(family.id);

  const currentMember = session.member_id
    ? members.find((m) => m.id === session.member_id) || null
    : null;

  res.json({
    authenticated: true,
    family: {
      id: family.id,
      name: family.name,
      slug: family.slug,
      authLevel: family.auth_level,
      needsPasswordReset: !!family.needs_password_reset,
    },
    members: members.map((m) => ({
      id: m.id,
      displayName: m.display_name,
      isAdmin: !!m.is_admin,
      hasPin: !!m.has_pin,
      hasPassword: !!m.has_password,
    })),
    currentMember: currentMember ? {
      id: currentMember.id,
      displayName: currentMember.display_name,
      isAdmin: !!currentMember.is_admin,
    } : null,
  });
});

// POST /api/auth/select-member — set member in session
app.post("/api/auth/select-member", pinLimiter, requireFamilyAuth, async (req, res) => {
  try {
    const { memberId, pin, password } = req.body;
    if (!memberId) return res.status(400).json({ error: "memberId required" });

    const member = db.prepare("SELECT * FROM family_members WHERE id = ? AND family_id = ?").get(memberId, req.familyId);
    if (!member) return res.status(404).json({ error: "member not found" });

    const family = db.prepare("SELECT auth_level FROM families WHERE id = ?").get(req.familyId);
    const authLevel = family?.auth_level || "none";

    // Verify credentials based on auth level
    if (authLevel === "pin" && member.pin_hash) {
      if (!pin) return res.status(401).json({ error: "PIN required" });
      const valid = await verifyPassword(pin, member.pin_hash, member.salt);
      if (!valid) return res.status(401).json({ error: "invalid PIN" });
    } else if (authLevel === "password" && member.password_hash) {
      if (!password) return res.status(401).json({ error: "password required" });
      const valid = await verifyPassword(password, member.password_hash, member.salt);
      if (!valid) return res.status(401).json({ error: "invalid password" });
    }

    db.prepare("UPDATE sessions SET member_id = ? WHERE id = ?").run(memberId, req.sessionId);
    res.json({ ok: true });
  } catch (err) {
    console.error("Select member error:", err);
    res.status(500).json({ error: "failed to select member" });
  }
});

// POST /api/auth/switch-user — clear member_id from session
app.post("/api/auth/switch-user", requireFamilyAuth, (req, res) => {
  db.prepare("UPDATE sessions SET member_id = NULL WHERE id = ?").run(req.sessionId);
  res.json({ ok: true });
});

// POST /api/auth/logout — delete session, clear cookie
app.post("/api/auth/logout", (req, res) => {
  const sessionId = req.cookies?.session;
  if (sessionId) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }
  res.clearCookie("session", { path: "/" });
  res.json({ ok: true });
});

// POST /api/auth/add-member — admin-only: add family member
app.post("/api/auth/add-member", requireFamilyAuth, requireAdmin, (req, res) => {
  const { displayName, isAdmin } = req.body;
  if (!displayName || typeof displayName !== "string" || !displayName.trim()) return res.status(400).json({ error: "displayName required" });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO family_members (id, family_id, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, ?)").run(id, req.familyId, displayName.trim(), isAdmin ? 1 : 0, now);

  res.json({ ok: true, id, displayName: displayName.trim() });
});

// PATCH /api/auth/member/:id — admin-only: update member properties (isAdmin)
app.patch("/api/auth/member/:id", requireFamilyAuth, requireAdmin, (req, res) => {
  const memberId = req.params.id;
  const member = db.prepare("SELECT * FROM family_members WHERE id = ? AND family_id = ?").get(memberId, req.familyId);
  if (!member) return res.status(404).json({ error: "member not found" });

  if (req.body.isAdmin !== undefined) {
    db.prepare("UPDATE family_members SET is_admin = ? WHERE id = ? AND family_id = ?").run(req.body.isAdmin ? 1 : 0, memberId, req.familyId);
  }

  res.json({ ok: true });
});

// POST /api/auth/set-auth-level — admin-only: update family auth_level
app.post("/api/auth/set-auth-level", requireFamilyAuth, requireAdmin, (req, res) => {
  const { authLevel } = req.body;
  if (!["none", "pin", "password"].includes(authLevel)) {
    return res.status(400).json({ error: "authLevel must be none, pin, or password" });
  }
  db.prepare("UPDATE families SET auth_level = ? WHERE id = ?").run(authLevel, req.familyId);
  res.json({ ok: true });
});

// POST /api/auth/set-pin — set member PIN
app.post("/api/auth/set-pin", requireFamilyAuth, async (req, res) => {
  try {
    const { memberId, pin } = req.body;
    const targetId = memberId || req.memberId;
    if (!targetId) return res.status(400).json({ error: "memberId required" });

    // Only allow setting own pin, or admin setting anyone's
    if (targetId !== req.memberId) {
      const caller = db.prepare("SELECT is_admin FROM family_members WHERE id = ? AND family_id = ?").get(req.memberId, req.familyId);
      if (!caller?.is_admin) return res.status(403).json({ error: "admin required to set other members' PINs" });
    }

    const member = db.prepare("SELECT id FROM family_members WHERE id = ? AND family_id = ?").get(targetId, req.familyId);
    if (!member) return res.status(404).json({ error: "member not found" });

    if (!pin) {
      // Clear PIN
      db.prepare("UPDATE family_members SET pin_hash = NULL, salt = NULL WHERE id = ?").run(targetId);
    } else {
      if (!/^\d{4}$/.test(pin)) {
        return res.status(400).json({ error: "PIN must be exactly 4 digits" });
      }
      const { hash, salt } = await hashPassword(pin);
      db.prepare("UPDATE family_members SET pin_hash = ?, salt = ? WHERE id = ?").run(hash, salt, targetId);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Set PIN error:", err);
    res.status(500).json({ error: "failed to set PIN" });
  }
});

// POST /api/auth/set-password — set member password
app.post("/api/auth/set-password", requireFamilyAuth, async (req, res) => {
  try {
    const { memberId, password } = req.body;
    const targetId = memberId || req.memberId;
    if (!targetId) return res.status(400).json({ error: "memberId required" });

    // Only allow setting own password, or admin setting anyone's
    if (targetId !== req.memberId) {
      const caller = db.prepare("SELECT is_admin FROM family_members WHERE id = ? AND family_id = ?").get(req.memberId, req.familyId);
      if (!caller?.is_admin) return res.status(403).json({ error: "admin required" });
    }

    const member = db.prepare("SELECT id FROM family_members WHERE id = ? AND family_id = ?").get(targetId, req.familyId);
    if (!member) return res.status(404).json({ error: "member not found" });

    if (!password) {
      db.prepare("UPDATE family_members SET password_hash = NULL WHERE id = ?").run(targetId);
    } else {
      if (typeof password !== "string") return res.status(400).json({ error: "password must be a string" });
      const { hash, salt } = await hashPassword(password);
      db.prepare("UPDATE family_members SET password_hash = ?, salt = ? WHERE id = ?").run(hash, salt, targetId);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Set password error:", err);
    res.status(500).json({ error: "failed to set password" });
  }
});

// POST /api/auth/change-family-password — admin (or during password reset): change family password
app.post("/api/auth/change-family-password", requireFamilyAuth, async (req, res) => {
  try {
    // Allow without member selection if needs_password_reset is set (migration flow)
    const family = db.prepare("SELECT needs_password_reset FROM families WHERE id = ?").get(req.familyId);
    if (!family?.needs_password_reset) {
      // Normal flow: require admin
      if (!req.memberId) return res.status(403).json({ error: "no member selected" });
      const member = db.prepare("SELECT is_admin FROM family_members WHERE id = ? AND family_id = ?").get(req.memberId, req.familyId);
      if (!member?.is_admin) return res.status(403).json({ error: "admin required" });
    }

    const { newPassword } = req.body;
    if (!newPassword || typeof newPassword !== "string") return res.status(400).json({ error: "newPassword required" });
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }

    const { hash, salt } = await hashPassword(newPassword);
    db.prepare("UPDATE families SET password_hash = ?, salt = ?, needs_password_reset = 0 WHERE id = ?").run(hash, salt, req.familyId);

    // Invalidate all other sessions for this family
    db.prepare("DELETE FROM sessions WHERE family_id = ? AND id != ?").run(req.familyId, req.sessionId);

    res.json({ ok: true });
  } catch (err) {
    console.error("Change family password error:", err);
    res.status(500).json({ error: "failed to change password" });
  }
});

// --- Feedback ----------------------------------------------------------------

// POST /api/feedback — submit feedback
app.post("/api/feedback", requireFamilyAuth, (req, res) => {
  const { text, userId, userName, currentView, userAgent } = req.body;
  if (!text || typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "missing text" });
  const id = crypto.randomUUID().split("-")[0];
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO feedback (id, family_id, text, user_id, user_name, current_view, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, req.familyId, text.trim(), userId || null, userName || null, currentView || null, userAgent || null, createdAt);
  res.json({ ok: true, id });
});

// GET /api/feedback — list feedback for current family
app.get("/api/feedback", requireFamilyAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM feedback WHERE family_id = ? ORDER BY created_at DESC").all(req.familyId);
  res.json(rows);
});

// PATCH /api/feedback/:id — mark feedback completed/uncompleted with optional note
app.patch("/api/feedback/:id", requireFamilyAuth, requireAdmin, (req, res) => {
  const { completed, note } = req.body;
  const completedAt = completed ? new Date().toISOString() : null;
  const resolutionNote = completed ? (note || null) : null;
  const result = db.prepare("UPDATE feedback SET completed_at = ?, resolution_note = ? WHERE id = ? AND family_id = ?").run(completedAt, resolutionNote, req.params.id, req.familyId);
  if (result.changes === 0) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// --- SSE (Server-Sent Events) ------------------------------------------------

const sseClients = new Map(); // familyId → Set<res>

function broadcastSSE(familyId, event, data) {
  const clients = sseClients.get(familyId);
  if (!clients || clients.size === 0) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.write(msg); } catch { clients.delete(client); }
  }
}

app.get("/api/events/stream", requireFamilyAuth, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n"); // initial comment to flush

  if (!sseClients.has(req.familyId)) sseClients.set(req.familyId, new Set());
  sseClients.get(req.familyId).add(res);

  const keepAlive = setInterval(() => { try { res.write(":\n\n"); } catch {} }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
    const clients = sseClients.get(req.familyId);
    if (clients) { clients.delete(res); if (clients.size === 0) sseClients.delete(req.familyId); }
  });
});

// --- Typed API: helpers ------------------------------------------------------

function jsonOrDefault(val, def) {
  if (!val) return def;
  try { return JSON.parse(val); } catch { return def; }
}

// Convert a tasks DB row to the client-facing shape (camelCase, parsed JSON)
function taskRowToObj(row) {
  return {
    id: row.id, familyId: row.family_id, name: row.name, description: row.description,
    recurrence: row.recurrence, available: !!row.available, category: row.category,
    payType: row.pay_type, rewards: jsonOrDefault(row.rewards, {}),
    streakBonus: jsonOrDefault(row.streak_bonus, null), timerBonus: jsonOrDefault(row.timer_bonus, null),
    bonusCriteria: jsonOrDefault(row.bonus_criteria, null),
    assignedUsers: jsonOrDefault(row.assigned_users, []), requiredTags: jsonOrDefault(row.required_tags, []),
    activeDays: jsonOrDefault(row.active_days, []), multiUser: !!row.multi_user,
    maxPayout: jsonOrDefault(row.max_payout, null), isPenalty: !!row.is_penalty,
    requiresApproval: !!row.requires_approval, lastActivatedAt: row.last_activated_at,
    archived: !!row.archived, createdAt: row.created_at,
  };
}

function userRowToObj(row) {
  return {
    id: row.id, familyId: row.family_id, name: row.name, role: row.role,
    avatar: row.avatar, tags: jsonOrDefault(row.tags, []), createdAt: row.created_at,
    isAdmin: row.role === "parent",
  };
}

function currencyRowToObj(row) {
  return {
    id: row.id, familyId: row.family_id, name: row.name, symbol: row.symbol,
    decimals: row.decimals, color: row.color, createdAt: row.created_at,
  };
}

function shopItemRowToObj(row) {
  return {
    id: row.id, familyId: row.family_id, name: row.name, description: row.description,
    costs: jsonOrDefault(row.costs, {}), archived: !!row.archived, createdAt: row.created_at,
  };
}

function completionRowToObj(row) {
  return {
    id: row.id, familyId: row.family_id, taskId: row.task_id, userId: row.user_id,
    status: row.status, completedAt: row.completed_at, approvedAt: row.approved_at,
    rejectedAt: row.rejected_at, rejectionNote: row.rejection_note,
    rewards: jsonOrDefault(row.rewards, {}), timerSeconds: row.timer_seconds,
    streakCount: row.streak_count, streakMultiplier: row.streak_multiplier,
    timerMultiplier: row.timer_multiplier,
    bonusCriteriaChecked: jsonOrDefault(row.bonus_criteria_checked, null),
    bonusCriteriaMultiplier: row.bonus_criteria_multiplier, note: row.note,
    isPenalty: !!row.is_penalty, isHourly: !!row.is_hourly,
    totalSeconds: row.total_seconds, worklog: jsonOrDefault(row.worklog, null),
  };
}

function redemptionRowToObj(row) {
  return {
    id: row.id, familyId: row.family_id, shopItemId: row.shop_item_id, userId: row.user_id,
    costs: jsonOrDefault(row.costs, {}), purchasedAt: row.purchased_at,
    fulfilled: !!row.fulfilled, fulfilledAt: row.fulfilled_at,
  };
}

function jobClaimRowToObj(row) {
  return {
    id: row.id, familyId: row.family_id, taskId: row.task_id, userId: row.user_id,
    status: row.status, acceptedAt: row.accepted_at,
  };
}

function worklogRowToObj(row) {
  return {
    id: row.id, familyId: row.family_id, taskId: row.task_id, userId: row.user_id,
    clockIn: row.clock_in, clockOut: row.clock_out,
  };
}

function balanceAdjustmentRowToObj(row) {
  return {
    id: row.id, familyId: row.family_id, userId: row.user_id,
    currencyId: row.currency_id, delta: row.delta, note: row.note,
    createdAt: row.created_at,
  };
}

// --- Server-side reward computation ------------------------------------------

function dateKeyServer(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function weekKeyServer(iso) {
  const d = new Date(iso);
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const jan1 = new Date(local.getFullYear(), 0, 1);
  const week = Math.ceil(((local - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${local.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function prevKeyServer(key, unit) {
  if (unit === "day") {
    const [y, m, d] = key.split("-").map(Number);
    const prev = new Date(y, m - 1, d - 1);
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
  }
  const parts = key.split("-W");
  let year = parseInt(parts[0]);
  let week = parseInt(parts[1]) - 1;
  if (week < 1) { year--; week = 52; }
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function calcStreakServer(familyId, taskId, userId) {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND family_id = ?").get(taskId, familyId);
  if (!task) return 0;
  if (task.recurrence === "transient") return 0;

  const completions = db.prepare(
    "SELECT completed_at FROM completions WHERE family_id = ? AND task_id = ? AND user_id = ? AND status = 'approved' ORDER BY completed_at DESC"
  ).all(familyId, taskId, userId);

  if (completions.length === 0) return 0;

  const isWeekly = task.recurrence === "weekly";
  const keyFn = isWeekly ? weekKeyServer : dateKeyServer;
  const keys = [...new Set(completions.map((c) => keyFn(c.completed_at)))].sort().reverse();

  const todayKey = keyFn(new Date().toISOString());
  let streak = 0;
  let expected = todayKey;
  const activeDays = jsonOrDefault(task.active_days, []);
  const hasActiveDays = activeDays.length > 0;
  const isDaily = !isWeekly;

  if (isDaily && hasActiveDays) {
    let skipped = 0;
    while (skipped < 6) {
      const [ey, em, ed] = expected.split("-").map(Number);
      const dow = new Date(ey, em - 1, ed).getDay();
      if (activeDays.includes(dow)) break;
      expected = prevKeyServer(expected, "day");
      skipped++;
    }
  }

  for (const k of keys) {
    if (k === expected) {
      streak++;
      expected = prevKeyServer(expected, isDaily ? "day" : "week");
      if (isDaily && hasActiveDays) {
        let skipped = 0;
        while (skipped < 6) {
          const [ey, em, ed] = expected.split("-").map(Number);
          const dow = new Date(ey, em - 1, ed).getDay();
          if (activeDays.includes(dow)) break;
          expected = prevKeyServer(expected, "day");
          skipped++;
        }
      }
    } else if (k < expected) {
      break;
    }
  }

  return streak;
}

function computeRewards(task, streakMultiplier, timerMultiplier) {
  const rewards = {};
  const taskRewards = jsonOrDefault(task.rewards, {});
  for (const [currId, baseAmount] of Object.entries(taskRewards)) {
    const curr = db.prepare("SELECT decimals FROM currencies WHERE id = ?").get(currId);
    const decimals = curr ? (curr.decimals || 0) : 0;
    const factor = Math.pow(10, decimals);
    rewards[currId] = Math.round(baseAmount * streakMultiplier * timerMultiplier * factor) / factor;
  }
  return rewards;
}

// Incrementally update cached balance
function adjustCachedBalance(familyId, userId, currencyId, delta) {
  db.prepare(`INSERT INTO user_balances (user_id, family_id, currency_id, balance)
    VALUES (?, ?, ?, ?) ON CONFLICT(user_id, currency_id) DO UPDATE SET balance = balance + ?`
  ).run(userId, familyId, currencyId, delta, delta);
}

function creditRewardsServer(familyId, userId, rewards) {
  for (const [currId, amount] of Object.entries(rewards)) {
    adjustCachedBalance(familyId, userId, currId, amount);
  }
}

// --- Typed API: GET /api/state — full snapshot --------------------------------

app.get("/api/state", requireFamilyAuth, (req, res) => {
  const fid = req.familyId;
  const users = db.prepare("SELECT * FROM users WHERE family_id = ?").all(fid).map(userRowToObj);
  const tasks = db.prepare("SELECT * FROM tasks WHERE family_id = ?").all(fid).map(taskRowToObj);
  const currencies = db.prepare("SELECT * FROM currencies WHERE family_id = ?").all(fid).map(currencyRowToObj);
  const completions = db.prepare("SELECT * FROM completions WHERE family_id = ?").all(fid).map(completionRowToObj);
  const shopItems = db.prepare("SELECT * FROM shop_items WHERE family_id = ?").all(fid).map(shopItemRowToObj);
  const redemptions = db.prepare("SELECT * FROM redemptions WHERE family_id = ?").all(fid).map(redemptionRowToObj);
  const jobClaims = db.prepare("SELECT * FROM job_claims WHERE family_id = ?").all(fid).map(jobClaimRowToObj);
  const worklog = db.prepare("SELECT * FROM worklog_entries WHERE family_id = ?").all(fid).map(worklogRowToObj);
  const balanceAdjustments = db.prepare("SELECT * FROM balance_adjustments WHERE family_id = ?").all(fid).map(balanceAdjustmentRowToObj);

  // Build balances map: { userId: { currencyId: amount } }
  const balanceRows = db.prepare("SELECT * FROM user_balances WHERE family_id = ?").all(fid);
  const balances = {};
  for (const b of balanceRows) {
    if (!balances[b.user_id]) balances[b.user_id] = {};
    balances[b.user_id][b.currency_id] = b.balance;
  }

  // Attach balances to users (backward compat with old client shape)
  for (const u of users) {
    u.balances = balances[u.id] || {};
  }

  res.json({ users, tasks, currencies, completions, shopItems, redemptions, jobClaims, worklog, balances, balanceAdjustments });
});

// --- Typed API: Config CRUD --------------------------------------------------

// Tasks
app.get("/api/tasks", requireFamilyAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM tasks WHERE family_id = ?").all(req.familyId);
  res.json(rows.map(taskRowToObj));
});

app.post("/api/tasks", requireFamilyAuth, requireAdmin, (req, res) => {
  const t = req.body;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tasks (id, family_id, name, description, recurrence, available, category, pay_type, rewards, streak_bonus, timer_bonus, bonus_criteria, assigned_users, required_tags, active_days, multi_user, max_payout, is_penalty, requires_approval, last_activated_at, archived, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.familyId, t.name || '', t.description || '', t.recurrence || 'daily',
    (t.available ?? (t.recurrence === 'transient' ? false : true)) ? 1 : 0,
    t.category || (t.recurrence === 'transient' ? 'jobboard' : 'routine'), t.payType || 'fixed',
    JSON.stringify(t.rewards || {}), t.streakBonus ? JSON.stringify(t.streakBonus) : null,
    t.timerBonus ? JSON.stringify(t.timerBonus) : null, t.bonusCriteria ? JSON.stringify(t.bonusCriteria) : null,
    JSON.stringify(t.assignedUsers || []), JSON.stringify(t.requiredTags || []),
    JSON.stringify(t.activeDays || []), (t.multiUser ?? true) ? 1 : 0,
    t.maxPayout ? JSON.stringify(t.maxPayout) : null, t.isPenalty ? 1 : 0,
    t.requiresApproval ? 1 : 0, t.lastActivatedAt || null, 0, now);

  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  const obj = taskRowToObj(row);
  broadcastSSE(req.familyId, "task:created", obj);
  res.json(obj);
});

app.put("/api/tasks/:id", requireFamilyAuth, requireAdmin, (req, res) => {
  const t = req.body;
  const existing = db.prepare("SELECT * FROM tasks WHERE id = ? AND family_id = ?").get(req.params.id, req.familyId);
  if (!existing) return res.status(404).json({ error: "not found" });

  db.prepare(`UPDATE tasks SET name = ?, description = ?, recurrence = ?, available = ?, category = ?, pay_type = ?, rewards = ?, streak_bonus = ?, timer_bonus = ?, bonus_criteria = ?, assigned_users = ?, required_tags = ?, active_days = ?, multi_user = ?, max_payout = ?, is_penalty = ?, requires_approval = ?, last_activated_at = ?, archived = ? WHERE id = ? AND family_id = ?`
  ).run(t.name ?? existing.name, t.description ?? existing.description, t.recurrence ?? existing.recurrence,
    (t.available !== undefined ? t.available : existing.available) ? 1 : 0,
    t.category ?? existing.category, t.payType ?? existing.pay_type,
    t.rewards !== undefined ? JSON.stringify(t.rewards) : existing.rewards,
    t.streakBonus !== undefined ? (t.streakBonus ? JSON.stringify(t.streakBonus) : null) : existing.streak_bonus,
    t.timerBonus !== undefined ? (t.timerBonus ? JSON.stringify(t.timerBonus) : null) : existing.timer_bonus,
    t.bonusCriteria !== undefined ? (t.bonusCriteria ? JSON.stringify(t.bonusCriteria) : null) : existing.bonus_criteria,
    t.assignedUsers !== undefined ? JSON.stringify(t.assignedUsers) : existing.assigned_users,
    t.requiredTags !== undefined ? JSON.stringify(t.requiredTags) : existing.required_tags,
    t.activeDays !== undefined ? JSON.stringify(t.activeDays) : existing.active_days,
    (t.multiUser !== undefined ? t.multiUser : existing.multi_user) ? 1 : 0,
    t.maxPayout !== undefined ? (t.maxPayout ? JSON.stringify(t.maxPayout) : null) : existing.max_payout,
    (t.isPenalty !== undefined ? t.isPenalty : existing.is_penalty) ? 1 : 0,
    (t.requiresApproval !== undefined ? t.requiresApproval : existing.requires_approval) ? 1 : 0,
    t.lastActivatedAt !== undefined ? t.lastActivatedAt : existing.last_activated_at,
    (t.archived !== undefined ? t.archived : existing.archived) ? 1 : 0,
    req.params.id, req.familyId);

  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  const obj = taskRowToObj(row);
  broadcastSSE(req.familyId, "task:updated", obj);
  res.json(obj);
});

app.delete("/api/tasks/:id", requireFamilyAuth, requireAdmin, (req, res) => {
  const result = db.prepare("UPDATE tasks SET archived = 1 WHERE id = ? AND family_id = ?").run(req.params.id, req.familyId);
  if (result.changes === 0) return res.status(404).json({ error: "not found" });
  broadcastSSE(req.familyId, "task:updated", { id: req.params.id, archived: true });
  res.json({ ok: true });
});

// Users
app.get("/api/users", requireFamilyAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM users WHERE family_id = ?").all(req.familyId);
  const users = rows.map(userRowToObj);
  // Attach balances
  const balanceRows = db.prepare("SELECT * FROM user_balances WHERE family_id = ?").all(req.familyId);
  const balances = {};
  for (const b of balanceRows) {
    if (!balances[b.user_id]) balances[b.user_id] = {};
    balances[b.user_id][b.currency_id] = b.balance;
  }
  for (const u of users) u.balances = balances[u.id] || {};
  res.json(users);
});

app.post("/api/users", requireFamilyAuth, requireAdmin, (req, res) => {
  const u = req.body;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id, family_id, name, role, avatar, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, req.familyId, u.name || '', u.role || 'kid', u.avatar || '', JSON.stringify(u.tags || []), now);
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  const obj = userRowToObj(row);
  obj.balances = {};
  broadcastSSE(req.familyId, "user:created", obj);
  res.json(obj);
});

app.put("/api/users/:id", requireFamilyAuth, (req, res) => {
  const u = req.body;
  const existing = db.prepare("SELECT * FROM users WHERE id = ? AND family_id = ?").get(req.params.id, req.familyId);
  if (!existing) return res.status(404).json({ error: "not found" });
  db.prepare("UPDATE users SET name = ?, role = ?, avatar = ?, tags = ? WHERE id = ? AND family_id = ?")
    .run(u.name ?? existing.name, u.role ?? existing.role, u.avatar ?? existing.avatar,
      u.tags !== undefined ? JSON.stringify(u.tags) : existing.tags, req.params.id, req.familyId);
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  const obj = userRowToObj(row);
  broadcastSSE(req.familyId, "user:updated", obj);
  res.json(obj);
});

app.delete("/api/users/:id", requireFamilyAuth, requireAdmin, (req, res) => {
  const result = db.prepare("DELETE FROM users WHERE id = ? AND family_id = ?").run(req.params.id, req.familyId);
  if (result.changes === 0) return res.status(404).json({ error: "not found" });
  broadcastSSE(req.familyId, "user:deleted", { id: req.params.id });
  res.json({ ok: true });
});

// Currencies
app.get("/api/currencies", requireFamilyAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM currencies WHERE family_id = ?").all(req.familyId).map(currencyRowToObj));
});

app.post("/api/currencies", requireFamilyAuth, requireAdmin, (req, res) => {
  const c = req.body;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO currencies (id, family_id, name, symbol, decimals, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, req.familyId, c.name || '', c.symbol || '', c.decimals ?? 0, c.color || '#66d9ef', now);
  const row = db.prepare("SELECT * FROM currencies WHERE id = ?").get(id);
  const obj = currencyRowToObj(row);
  broadcastSSE(req.familyId, "currency:created", obj);
  res.json(obj);
});

app.put("/api/currencies/:id", requireFamilyAuth, requireAdmin, (req, res) => {
  const c = req.body;
  const existing = db.prepare("SELECT * FROM currencies WHERE id = ? AND family_id = ?").get(req.params.id, req.familyId);
  if (!existing) return res.status(404).json({ error: "not found" });
  db.prepare("UPDATE currencies SET name = ?, symbol = ?, decimals = ?, color = ? WHERE id = ? AND family_id = ?")
    .run(c.name ?? existing.name, c.symbol ?? existing.symbol, c.decimals ?? existing.decimals,
      c.color ?? existing.color, req.params.id, req.familyId);
  const row = db.prepare("SELECT * FROM currencies WHERE id = ?").get(req.params.id);
  const obj = currencyRowToObj(row);
  broadcastSSE(req.familyId, "currency:updated", obj);
  res.json(obj);
});

app.delete("/api/currencies/:id", requireFamilyAuth, requireAdmin, (req, res) => {
  const result = db.prepare("DELETE FROM currencies WHERE id = ? AND family_id = ?").run(req.params.id, req.familyId);
  if (result.changes === 0) return res.status(404).json({ error: "not found" });
  broadcastSSE(req.familyId, "currency:deleted", { id: req.params.id });
  res.json({ ok: true });
});

// Shop items
app.get("/api/shop-items", requireFamilyAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM shop_items WHERE family_id = ?").all(req.familyId).map(shopItemRowToObj));
});

app.post("/api/shop-items", requireFamilyAuth, requireAdmin, (req, res) => {
  const s = req.body;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO shop_items (id, family_id, name, description, costs, archived, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .run(id, req.familyId, s.name || '', s.description || '', JSON.stringify(s.costs || {}), now);
  const row = db.prepare("SELECT * FROM shop_items WHERE id = ?").get(id);
  const obj = shopItemRowToObj(row);
  broadcastSSE(req.familyId, "shop:created", obj);
  res.json(obj);
});

app.put("/api/shop-items/:id", requireFamilyAuth, requireAdmin, (req, res) => {
  const s = req.body;
  const existing = db.prepare("SELECT * FROM shop_items WHERE id = ? AND family_id = ?").get(req.params.id, req.familyId);
  if (!existing) return res.status(404).json({ error: "not found" });
  db.prepare("UPDATE shop_items SET name = ?, description = ?, costs = ?, archived = ? WHERE id = ? AND family_id = ?")
    .run(s.name ?? existing.name, s.description ?? existing.description,
      s.costs !== undefined ? JSON.stringify(s.costs) : existing.costs,
      (s.archived !== undefined ? s.archived : existing.archived) ? 1 : 0,
      req.params.id, req.familyId);
  const row = db.prepare("SELECT * FROM shop_items WHERE id = ?").get(req.params.id);
  const obj = shopItemRowToObj(row);
  broadcastSSE(req.familyId, "shop:updated", obj);
  res.json(obj);
});

app.delete("/api/shop-items/:id", requireFamilyAuth, requireAdmin, (req, res) => {
  const result = db.prepare("UPDATE shop_items SET archived = 1 WHERE id = ? AND family_id = ?").run(req.params.id, req.familyId);
  if (result.changes === 0) return res.status(404).json({ error: "not found" });
  broadcastSSE(req.familyId, "shop:updated", { id: req.params.id, archived: true });
  res.json({ ok: true });
});

// --- Typed API: Balances -----------------------------------------------------

app.get("/api/users/:id/balances", requireFamilyAuth, (req, res) => {
  const rows = db.prepare("SELECT currency_id, balance FROM user_balances WHERE user_id = ? AND family_id = ?")
    .all(req.params.id, req.familyId);
  const balances = {};
  for (const r of rows) balances[r.currency_id] = r.balance;
  res.json(balances);
});

// --- Typed API: Completions (events) -----------------------------------------

app.get("/api/completions", requireFamilyAuth, (req, res) => {
  let sql = "SELECT * FROM completions WHERE family_id = ?";
  const params = [req.familyId];
  if (req.query.since) { sql += " AND completed_at > ?"; params.push(req.query.since); }
  if (req.query.date) {
    sql += " AND completed_at >= ? AND completed_at < ?";
    params.push(req.query.date + "T00:00:00.000Z");
    params.push(req.query.date + "T23:59:59.999Z");
  }
  if (req.query.userId) { sql += " AND user_id = ?"; params.push(req.query.userId); }
  if (req.query.taskId) { sql += " AND task_id = ?"; params.push(req.query.taskId); }
  sql += " ORDER BY completed_at DESC";
  if (req.query.limit) { sql += " LIMIT ?"; params.push(parseInt(req.query.limit, 10)); }
  res.json(db.prepare(sql).all(...params).map(completionRowToObj));
});

// POST /api/completions — kid completes a task; server computes rewards
app.post("/api/completions", requireFamilyAuth, (req, res) => {
  const { taskId, userId, timerSeconds, _clientId } = req.body;
  if (!taskId || !userId) return res.status(400).json({ error: "taskId and userId required" });

  // Idempotency: if _clientId was provided and already exists, return existing row
  if (_clientId) {
    const existing = db.prepare("SELECT * FROM completions WHERE _client_id = ? AND family_id = ?").get(_clientId, req.familyId);
    if (existing) return res.json(completionRowToObj(existing));
  }

  const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND family_id = ?").get(taskId, req.familyId);
  if (!task) return res.status(404).json({ error: "task not found" });

  const streak = calcStreakServer(req.familyId, taskId, userId);
  const newStreak = streak + 1;

  let streakMultiplier = 1;
  const streakBonus = jsonOrDefault(task.streak_bonus, null);
  if (streakBonus && newStreak >= streakBonus.threshold) {
    streakMultiplier = streakBonus.multiplier || 1;
  }

  let timerMultiplier = 1;
  const timerBonus = jsonOrDefault(task.timer_bonus, null);
  if (timerBonus && timerSeconds != null) {
    const mode = timerBonus.mode || "under";
    const hit = mode === "over" ? timerSeconds >= timerBonus.targetSeconds : timerSeconds <= timerBonus.targetSeconds;
    if (hit) timerMultiplier = timerBonus.multiplier || 1;
  }

  const rewards = computeRewards(task, streakMultiplier, timerMultiplier);
  const status = task.requires_approval ? "pending" : "approved";
  const id = crypto.randomUUID();
  const completedAt = new Date().toISOString();

  db.prepare(`INSERT INTO completions (id, family_id, task_id, user_id, status, completed_at, rewards, timer_seconds, streak_count, streak_multiplier, timer_multiplier, note, is_penalty, is_hourly, total_seconds, worklog, _client_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, NULL, NULL, ?)`)
    .run(id, req.familyId, taskId, userId, status, completedAt, JSON.stringify(rewards), timerSeconds ?? null, newStreak, streakMultiplier, timerMultiplier, _clientId || null);

  if (status === "approved") {
    creditRewardsServer(req.familyId, userId, rewards);
  }

  const row = db.prepare("SELECT * FROM completions WHERE id = ?").get(id);
  const obj = completionRowToObj(row);
  broadcastSSE(req.familyId, "completion:added", obj);
  if (status === "approved") {
    broadcastSSE(req.familyId, "balances:changed", { userId });
  }
  res.json(obj);
});

// POST /api/completions/penalty — admin logs a penalty
app.post("/api/completions/penalty", requireFamilyAuth, requireAdmin, (req, res) => {
  const { taskId, userId, note } = req.body;
  if (!taskId || !userId) return res.status(400).json({ error: "taskId and userId required" });

  const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND family_id = ?").get(taskId, req.familyId);
  if (!task || !task.is_penalty) return res.status(400).json({ error: "not a penalty task" });

  const rewards = jsonOrDefault(task.rewards, {});
  const id = crypto.randomUUID();
  const completedAt = new Date().toISOString();

  db.prepare(`INSERT INTO completions (id, family_id, task_id, user_id, status, completed_at, rewards, timer_seconds, streak_count, streak_multiplier, timer_multiplier, note, is_penalty)
    VALUES (?, ?, ?, ?, 'approved', ?, ?, NULL, 0, 1, 1, ?, 1)`)
    .run(id, req.familyId, taskId, userId, completedAt, JSON.stringify(rewards), note || '');

  creditRewardsServer(req.familyId, userId, rewards);

  const row = db.prepare("SELECT * FROM completions WHERE id = ?").get(id);
  const obj = completionRowToObj(row);
  broadcastSSE(req.familyId, "completion:added", obj);
  broadcastSSE(req.familyId, "balances:changed", { userId });
  res.json(obj);
});

// POST /api/completions/hourly — submit hourly work
app.post("/api/completions/hourly", requireFamilyAuth, (req, res) => {
  const { taskId, userId, _clientId } = req.body;
  if (!taskId || !userId) return res.status(400).json({ error: "taskId and userId required" });

  // Idempotency: if _clientId was provided and already exists, return existing row
  if (_clientId) {
    const existing = db.prepare("SELECT * FROM completions WHERE _client_id = ? AND family_id = ?").get(_clientId, req.familyId);
    if (existing) return res.json(completionRowToObj(existing));
  }

  const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND family_id = ?").get(taskId, req.familyId);
  if (!task) return res.status(404).json({ error: "task not found" });

  // Clock out if still clocked in
  const openEntry = db.prepare("SELECT id FROM worklog_entries WHERE family_id = ? AND task_id = ? AND user_id = ? AND clock_out IS NULL").get(req.familyId, taskId, userId);
  if (openEntry) {
    db.prepare("UPDATE worklog_entries SET clock_out = ? WHERE id = ?").run(new Date().toISOString(), openEntry.id);
  }

  // Sum total seconds
  const entries = db.prepare("SELECT clock_in, clock_out FROM worklog_entries WHERE family_id = ? AND task_id = ? AND user_id = ? AND clock_out IS NOT NULL").all(req.familyId, taskId, userId);
  let totalSecs = 0;
  const worklog = [];
  for (const e of entries) {
    const secs = Math.round((new Date(e.clock_out) - new Date(e.clock_in)) / 1000);
    totalSecs += secs;
    worklog.push({ clockIn: e.clock_in, clockOut: e.clock_out, seconds: secs });
  }
  const totalHours = totalSecs / 3600;

  // Compute rewards: rate * hours, capped by maxPayout
  const taskRewards = jsonOrDefault(task.rewards, {});
  const maxPayout = jsonOrDefault(task.max_payout, null);
  const rewards = {};
  for (const [currId, rate] of Object.entries(taskRewards)) {
    const curr = db.prepare("SELECT decimals FROM currencies WHERE id = ?").get(currId);
    const decimals = curr ? (curr.decimals || 0) : 0;
    const factor = Math.pow(10, decimals);
    let amount = Math.round(rate * totalHours * factor) / factor;
    if (maxPayout && maxPayout[currId] != null) amount = Math.min(amount, maxPayout[currId]);
    rewards[currId] = amount;
  }

  const id = crypto.randomUUID();
  const completedAt = new Date().toISOString();

  db.prepare(`INSERT INTO completions (id, family_id, task_id, user_id, status, completed_at, rewards, streak_count, streak_multiplier, timer_multiplier, note, is_hourly, total_seconds, worklog, _client_id)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, 1, 1, '', 1, ?, ?, ?)`)
    .run(id, req.familyId, taskId, userId, completedAt, JSON.stringify(rewards), totalSecs, JSON.stringify(worklog), _clientId || null);

  // Mark job claim as submitted
  db.prepare("UPDATE job_claims SET status = 'submitted' WHERE family_id = ? AND task_id = ? AND user_id = ?")
    .run(req.familyId, taskId, userId);

  // Clear worklog entries for this task+user
  db.prepare("DELETE FROM worklog_entries WHERE family_id = ? AND task_id = ? AND user_id = ?")
    .run(req.familyId, taskId, userId);

  const row = db.prepare("SELECT * FROM completions WHERE id = ?").get(id);
  const obj = completionRowToObj(row);
  broadcastSSE(req.familyId, "completion:added", obj);
  broadcastSSE(req.familyId, "jobclaims:changed", {});
  res.json(obj);
});

// PATCH /api/completions/:id/approve
app.patch("/api/completions/:id/approve", requireFamilyAuth, requireAdmin, (req, res) => {
  const c = db.prepare("SELECT * FROM completions WHERE id = ? AND family_id = ?").get(req.params.id, req.familyId);
  if (!c) return res.status(404).json({ error: "not found" });
  if (c.status !== "pending") return res.status(400).json({ error: "not pending" });

  const checkedCriteria = req.body.criteria || [];
  let rewards = jsonOrDefault(c.rewards, {});
  let criteriaMultiplier = 1;

  if (checkedCriteria.length > 0) {
    const task = db.prepare("SELECT bonus_criteria FROM tasks WHERE id = ? AND family_id = ?").get(c.task_id, req.familyId);
    const bonusCriteria = jsonOrDefault(task?.bonus_criteria, []);
    for (const criterion of bonusCriteria) {
      if (checkedCriteria.includes(criterion.id)) criteriaMultiplier *= criterion.multiplier;
    }
    if (criteriaMultiplier !== 1) {
      for (const [currId, baseAmount] of Object.entries(rewards)) {
        const curr = db.prepare("SELECT decimals FROM currencies WHERE id = ?").get(currId);
        const decimals = curr ? (curr.decimals || 0) : 0;
        const factor = Math.pow(10, decimals);
        rewards[currId] = Math.round(baseAmount * criteriaMultiplier * factor) / factor;
      }
    }
  }

  const approvedAt = new Date().toISOString();
  db.prepare(`UPDATE completions SET status = 'approved', approved_at = ?, rewards = ?, bonus_criteria_checked = ?, bonus_criteria_multiplier = ? WHERE id = ?`)
    .run(approvedAt, JSON.stringify(rewards), checkedCriteria.length > 0 ? JSON.stringify(checkedCriteria) : null, criteriaMultiplier !== 1 ? criteriaMultiplier : null, req.params.id);

  creditRewardsServer(req.familyId, c.user_id, rewards);

  const row = db.prepare("SELECT * FROM completions WHERE id = ?").get(req.params.id);
  const obj = completionRowToObj(row);
  broadcastSSE(req.familyId, "completion:approved", obj);
  broadcastSSE(req.familyId, "balances:changed", { userId: c.user_id });
  res.json(obj);
});

// PATCH /api/completions/:id/reject
app.patch("/api/completions/:id/reject", requireFamilyAuth, requireAdmin, (req, res) => {
  const c = db.prepare("SELECT * FROM completions WHERE id = ? AND family_id = ?").get(req.params.id, req.familyId);
  if (!c) return res.status(404).json({ error: "not found" });
  if (c.status !== "pending") return res.status(400).json({ error: "not pending" });

  const rejectedAt = new Date().toISOString();
  db.prepare("UPDATE completions SET status = 'rejected', rejected_at = ?, rejection_note = ? WHERE id = ?")
    .run(rejectedAt, req.body.note || null, req.params.id);

  const row = db.prepare("SELECT * FROM completions WHERE id = ?").get(req.params.id);
  const obj = completionRowToObj(row);
  broadcastSSE(req.familyId, "completion:rejected", obj);
  res.json(obj);
});

// DELETE /api/completions/reset-daily — admin: reset a user's daily completions for today
app.delete("/api/completions/reset-daily", requireFamilyAuth, requireAdmin, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const today = dateKeyServer(new Date().toISOString());
  const todayStart = today + "T00:00:00.000Z";
  const todayEnd = today + "T23:59:59.999Z";

  // Find today's daily task completions for this user
  const dailyTaskIds = db.prepare("SELECT id FROM tasks WHERE family_id = ? AND recurrence = 'daily' AND archived = 0 AND is_penalty = 0").all(req.familyId).map(r => r.id);
  if (dailyTaskIds.length === 0) return res.json({ ok: true, removed: 0 });

  const placeholders = dailyTaskIds.map(() => "?").join(",");
  const toRemove = db.prepare(`SELECT id, user_id, status, rewards FROM completions WHERE family_id = ? AND user_id = ? AND task_id IN (${placeholders}) AND completed_at >= ? AND completed_at <= ?`)
    .all(req.familyId, userId, ...dailyTaskIds, todayStart, todayEnd);

  // Reverse rewards for approved completions
  for (const c of toRemove) {
    if (c.status === "approved") {
      const rewards = jsonOrDefault(c.rewards, {});
      for (const [currId, amount] of Object.entries(rewards)) {
        adjustCachedBalance(req.familyId, userId, currId, -amount);
      }
    }
    db.prepare("DELETE FROM completions WHERE id = ?").run(c.id);
  }

  if (toRemove.length > 0) {
    broadcastSSE(req.familyId, "completions:reset", { userId });
    broadcastSSE(req.familyId, "balances:changed", { userId });
  }
  res.json({ ok: true, removed: toRemove.length });
});

// --- Typed API: Redemptions --------------------------------------------------

app.get("/api/redemptions", requireFamilyAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM redemptions WHERE family_id = ?").all(req.familyId).map(redemptionRowToObj));
});

app.post("/api/redemptions", requireFamilyAuth, (req, res) => {
  const { shopItemId, userId, _clientId } = req.body;
  if (!shopItemId || !userId) return res.status(400).json({ error: "shopItemId and userId required" });

  // Idempotency: if _clientId was provided and already exists, return existing row
  if (_clientId) {
    const existing = db.prepare("SELECT * FROM redemptions WHERE _client_id = ? AND family_id = ?").get(_clientId, req.familyId);
    if (existing) return res.json({ ok: true, redemption: redemptionRowToObj(existing) });
  }

  const item = db.prepare("SELECT * FROM shop_items WHERE id = ? AND family_id = ?").get(shopItemId, req.familyId);
  if (!item) return res.status(404).json({ error: "item not found" });

  const costs = jsonOrDefault(item.costs, {});

  // Check sufficient balance
  for (const [currId, cost] of Object.entries(costs)) {
    const bal = db.prepare("SELECT balance FROM user_balances WHERE user_id = ? AND currency_id = ?").get(userId, currId);
    if (!bal || bal.balance < cost) {
      const curr = db.prepare("SELECT name FROM currencies WHERE id = ?").get(currId);
      return res.status(400).json({ error: `Not enough ${curr?.name || currId}` });
    }
  }

  // Deduct balances
  for (const [currId, cost] of Object.entries(costs)) {
    adjustCachedBalance(req.familyId, userId, currId, -cost);
  }

  const id = crypto.randomUUID();
  const purchasedAt = new Date().toISOString();
  db.prepare("INSERT INTO redemptions (id, family_id, shop_item_id, user_id, costs, purchased_at, fulfilled, _client_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?)")
    .run(id, req.familyId, shopItemId, userId, JSON.stringify(costs), purchasedAt, _clientId || null);

  const row = db.prepare("SELECT * FROM redemptions WHERE id = ?").get(id);
  const obj = redemptionRowToObj(row);
  broadcastSSE(req.familyId, "redemption:added", obj);
  broadcastSSE(req.familyId, "balances:changed", { userId });
  res.json({ ok: true, redemption: obj });
});

app.patch("/api/redemptions/:id/fulfill", requireFamilyAuth, requireAdmin, (req, res) => {
  const r = db.prepare("SELECT * FROM redemptions WHERE id = ? AND family_id = ?").get(req.params.id, req.familyId);
  if (!r) return res.status(404).json({ error: "not found" });
  db.prepare("UPDATE redemptions SET fulfilled = 1, fulfilled_at = ? WHERE id = ?").run(new Date().toISOString(), req.params.id);
  const row = db.prepare("SELECT * FROM redemptions WHERE id = ?").get(req.params.id);
  const obj = redemptionRowToObj(row);
  broadcastSSE(req.familyId, "redemption:fulfilled", obj);
  res.json(obj);
});

// --- Typed API: Balance adjustments ------------------------------------------

app.post("/api/balance-adjustments", requireFamilyAuth, requireAdmin, (req, res) => {
  const { userId, currencyId, delta, note } = req.body;
  if (!userId || !currencyId || delta === undefined) return res.status(400).json({ error: "userId, currencyId, and delta required" });

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO balance_adjustments (id, family_id, user_id, currency_id, delta, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, req.familyId, userId, currencyId, delta, note || '', createdAt);

  adjustCachedBalance(req.familyId, userId, currencyId, delta);
  broadcastSSE(req.familyId, "balances:changed", { userId });
  res.json({ ok: true, id });
});

// --- Typed API: Job claims ---------------------------------------------------

app.get("/api/job-claims", requireFamilyAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM job_claims WHERE family_id = ?").all(req.familyId).map(jobClaimRowToObj));
});

app.post("/api/job-claims", requireFamilyAuth, (req, res) => {
  const { taskId, userId, _clientId } = req.body;
  if (!taskId || !userId) return res.status(400).json({ error: "taskId and userId required" });

  // Idempotency: if _clientId was provided and already exists, return existing row
  if (_clientId) {
    const byClientId = db.prepare("SELECT * FROM job_claims WHERE _client_id = ? AND family_id = ?").get(_clientId, req.familyId);
    if (byClientId) return res.json(jobClaimRowToObj(byClientId));
  }

  const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND family_id = ?").get(taskId, req.familyId);
  if (!task) return res.status(404).json({ error: "task not found" });

  // Check if already claimed
  const existing = db.prepare("SELECT * FROM job_claims WHERE family_id = ? AND task_id = ? AND user_id = ?").get(req.familyId, taskId, userId);
  if (existing) return res.json(jobClaimRowToObj(existing));

  // Check single-user constraint
  if (!task.multi_user) {
    const otherClaim = db.prepare("SELECT id FROM job_claims WHERE family_id = ? AND task_id = ? AND user_id != ?").get(req.familyId, taskId, userId);
    if (otherClaim) return res.status(409).json({ error: "already claimed by another user" });
  }

  const id = crypto.randomUUID();
  const acceptedAt = new Date().toISOString();
  db.prepare("INSERT INTO job_claims (id, family_id, task_id, user_id, status, accepted_at, _client_id) VALUES (?, ?, ?, ?, 'active', ?, ?)")
    .run(id, req.familyId, taskId, userId, acceptedAt, _clientId || null);

  const row = db.prepare("SELECT * FROM job_claims WHERE id = ?").get(id);
  const obj = jobClaimRowToObj(row);
  broadcastSSE(req.familyId, "jobclaims:changed", obj);
  res.json(obj);
});

app.patch("/api/job-claims/:id/submit", requireFamilyAuth, (req, res) => {
  const claim = db.prepare("SELECT * FROM job_claims WHERE id = ? AND family_id = ?").get(req.params.id, req.familyId);
  if (!claim) return res.status(404).json({ error: "not found" });

  db.prepare("UPDATE job_claims SET status = 'submitted' WHERE id = ?").run(req.params.id);
  const row = db.prepare("SELECT * FROM job_claims WHERE id = ?").get(req.params.id);
  const obj = jobClaimRowToObj(row);
  broadcastSSE(req.familyId, "jobclaims:changed", obj);
  res.json(obj);
});

// --- Typed API: Worklog ------------------------------------------------------

app.get("/api/worklog", requireFamilyAuth, (req, res) => {
  let sql = "SELECT * FROM worklog_entries WHERE family_id = ?";
  const params = [req.familyId];
  if (req.query.taskId) { sql += " AND task_id = ?"; params.push(req.query.taskId); }
  if (req.query.userId) { sql += " AND user_id = ?"; params.push(req.query.userId); }
  sql += " ORDER BY clock_in ASC";
  res.json(db.prepare(sql).all(...params).map(worklogRowToObj));
});

app.post("/api/worklog", requireFamilyAuth, (req, res) => {
  const { taskId, userId, _clientId } = req.body;
  if (!taskId || !userId) return res.status(400).json({ error: "taskId and userId required" });

  // Idempotency: if _clientId was provided and already exists, return existing row
  if (_clientId) {
    const byClientId = db.prepare("SELECT * FROM worklog_entries WHERE _client_id = ? AND family_id = ?").get(_clientId, req.familyId);
    if (byClientId) return res.json(worklogRowToObj(byClientId));
  }

  // Check if already clocked in
  const open = db.prepare("SELECT * FROM worklog_entries WHERE family_id = ? AND task_id = ? AND user_id = ? AND clock_out IS NULL").get(req.familyId, taskId, userId);
  if (open) return res.json(worklogRowToObj(open));

  const id = crypto.randomUUID();
  const clockIn = new Date().toISOString();
  db.prepare("INSERT INTO worklog_entries (id, family_id, task_id, user_id, clock_in, _client_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, req.familyId, taskId, userId, clockIn, _clientId || null);

  const row = db.prepare("SELECT * FROM worklog_entries WHERE id = ?").get(id);
  const obj = worklogRowToObj(row);
  broadcastSSE(req.familyId, "worklog:changed", obj);
  res.json(obj);
});

app.patch("/api/worklog/:id/clock-out", requireFamilyAuth, (req, res) => {
  const entry = db.prepare("SELECT * FROM worklog_entries WHERE id = ? AND family_id = ?").get(req.params.id, req.familyId);
  if (!entry) return res.status(404).json({ error: "not found" });
  if (entry.clock_out) return res.status(400).json({ error: "already clocked out" });

  const clockOut = new Date().toISOString();
  db.prepare("UPDATE worklog_entries SET clock_out = ? WHERE id = ?").run(clockOut, req.params.id);

  const row = db.prepare("SELECT * FROM worklog_entries WHERE id = ?").get(req.params.id);
  const obj = worklogRowToObj(row);
  broadcastSSE(req.familyId, "worklog:changed", obj);
  res.json(obj);
});

// --- Typed API: Recompute balances (admin repair tool) -----------------------

app.post("/api/recompute-balances", requireFamilyAuth, requireAdmin, (req, res) => {
  recomputeBalances(req.familyId);
  const balanceRows = db.prepare("SELECT * FROM user_balances WHERE family_id = ?").all(req.familyId);
  const balances = {};
  for (const b of balanceRows) {
    if (!balances[b.user_id]) balances[b.user_id] = {};
    balances[b.user_id][b.currency_id] = b.balance;
  }
  broadcastSSE(req.familyId, "balances:recomputed", balances);
  res.json({ ok: true, balances });
});

// --- Sync (cr-sqlite pod-to-pod) ---------------------------------------------

const SYNC_SECRET = process.env.SYNC_SECRET || null;
const SYNC_PEERS = (process.env.SYNC_PEERS || "").split(",").map(s => s.trim()).filter(Boolean);
const SYNC_INTERVAL_MS = (parseInt(process.env.SYNC_INTERVAL_MIN, 10) || 5) * 60 * 1000;

function requireSyncAuth(req, res, next) {
  if (!SYNC_SECRET) return res.status(503).json({ error: "sync not configured" });
  if (req.headers["x-sync-secret"] !== SYNC_SECRET) return res.status(401).json({ error: "invalid sync secret" });
  next();
}

// GET /api/sync/version — current db_version and site_id
app.get("/api/sync/version", requireSyncAuth, (req, res) => {
  const dbVersion = db.prepare("SELECT crsql_db_version()").pluck().get();
  const siteId = db.prepare("SELECT crsql_site_id()").pluck().get();
  res.json({ dbVersion, siteId: siteId.toString("hex") });
});

// GET /api/sync/changes?since=<db_version> — changes since a version
app.get("/api/sync/changes", requireSyncAuth, (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  const changes = db.prepare("SELECT * FROM crsql_changes WHERE db_version > ?").all(since);
  const dbVersion = db.prepare("SELECT crsql_db_version()").pluck().get();
  // Encode binary fields as hex for JSON transport
  const encoded = changes.map(c => ({
    ...c,
    pk: Buffer.isBuffer(c.pk) ? c.pk.toString("hex") : c.pk,
    site_id: Buffer.isBuffer(c.site_id) ? c.site_id.toString("hex") : c.site_id,
  }));
  res.json({ changes: encoded, currentVersion: dbVersion });
});

// POST /api/sync/changes — apply changes from a peer
app.post("/api/sync/changes", requireSyncAuth, (req, res) => {
  const { changes } = req.body;
  if (!Array.isArray(changes)) return res.status(400).json({ error: "changes must be an array" });
  const insert = db.prepare(
    "INSERT INTO crsql_changes (\"table\", pk, cid, val, col_version, db_version, site_id, cl, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const applyAll = db.transaction((rows) => {
    for (const c of rows) {
      insert.run(
        c.table,
        Buffer.from(c.pk, "hex"),
        c.cid,
        c.val,
        c.col_version,
        c.db_version,
        Buffer.from(c.site_id, "hex"),
        c.cl,
        c.seq
      );
    }
  });
  applyAll(changes);
  // Recompute derived balances for all families affected by synced data
  if (changes.some(c => ["completions", "redemptions", "balance_adjustments"].includes(c.table))) {
    const families = db.prepare("SELECT DISTINCT id FROM families").all();
    for (const f of families) recomputeBalances(f.id);
  }
  res.json({ ok: true, applied: changes.length });
});

// Background sync worker
async function syncWithPeer(peerUrl) {
  const headers = { "x-sync-secret": SYNC_SECRET, "Content-Type": "application/json" };
  const state = db.prepare("SELECT * FROM sync_state WHERE peer_url = ?").get(peerUrl) || {
    last_pushed_version: 0,
    last_pulled_version: 0,
  };

  // Pull: get changes from peer since our last pull
  const pullResp = await fetch(`${peerUrl}/api/sync/changes?since=${state.last_pulled_version}`, { headers });
  if (!pullResp.ok) throw new Error(`Pull failed: ${pullResp.status}`);
  const pullData = await pullResp.json();
  if (pullData.changes.length > 0) {
    const insert = db.prepare(
      "INSERT INTO crsql_changes (\"table\", pk, cid, val, col_version, db_version, site_id, cl, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const applyAll = db.transaction((rows) => {
      for (const c of rows) {
        insert.run(c.table, Buffer.from(c.pk, "hex"), c.cid, c.val, c.col_version, c.db_version, Buffer.from(c.site_id, "hex"), c.cl, c.seq);
      }
    });
    applyAll(pullData.changes);
    // Recompute derived balances if completions/redemptions/adjustments were synced
    if (pullData.changes.some(c => ["completions", "redemptions", "balance_adjustments"].includes(c.table))) {
      const families = db.prepare("SELECT DISTINCT id FROM families").all();
      for (const f of families) recomputeBalances(f.id);
    }
    console.log(`Sync: pulled ${pullData.changes.length} changes from ${peerUrl}`);
  }

  // Push: send our changes since peer's last known version
  const ourChanges = db.prepare("SELECT * FROM crsql_changes WHERE db_version > ?").all(state.last_pushed_version);
  if (ourChanges.length > 0) {
    const encoded = ourChanges.map(c => ({
      ...c,
      pk: Buffer.isBuffer(c.pk) ? c.pk.toString("hex") : c.pk,
      site_id: Buffer.isBuffer(c.site_id) ? c.site_id.toString("hex") : c.site_id,
    }));
    const pushResp = await fetch(`${peerUrl}/api/sync/changes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ changes: encoded }),
    });
    if (!pushResp.ok) throw new Error(`Push failed: ${pushResp.status}`);
    console.log(`Sync: pushed ${ourChanges.length} changes to ${peerUrl}`);
  }

  // Update sync state
  const ourVersion = db.prepare("SELECT crsql_db_version()").pluck().get();
  db.prepare(
    "INSERT INTO sync_state (peer_url, last_pushed_version, last_pulled_version, last_sync_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(peer_url) DO UPDATE SET last_pushed_version = excluded.last_pushed_version, last_pulled_version = excluded.last_pulled_version, last_sync_at = excluded.last_sync_at"
  ).run(peerUrl, ourVersion, pullData.currentVersion);
}

async function syncAllPeers() {
  for (const peer of SYNC_PEERS) {
    try {
      await syncWithPeer(peer);
    } catch (err) {
      console.error(`Sync error with ${peer}:`, err.message);
    }
  }
}

let syncInterval = null;
if (SYNC_PEERS.length > 0 && SYNC_SECRET) {
  // Initial sync after a short delay (let server finish starting)
  setTimeout(() => syncAllPeers(), 5000);
  syncInterval = setInterval(() => syncAllPeers(), SYNC_INTERVAL_MS);
  console.log(`Sync: will sync with ${SYNC_PEERS.join(", ")} every ${SYNC_INTERVAL_MS / 1000}s`);
}

// --- Backups (S3) ------------------------------------------------------------

const LOCAL_BACKUP_DIR = path.join(__dirname, "backups");
fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });

async function createBackup() {
  const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
  const filename = `parentslop-${timestamp}.db`;
  const localDest = path.join(LOCAL_BACKUP_DIR, filename);
  await db.backup(localDest);
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch (e) { console.warn("WAL checkpoint warning:", e.message); }

  // Upload to S3 if configured
  if (s3) {
    try {
      const body = fs.readFileSync(localDest);
      await s3.send(new PutObjectCommand({ Bucket: BACKUP_BUCKET, Key: `backups/${filename}`, Body: body }));
      console.log(`Backup uploaded to S3: ${filename}`);
    } catch (e) {
      console.error(`S3 upload failed: ${e.message} (local backup kept at ${localDest})`);
      return filename;
    }
  }

  // Clean up local file (S3 is the durable copy)
  try { fs.unlinkSync(localDest); } catch {}

  // Rotate S3 backups: keep last 30
  if (s3) {
    try {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: BACKUP_BUCKET, Prefix: "backups/parentslop-" }));
      const sorted = (list.Contents || []).sort((a, b) => b.LastModified - a.LastModified);
      for (const old of sorted.slice(30)) {
        await s3.send(new DeleteObjectCommand({ Bucket: BACKUP_BUCKET, Key: old.Key }));
        console.log(`S3 backup rotated: ${old.Key}`);
      }
    } catch (e) {
      console.warn("S3 rotation warning:", e.message);
    }
  }

  console.log(`Backup created: ${filename}`);
  return filename;
}

async function listBackups() {
  if (s3) {
    try {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: BACKUP_BUCKET, Prefix: "backups/parentslop-" }));
      return (list.Contents || [])
        .sort((a, b) => b.LastModified - a.LastModified)
        .map(o => ({ filename: o.Key.replace("backups/", ""), size: o.Size, created: o.LastModified.toISOString() }));
    } catch (e) {
      console.error("S3 list failed:", e.message);
    }
  }
  // Fallback to local
  if (!fs.existsSync(LOCAL_BACKUP_DIR)) return [];
  return fs.readdirSync(LOCAL_BACKUP_DIR)
    .filter(f => f.startsWith("parentslop-") && f.endsWith(".db"))
    .map(f => {
      const stat = fs.statSync(path.join(LOCAL_BACKUP_DIR, f));
      return { filename: f, size: stat.size, created: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.created.localeCompare(a.created));
}

// POST /api/backup — trigger a backup
app.post("/api/backup", requireFamilyAuth, requireAdmin, async (req, res) => {
  try {
    const filename = await createBackup();
    res.json({ ok: true, filename });
  } catch (err) {
    console.error("Backup failed:", err);
    res.status(500).json({ error: "backup failed" });
  }
});

// GET /api/backups — list existing backups
app.get("/api/backups", requireFamilyAuth, requireAdmin, async (req, res) => {
  res.json(await listBackups());
});

// Schedule backup every 6 hours
setInterval(() => {
  createBackup().catch(err => console.error("Scheduled backup failed:", err));
}, 6 * 60 * 60 * 1000);

// --- Data migration (existing data → default family) -------------------------

async function migrateExistingData() {
  const familyCount = db.prepare("SELECT COUNT(*) as count FROM families").get().count;
  const storeCount = db.prepare("SELECT COUNT(*) as count FROM stores").get().count;

  if (familyCount > 0 || storeCount === 0) return; // No migration needed

  console.log("ParentSlop: Migrating existing data to default family...");

  const familyId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Create default family with temporary password + needs_password_reset flag
  const tempPassword = crypto.randomBytes(16).toString("hex");
  const { hash, salt } = await hashPassword(tempPassword);
  db.prepare("INSERT INTO families (id, name, slug, password_hash, salt, auth_level, needs_password_reset, created_at) VALUES (?, ?, ?, ?, ?, 'none', 1, ?)").run(familyId, "My Family", "my-family", hash, salt, now);

  // Parse users from the store and create family_members
  const usersRow = db.prepare("SELECT value FROM stores WHERE key = 'parentslop.users.v1'").get();
  if (usersRow) {
    try {
      const users = JSON.parse(usersRow.value);
      if (Array.isArray(users)) {
        const insertMember = db.prepare("INSERT INTO family_members (id, family_id, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, ?)");
        for (const u of users) {
          insertMember.run(u.id, familyId, u.name || "User", u.isAdmin ? 1 : 0, u.createdAt || now);
        }
        console.log(`  Created ${users.length} family members`);
      }
    } catch (e) {
      console.warn("  Failed to parse users store:", e.message);
    }
  }

  // Re-key ALL store rows: prepend familyId
  const reKeyed = db.prepare("UPDATE stores SET key = ? || ':' || key WHERE key NOT LIKE '%:%'").run(familyId);
  console.log(`  Re-keyed ${reKeyed.changes} store rows`);

  console.log("ParentSlop: Migration complete. First admin login will prompt for password.");
  const credFile = path.join(__dirname, ".migration-credentials");
  fs.writeFileSync(credFile, `Family: My Family\nTemporary password: ${tempPassword}\nDelete this file after logging in.\n`, { mode: 0o600 });
  console.log(`  Temporary credentials written to ${credFile} (delete after use)`);
}

// --- Migrate store blobs → typed tables (one-time per family) ----------------

function migrateStoresToTables() {
  // Check if migration already happened (any rows in the new tables)
  const taskCount = db.prepare("SELECT COUNT(*) as c FROM tasks").get().c;
  if (taskCount > 0) return; // Already migrated

  const families = db.prepare("SELECT id FROM families").all();
  if (families.length === 0) return;

  let totalMigrated = 0;

  for (const { id: familyId } of families) {
    function getStoreData(key) {
      const nsKey = `${familyId}:${key}`;
      const row = db.prepare("SELECT value FROM stores WHERE key = ?").get(nsKey);
      if (!row) return null;
      try { return JSON.parse(row.value); } catch { return null; }
    }

    const blobUsers = getStoreData("parentslop.users.v1");
    const blobTasks = getStoreData("parentslop.tasks.v1");
    const blobCurrencies = getStoreData("parentslop.currencies.v1");
    const blobCompletions = getStoreData("parentslop.completions.v1");
    const blobShop = getStoreData("parentslop.shop.v1");
    const blobRedemptions = getStoreData("parentslop.redemptions.v1");
    const blobJobClaims = getStoreData("parentslop.jobclaims.v1");
    const blobWorklog = getStoreData("parentslop.worklog.v1");

    if (!blobUsers && !blobTasks) continue; // No data for this family

    console.log(`Migrating store blobs → tables for family ${familyId}...`);

    db.transaction(() => {
      // Users
      if (Array.isArray(blobUsers)) {
        const ins = db.prepare(`INSERT OR IGNORE INTO users (id, family_id, name, role, avatar, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const u of blobUsers) {
          ins.run(u.id, familyId, u.name || '', u.role || (u.isAdmin ? 'parent' : 'kid'), u.avatar || '', JSON.stringify(u.tags || []), u.createdAt || new Date().toISOString());
        }
        totalMigrated += blobUsers.length;
      }

      // Tasks
      if (Array.isArray(blobTasks)) {
        const ins = db.prepare(`INSERT OR IGNORE INTO tasks (id, family_id, name, description, recurrence, available, category, pay_type, rewards, streak_bonus, timer_bonus, bonus_criteria, assigned_users, required_tags, active_days, multi_user, max_payout, is_penalty, requires_approval, last_activated_at, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const t of blobTasks) {
          ins.run(t.id, familyId, t.name || '', t.description || '', t.recurrence || 'daily', t.available ? 1 : 0, t.category || 'routine', t.payType || 'fixed', JSON.stringify(t.rewards || {}), t.streakBonus ? JSON.stringify(t.streakBonus) : null, t.timerBonus ? JSON.stringify(t.timerBonus) : null, t.bonusCriteria ? JSON.stringify(t.bonusCriteria) : null, JSON.stringify(t.assignedUsers || []), JSON.stringify(t.requiredTags || []), JSON.stringify(t.activeDays || []), t.multiUser === false ? 0 : 1, t.maxPayout ? JSON.stringify(t.maxPayout) : null, t.isPenalty ? 1 : 0, t.requiresApproval ? 1 : 0, t.lastActivatedAt || null, t.archived ? 1 : 0, t.createdAt || new Date().toISOString());
        }
        totalMigrated += blobTasks.length;
      }

      // Currencies
      if (Array.isArray(blobCurrencies)) {
        const ins = db.prepare(`INSERT OR IGNORE INTO currencies (id, family_id, name, symbol, decimals, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const c of blobCurrencies) {
          ins.run(c.id, familyId, c.name || '', c.symbol || '', c.decimals || 0, c.color || '#66d9ef', c.createdAt || new Date().toISOString());
        }
        totalMigrated += blobCurrencies.length;
      }

      // Completions
      if (Array.isArray(blobCompletions)) {
        const ins = db.prepare(`INSERT OR IGNORE INTO completions (id, family_id, task_id, user_id, status, completed_at, approved_at, rejected_at, rejection_note, rewards, timer_seconds, streak_count, streak_multiplier, timer_multiplier, bonus_criteria_checked, bonus_criteria_multiplier, note, is_penalty, is_hourly, total_seconds, worklog) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const c of blobCompletions) {
          ins.run(c.id, familyId, c.taskId || '', c.userId || '', c.status || 'pending', c.completedAt || '', c.approvedAt || null, c.rejectedAt || null, c.rejectionNote || null, JSON.stringify(c.rewards || {}), c.timerSeconds ?? null, c.streakCount || 0, c.streakMultiplier || 1, c.timerMultiplier || 1, c.bonusCriteriaChecked ? JSON.stringify(c.bonusCriteriaChecked) : null, c.bonusCriteriaMultiplier || null, c.note || '', c.isPenalty ? 1 : 0, c.isHourly ? 1 : 0, c.totalSeconds ?? null, c.worklog ? JSON.stringify(c.worklog) : null);
        }
        totalMigrated += blobCompletions.length;
      }

      // Shop items
      if (Array.isArray(blobShop)) {
        const ins = db.prepare(`INSERT OR IGNORE INTO shop_items (id, family_id, name, description, costs, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const s of blobShop) {
          ins.run(s.id, familyId, s.name || '', s.description || '', JSON.stringify(s.costs || {}), s.archived ? 1 : 0, s.createdAt || new Date().toISOString());
        }
        totalMigrated += blobShop.length;
      }

      // Redemptions
      if (Array.isArray(blobRedemptions)) {
        const ins = db.prepare(`INSERT OR IGNORE INTO redemptions (id, family_id, shop_item_id, user_id, costs, purchased_at, fulfilled, fulfilled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const r of blobRedemptions) {
          // Look up costs from shop item
          const shopItem = (blobShop || []).find(s => s.id === r.shopItemId);
          const costs = shopItem?.costs || {};
          ins.run(r.id, familyId, r.shopItemId || '', r.userId || '', JSON.stringify(costs), r.purchasedAt || '', r.fulfilled ? 1 : 0, r.fulfilledAt || null);
        }
        totalMigrated += (blobRedemptions || []).length;
      }

      // Job claims
      if (Array.isArray(blobJobClaims)) {
        const ins = db.prepare(`INSERT OR IGNORE INTO job_claims (id, family_id, task_id, user_id, status, accepted_at) VALUES (?, ?, ?, ?, ?, ?)`);
        for (const j of blobJobClaims) {
          ins.run(j.id, familyId, j.taskId || '', j.userId || '', j.status || 'active', j.acceptedAt || new Date().toISOString());
        }
        totalMigrated += blobJobClaims.length;
      }

      // Worklog entries
      if (Array.isArray(blobWorklog)) {
        const ins = db.prepare(`INSERT OR IGNORE INTO worklog_entries (id, family_id, task_id, user_id, clock_in, clock_out) VALUES (?, ?, ?, ?, ?, ?)`);
        for (const w of blobWorklog) {
          ins.run(w.id, familyId, w.taskId || '', w.userId || '', w.clockIn || '', w.clockOut || null);
        }
        totalMigrated += blobWorklog.length;
      }

      // Compute user_balances from completions + redemptions + adjustments
      recomputeBalances(familyId);
    })();

    console.log(`  Family ${familyId}: migrated ${totalMigrated} rows`);
  }

  if (totalMigrated > 0) {
    console.log(`Store blob → table migration complete (${totalMigrated} total rows)`);
  }
}

// Recompute balances from event history for a family (used by migration + as repair tool)
function recomputeBalances(familyId) {
  db.prepare("DELETE FROM user_balances WHERE family_id = ?").run(familyId);

  // Credit approved completion rewards
  const completions = db.prepare("SELECT user_id, rewards FROM completions WHERE family_id = ? AND status = 'approved'").all(familyId);
  const balances = {}; // { `${userId}:${currencyId}`: amount }

  for (const c of completions) {
    let rewards;
    try { rewards = JSON.parse(c.rewards); } catch { continue; }
    for (const [currId, amount] of Object.entries(rewards)) {
      const key = `${c.user_id}:${currId}`;
      balances[key] = (balances[key] || 0) + amount;
    }
  }

  // Deduct redemption costs
  const redemptions = db.prepare("SELECT user_id, costs FROM redemptions WHERE family_id = ?").all(familyId);
  for (const r of redemptions) {
    let costs;
    try { costs = JSON.parse(r.costs); } catch { continue; }
    for (const [currId, cost] of Object.entries(costs)) {
      const key = `${r.user_id}:${currId}`;
      balances[key] = (balances[key] || 0) - cost;
    }
  }

  // Add balance adjustments
  const adjustments = db.prepare("SELECT user_id, currency_id, delta FROM balance_adjustments WHERE family_id = ?").all(familyId);
  for (const a of adjustments) {
    const key = `${a.user_id}:${a.currency_id}`;
    balances[key] = (balances[key] || 0) + a.delta;
  }

  // Insert into user_balances
  const ins = db.prepare("INSERT INTO user_balances (user_id, family_id, currency_id, balance) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, currency_id) DO UPDATE SET balance = excluded.balance");
  for (const [key, balance] of Object.entries(balances)) {
    const [userId, currencyId] = key.split(":");
    ins.run(userId, familyId, currencyId, balance);
  }
}

// --- Error handler (suppress stack traces) ------------------------------------

app.use((err, req, res, _next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid JSON" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "payload too large" });
  }
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "internal server error" });
});

// --- Start -------------------------------------------------------------------

ensureHealthyDb().then(() => {
  initDb();
  return migrateExistingData();
}).then(() => {
  migrateStoresToTables();
}).then(() => {
  // Recompute derived balances on startup (handles backup restores + missed recomputes)
  const families = db.prepare("SELECT DISTINCT id FROM families").all();
  for (const f of families) recomputeBalances(f.id);

  const server = app.listen(PORT, () => {
    const actualPort = server.address().port;
    console.log(`ParentSlop server running on http://localhost:${actualPort}`);
    // Run initial backup on startup
    createBackup().catch(err => console.error("Startup backup failed:", err));
  });

  function shutdown() {
    console.log("Shutting down...");
    if (syncInterval) clearInterval(syncInterval);
    try { db.exec("SELECT crsql_finalize()"); } catch (e) { /* ignore if already finalized */ }
    db.close();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}).catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
