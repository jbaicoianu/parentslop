const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

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

// --- Middleware ---------------------------------------------------------------

app.use(express.json({ limit: "5mb" }));
app.use(express.static(__dirname));

// --- Routes ------------------------------------------------------------------

// GET /api/store/:key — read a single store
app.get("/api/store/:key", (req, res) => {
  const row = db.prepare("SELECT key, value, updated_at FROM stores WHERE key = ?").get(req.params.key);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

// PUT /api/store/:key — upsert a single store
app.put("/api/store/:key", (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: "missing value" });
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO stores (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(req.params.key, typeof value === "string" ? value : JSON.stringify(value), now);
  res.json({ ok: true });
});

// POST /api/store/sync — bulk upsert
app.post("/api/store/sync", (req, res) => {
  const { stores } = req.body;
  if (!stores || typeof stores !== "object") return res.status(400).json({ error: "missing stores object" });
  const now = new Date().toISOString();
  const upsert = db.prepare(
    "INSERT INTO stores (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) {
      upsert.run(key, typeof value === "string" ? value : JSON.stringify(value), now);
    }
  });
  tx(Object.entries(stores));
  res.json({ ok: true, count: Object.keys(stores).length });
});

// --- Feedback ----------------------------------------------------------------

const crypto = require("crypto");

// POST /api/feedback — submit feedback
app.post("/api/feedback", (req, res) => {
  const { text, userId, userName, currentView, userAgent } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: "missing text" });
  const id = crypto.randomUUID().split("-")[0];
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO feedback (id, text, user_id, user_name, current_view, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, text.trim(), userId || null, userName || null, currentView || null, userAgent || null, createdAt);
  res.json({ ok: true, id });
});

// GET /api/feedback — list all feedback
app.get("/api/feedback", (req, res) => {
  const rows = db.prepare("SELECT * FROM feedback ORDER BY created_at DESC").all();
  res.json(rows);
});

// PATCH /api/feedback/:id — mark feedback completed/uncompleted with optional note
app.patch("/api/feedback/:id", (req, res) => {
  const { completed, note } = req.body;
  const completedAt = completed ? new Date().toISOString() : null;
  const resolutionNote = completed ? (note || null) : null;
  const result = db.prepare("UPDATE feedback SET completed_at = ?, resolution_note = ? WHERE id = ?").run(completedAt, resolutionNote, req.params.id);
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
app.post("/api/backup", async (req, res) => {
  try {
    const filename = await createBackup();
    res.json({ ok: true, filename });
  } catch (err) {
    console.error("Backup failed:", err);
    res.status(500).json({ error: "backup failed", message: err.message });
  }
});

// GET /api/backups — list existing backups
app.get("/api/backups", (req, res) => {
  res.json(listBackups());
});

// Schedule backup every 6 hours
setInterval(() => {
  createBackup().catch(err => console.error("Scheduled backup failed:", err));
}, 6 * 60 * 60 * 1000);

// --- Start -------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`ParentSlop server running on http://localhost:${PORT}`);
  // Run initial backup on startup
  createBackup().catch(err => console.error("Startup backup failed:", err));
});
