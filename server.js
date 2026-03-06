const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");

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

// --- Start -------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`ParentSlop server running on http://localhost:${PORT}`);
});
