const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 8080;

// --- SQLite setup ------------------------------------------------------------

const db = new Database(path.join(__dirname, "parentslop.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    family_id TEXT,
    text TEXT NOT NULL,
    user_id TEXT,
    user_name TEXT,
    current_view TEXT,
    user_agent TEXT,
    created_at TEXT,
    completed_at TEXT,
    resolution_note TEXT
  )
`);

// Migrate: add completed_at and resolution_note columns if missing (existing databases)
try {
  db.prepare("SELECT completed_at FROM feedback LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE feedback ADD COLUMN completed_at TEXT");
}
try {
  db.prepare("SELECT resolution_note FROM feedback LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE feedback ADD COLUMN resolution_note TEXT");
}
try {
  db.prepare("SELECT family_id FROM feedback LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE feedback ADD COLUMN family_id TEXT");
}

// --- Auth tables -------------------------------------------------------------

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

// --- Backups -----------------------------------------------------------------

const BACKUP_DIR = path.join(__dirname, "backups");
fs.mkdirSync(BACKUP_DIR, { recursive: true });

async function createBackup() {
  const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
  const filename = `parentslop-${timestamp}.db`;
  const dest = path.join(BACKUP_DIR, filename);
  await db.backup(dest);
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch (e) { console.warn("WAL checkpoint warning:", e.message); }
  rotateBackups();
  console.log(`Backup created: ${filename}`);
  return filename;
}

function rotateBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("parentslop-") && f.endsWith(".db"))
    .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
    .sort((a, b) => b.time - a.time); // newest first

  const now = new Date();
  const msPerDay = 86400000;
  const keep = new Set();

  // Keep all backups from the last 7 days
  for (const f of files) {
    if (now - f.time < 7 * msPerDay) keep.add(f.name);
  }

  // Keep the most recent backup from each of the prior 4 calendar weeks
  const weeksKept = new Set();
  for (const f of files) {
    if (keep.has(f.name)) continue;
    const age = now - f.time;
    if (age >= 7 * msPerDay && age < 35 * msPerDay) {
      // Get ISO week identifier
      const d = new Date(f.time);
      const jan1 = new Date(d.getFullYear(), 0, 1);
      const weekNum = Math.ceil(((d - jan1) / msPerDay + jan1.getDay() + 1) / 7);
      const weekKey = `${d.getFullYear()}-W${weekNum}`;
      if (!weeksKept.has(weekKey)) {
        weeksKept.add(weekKey);
        keep.add(f.name);
        if (weeksKept.size >= 4) break;
      }
    }
  }

  // Delete everything not in the keep set
  for (const f of files) {
    if (!keep.has(f.name)) {
      fs.unlinkSync(path.join(BACKUP_DIR, f.name));
      console.log(`Backup rotated out: ${f.name}`);
    }
  }
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("parentslop-") && f.endsWith(".db"))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
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
app.get("/api/backups", requireFamilyAuth, requireAdmin, (req, res) => {
  res.json(listBackups());
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

migrateExistingData().then(() => {
  app.listen(PORT, () => {
    console.log(`ParentSlop server running on http://localhost:${PORT}`);
    // Run initial backup on startup
    createBackup().catch(err => console.error("Startup backup failed:", err));
  });
}).catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
