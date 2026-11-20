/**
 * Screen time: each kid gets a daily allowance of computer time, enforced on the family computer(s) by
 * the agent in tools/screentime-agent (a root daemon plus a PAM login check).
 *
 * Data (all family tables, in the event log):
 *   screentime_settings     one row per person (id = users.id): on/off, weekday/weekend minutes, the
 *                           computer login name that maps to them, warning thresholds, grace minutes.
 *   screentime_usage        one row per (person, day, computer): seconds used. Computers report their own
 *                           running total for the day (not deltas), and the server keeps the larger value,
 *                           so reports are idempotent and a computer that was offline just catches up.
 *   screentime_adjustments  parent changes for one day (+30 min bonus, -15 min...).
 *   screentime_devices      computers allowed to report. They authenticate with a bearer token
 *                           (psd_<device id>.<secret>); only a hash of the secret is stored.
 *
 * Days are the computer's local date (it sends it). Saturday and Sunday use the weekend allowance.
 * remaining = allowance + adjustments - used (summed over all computers).
 *
 * Endpoints:
 *   GET    /api/screentime/state?date=     family session; kids see only themselves
 *   PUT    /api/screentime/members/:id     parent: settings
 *   POST   /api/screentime/members/:id/adjust  parent: { minutes, date, note }
 *   DELETE /api/screentime/adjustments/:id parent
 *   POST   /api/screentime/devices         parent: { name } -> token (shown once)
 *   DELETE /api/screentime/devices/:id     parent
 *   POST   /api/screentime/device/report   device token: { date, usage: {login: seconds}, active: [login], states: {login: state} }
 *   GET    /screentime-agent/<file>        the agent's install files (public, no secrets), so a computer can fetch them
 * Changes broadcast "screentime:changed" on the family SSE stream.
 */

const crypto = require("crypto");
const path = require("path");

const SCREENTIME_TABLES = ["screentime_settings", "screentime_usage", "screentime_adjustments", "screentime_devices"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Linux login names (what `loginctl` reports).
const LOGIN_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;
const DEFAULTS = { weekdayMinutes: 120, weekendMinutes: 180, warnMinutes: [15, 5, 1], graceMinutes: 2 };
const LIMITS = { minutes: 24 * 60, adjust: 12 * 60, note: 200, deviceName: 60, devices: 20, warnings: 6, grace: 30, logins: 50 };
const AGENT_STATES = new Set(["ok", "warning", "grace", "blocked", "offline"]);
// A computer counts as online if it reported within this long.
const ONLINE_MS = 3 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT_DIR = path.join(__dirname, "..", "tools", "screentime-agent");
const AGENT_FILES = new Set(["parentslop-screentime", "parentslop-screentime.service", "install.sh"]);

function initScreentimeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS screentime_settings (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      enabled INTEGER DEFAULT 0,
      weekday_minutes INTEGER DEFAULT ${DEFAULTS.weekdayMinutes},
      weekend_minutes INTEGER DEFAULT ${DEFAULTS.weekendMinutes},
      login_name TEXT DEFAULT '',
      warn_minutes TEXT DEFAULT '${DEFAULTS.warnMinutes.join(",")}',
      grace_minutes INTEGER DEFAULT ${DEFAULTS.graceMinutes},
      updated_at TEXT DEFAULT ''
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS screentime_usage (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      user_id TEXT DEFAULT '',
      date TEXT DEFAULT '',
      device_id TEXT DEFAULT '',
      seconds INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT ''
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS screentime_adjustments (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      user_id TEXT DEFAULT '',
      date TEXT DEFAULT '',
      minutes INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS screentime_devices (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      name TEXT DEFAULT '',
      token_hash TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    )
  `);
  for (const table of SCREENTIME_TABLES) {
    try { db.exec(`SELECT crsql_as_crr('${table}')`); } catch (e) {
      if (!e.message.includes("already")) throw e;
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS screentime_usage_day ON screentime_usage (family_id, user_id, date)");
  db.exec("CREATE INDEX IF NOT EXISTS screentime_adjustments_day ON screentime_adjustments (family_id, user_id, date)");
}

// --- Helpers -------------------------------------------------------------------

const hashSecret = (s) => crypto.createHash("sha256").update(s).digest("hex");

function str(v, max) {
  if (typeof v !== "string") return undefined;
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

const isWeekend = (date) => { const d = new Date(`${date}T12:00:00Z`).getUTCDay(); return d === 0 || d === 6; };

function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null;
  const t = Date.parse(`${v}T12:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v ? null : v;
}

function parseWarn(v) {
  const list = (Array.isArray(v) ? v : String(v || "").split(","))
    .map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0 && x <= 120);
  return [...new Set(list)].sort((a, b) => b - a).slice(0, LIMITS.warnings);
}

function settingsRowToObj(r) {
  return {
    enabled: !!r?.enabled,
    weekdayMinutes: r ? r.weekday_minutes : DEFAULTS.weekdayMinutes,
    weekendMinutes: r ? r.weekend_minutes : DEFAULTS.weekendMinutes,
    loginName: r?.login_name || "",
    warnMinutes: r ? parseWarn(r.warn_minutes) : DEFAULTS.warnMinutes,
    graceMinutes: r ? r.grace_minutes : DEFAULTS.graceMinutes,
  };
}

function registerScreentime({ app, db, emitEvent, broadcastSSE, requireFamilyAuth, requireAdmin, rateLimit }) {
  const now = () => new Date().toISOString();
  // deviceId -> { at, active: [login], states: {login: state}, hostname }. In memory: it's "who is on right now".
  const live = new Map();

  function insertRow(fid, table, row) {
    const id = row.id || crypto.randomUUID();
    const data = { ...row, family_id: fid };
    delete data.id;
    const cols = ["id", ...Object.keys(data)];
    db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(id, ...Object.values(data));
    emitEvent(fid, table, id, "insert", data);
    return id;
  }
  function updateRow(fid, table, id, fields) {
    if (Object.keys(fields).length === 0) return;
    const sets = Object.keys(fields).map((c) => `${c} = ?`).join(", ");
    db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ? AND family_id = ?`).run(...Object.values(fields), id, fid);
    emitEvent(fid, table, id, "update", fields);
  }
  function deleteRow(fid, table, id) {
    db.prepare(`DELETE FROM ${table} WHERE id = ? AND family_id = ?`).run(id, fid);
    emitEvent(fid, table, id, "delete");
  }

  const isAdmin = (fid, mid) => !!db.prepare("SELECT is_admin FROM family_members WHERE id = ? AND family_id = ?").get(mid || "", fid)?.is_admin;
  const getUser = (fid, id) => db.prepare("SELECT * FROM users WHERE id = ? AND family_id = ?").get(id, fid);
  const getSettings = (fid, uid) => db.prepare("SELECT * FROM screentime_settings WHERE id = ? AND family_id = ?").get(uid, fid);
  const changed = (fid) => broadcastSSE(fid, "screentime:changed", {});

  /** One person's numbers for one day. */
  function dayFor(fid, uid, date, settingsRow) {
    const s = settingsRowToObj(settingsRow);
    const usage = db.prepare("SELECT device_id, seconds FROM screentime_usage WHERE family_id = ? AND user_id = ? AND date = ?").all(fid, uid, date);
    const adjustments = db.prepare("SELECT * FROM screentime_adjustments WHERE family_id = ? AND user_id = ? AND date = ? ORDER BY created_at").all(fid, uid, date);
    const usedSeconds = usage.reduce((t, u) => t + u.seconds, 0);
    const bonusSeconds = adjustments.reduce((t, a) => t + a.minutes * 60, 0);
    const allowanceSeconds = s.enabled ? (isWeekend(date) ? s.weekendMinutes : s.weekdayMinutes) * 60 : null;
    return {
      date, allowanceSeconds, bonusSeconds, usedSeconds,
      remainingSeconds: allowanceSeconds == null ? null : allowanceSeconds + bonusSeconds - usedSeconds,
      byDevice: usage.map((u) => ({ deviceId: u.device_id, seconds: u.seconds })),
      adjustments: adjustments.map((a) => ({ id: a.id, minutes: a.minutes, note: a.note, createdBy: a.created_by, createdAt: a.created_at })),
    };
  }

  /** Where this person is logged in right now, from recent device reports. */
  function liveFor(fid, login) {
    if (!login) return null;
    for (const [deviceId, l] of live) {
      if (l.familyId !== fid || Date.now() - l.at > ONLINE_MS || !l.active.includes(login)) continue;
      const dev = db.prepare("SELECT name FROM screentime_devices WHERE id = ? AND family_id = ?").get(deviceId, fid);
      if (!dev) continue;
      return { deviceId, deviceName: dev.name, state: l.states[login] || "ok", graceEndsAt: l.graceEndsAt?.[login] || null, at: new Date(l.at).toISOString() };
    }
    return null;
  }

  // --- Family endpoints ----------------------------------------------------------

  app.get("/api/screentime/state", requireFamilyAuth, (req, res) => {
    const fid = req.familyId;
    const date = validDate(req.query.date) || new Date().toISOString().slice(0, 10);
    const admin = isAdmin(fid, req.memberId);
    const settingsRows = new Map(db.prepare("SELECT * FROM screentime_settings WHERE family_id = ?").all(fid).map((r) => [r.id, r]));
    let people = db.prepare("SELECT id, name, role FROM users WHERE family_id = ? ORDER BY created_at, name").all(fid);
    people = admin
      ? people.filter((u) => u.role === "kid" || settingsRows.get(u.id)?.enabled)
      : people.filter((u) => u.id === req.memberId);
    const deviceNames = new Map(db.prepare("SELECT id, name FROM screentime_devices WHERE family_id = ?").all(fid).map((d) => [d.id, d.name]));
    const weekStart = shiftDate(date, -6);

    const out = people.map((u) => {
      const row = settingsRows.get(u.id);
      const settings = settingsRowToObj(row);
      const today = dayFor(fid, u.id, date, row);
      today.byDevice = today.byDevice.map((d) => ({ ...d, deviceName: deviceNames.get(d.deviceId) || "Removed computer" }));
      const used = new Map(db.prepare("SELECT date, SUM(seconds) AS s FROM screentime_usage WHERE family_id = ? AND user_id = ? AND date BETWEEN ? AND ? GROUP BY date")
        .all(fid, u.id, weekStart, date).map((r) => [r.date, r.s]));
      const bonus = new Map(db.prepare("SELECT date, SUM(minutes) AS m FROM screentime_adjustments WHERE family_id = ? AND user_id = ? AND date BETWEEN ? AND ? GROUP BY date")
        .all(fid, u.id, weekStart, date).map((r) => [r.date, r.m]));
      const week = [];
      for (let i = 6; i >= 0; i--) {
        const d = shiftDate(date, -i);
        const base = settings.enabled ? (isWeekend(d) ? settings.weekendMinutes : settings.weekdayMinutes) * 60 : null;
        week.push({ date: d, usedSeconds: used.get(d) || 0, allowanceSeconds: base == null ? null : base + (bonus.get(d) || 0) * 60 });
      }
      return { id: u.id, name: u.name, role: u.role, settings, today, week, live: settings.enabled ? liveFor(fid, settings.loginName) : null };
    });

    const result = { date, isAdmin: admin, people: out, serverTime: now() };
    if (admin) {
      result.devices = db.prepare("SELECT id, name, created_at FROM screentime_devices WHERE family_id = ? ORDER BY created_at").all(fid).map((d) => {
        const l = live.get(d.id);
        return { id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: l ? new Date(l.at).toISOString() : null, online: !!l && Date.now() - l.at < ONLINE_MS, hostname: l?.hostname || "" };
      });
    }
    res.json(result);
  });

  app.put("/api/screentime/members/:id", requireFamilyAuth, requireAdmin, (req, res) => {
    const fid = req.familyId;
    const user = getUser(fid, req.params.id);
    if (!user) return res.status(404).json({ error: "person not found" });
    const b = req.body || {};
    const fields = {};
    if (b.enabled !== undefined) fields.enabled = b.enabled ? 1 : 0;
    for (const [key, col] of [["weekdayMinutes", "weekday_minutes"], ["weekendMinutes", "weekend_minutes"]]) {
      if (b[key] === undefined) continue;
      if (!Number.isInteger(b[key]) || b[key] < 0 || b[key] > LIMITS.minutes) return res.status(400).json({ error: `${key} must be 0-${LIMITS.minutes} minutes` });
      fields[col] = b[key];
    }
    if (b.loginName !== undefined) {
      const login = str(b.loginName, 32)?.toLowerCase() ?? "";
      if (login && !LOGIN_RE.test(login)) return res.status(400).json({ error: "computer login should look like a Linux username (e.g. alex)" });
      if (login) {
        const taken = db.prepare("SELECT s.id, u.name FROM screentime_settings s LEFT JOIN users u ON u.id = s.id WHERE s.family_id = ? AND s.login_name = ? AND s.id != ?").get(fid, login, user.id);
        if (taken) return res.status(409).json({ error: `${taken.name || "someone else"} already uses the login "${login}"` });
      }
      fields.login_name = login;
    }
    if (b.warnMinutes !== undefined) {
      if (!Array.isArray(b.warnMinutes)) return res.status(400).json({ error: "warnMinutes must be a list of minutes" });
      fields.warn_minutes = parseWarn(b.warnMinutes).join(",");
    }
    if (b.graceMinutes !== undefined) {
      if (!Number.isInteger(b.graceMinutes) || b.graceMinutes < 0 || b.graceMinutes > LIMITS.grace) return res.status(400).json({ error: `graceMinutes must be 0-${LIMITS.grace}` });
      fields.grace_minutes = b.graceMinutes;
    }
    fields.updated_at = now();
    if (getSettings(fid, user.id)) updateRow(fid, "screentime_settings", user.id, fields);
    else {
      insertRow(fid, "screentime_settings", {
        id: user.id, enabled: 0, weekday_minutes: DEFAULTS.weekdayMinutes, weekend_minutes: DEFAULTS.weekendMinutes,
        login_name: "", warn_minutes: DEFAULTS.warnMinutes.join(","), grace_minutes: DEFAULTS.graceMinutes, ...fields,
      });
    }
    changed(fid);
    res.json({ id: user.id, settings: settingsRowToObj(getSettings(fid, user.id)) });
  });

  app.post("/api/screentime/members/:id/adjust", requireFamilyAuth, requireAdmin, (req, res) => {
    const fid = req.familyId;
    const user = getUser(fid, req.params.id);
    if (!user) return res.status(404).json({ error: "person not found" });
    const b = req.body || {};
    const date = validDate(b.date);
    if (!date) return res.status(400).json({ error: "date (YYYY-MM-DD) required" });
    if (!Number.isInteger(b.minutes) || b.minutes === 0 || Math.abs(b.minutes) > LIMITS.adjust) {
      return res.status(400).json({ error: `minutes must be a whole number between -${LIMITS.adjust} and ${LIMITS.adjust}, not 0` });
    }
    const id = insertRow(fid, "screentime_adjustments", {
      user_id: user.id, date, minutes: b.minutes, note: str(b.note, LIMITS.note) || "", created_by: req.memberId, created_at: now(),
    });
    changed(fid);
    res.json({ id, today: dayFor(fid, user.id, date, getSettings(fid, user.id)) });
  });

  app.delete("/api/screentime/adjustments/:id", requireFamilyAuth, requireAdmin, (req, res) => {
    const row = db.prepare("SELECT id FROM screentime_adjustments WHERE id = ? AND family_id = ?").get(req.params.id, req.familyId);
    if (!row) return res.status(404).json({ error: "not found" });
    deleteRow(req.familyId, "screentime_adjustments", row.id);
    changed(req.familyId);
    res.json({ ok: true });
  });

  app.post("/api/screentime/devices", requireFamilyAuth, requireAdmin, (req, res) => {
    const fid = req.familyId;
    const name = str(req.body?.name, LIMITS.deviceName);
    if (!name) return res.status(400).json({ error: "name required" });
    const count = db.prepare("SELECT COUNT(*) AS n FROM screentime_devices WHERE family_id = ?").get(fid).n;
    if (count >= LIMITS.devices) return res.status(400).json({ error: "too many computers" });
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(24).toString("base64url");
    insertRow(fid, "screentime_devices", { id, name, token_hash: hashSecret(secret), created_by: req.memberId, created_at: now() });
    changed(fid);
    res.json({ id, name, token: `psd_${id}.${secret}` });
  });

  app.delete("/api/screentime/devices/:id", requireFamilyAuth, requireAdmin, (req, res) => {
    const row = db.prepare("SELECT id FROM screentime_devices WHERE id = ? AND family_id = ?").get(req.params.id, req.familyId);
    if (!row) return res.status(404).json({ error: "not found" });
    deleteRow(req.familyId, "screentime_devices", row.id);
    live.delete(row.id);
    changed(req.familyId);
    res.json({ ok: true });
  });

  // The agent's files, for `curl -O` on the family computer. Fixed list, nothing secret in them.
  app.get("/screentime-agent/:file", (req, res) => {
    if (!AGENT_FILES.has(req.params.file)) return res.status(404).send("not found");
    res.setHeader("Cache-Control", "no-cache");
    res.type("text/plain").sendFile(path.join(AGENT_DIR, req.params.file));
  });

  // --- Device endpoint -------------------------------------------------------------

  const deviceLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
    skipSuccessfulRequests: true, message: { error: "too many failed device requests" },
  });

  function requireDevice(req, res, next) {
    const m = /^Bearer psd_([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,64})$/.exec(req.get("authorization") || "");
    const dev = m && db.prepare("SELECT * FROM screentime_devices WHERE id = ?").get(m[1]);
    if (!dev || !crypto.timingSafeEqual(Buffer.from(hashSecret(m[2])), Buffer.from(dev.token_hash))) {
      return res.status(401).json({ error: "unknown or removed computer" });
    }
    req.device = dev;
    req.familyId = dev.family_id;
    next();
  }

  app.post("/api/screentime/device/report", deviceLimiter, requireDevice, (req, res) => {
    const fid = req.familyId;
    const dev = req.device;
    const b = req.body || {};
    const date = validDate(b.date);
    // The computer's local date: allow for time zones, refuse anything wildly off.
    if (!date || Math.abs(Date.parse(`${date}T12:00:00Z`) - Date.now()) > 2 * DAY_MS) {
      return res.status(400).json({ error: "date must be the computer's local date (YYYY-MM-DD)" });
    }
    const usage = b.usage && typeof b.usage === "object" && !Array.isArray(b.usage) ? b.usage : {};
    if (Object.keys(usage).length > LIMITS.logins) return res.status(400).json({ error: "too many logins" });
    const active = (Array.isArray(b.active) ? b.active : []).filter((l) => typeof l === "string" && LOGIN_RE.test(l)).slice(0, LIMITS.logins);
    const states = {};
    const graceEndsAt = {};
    for (const [login, st] of Object.entries(b.states && typeof b.states === "object" ? b.states : {}).slice(0, LIMITS.logins)) {
      if (LOGIN_RE.test(login) && AGENT_STATES.has(st)) states[login] = st;
    }
    for (const [login, t] of Object.entries(b.graceEndsAt && typeof b.graceEndsAt === "object" ? b.graceEndsAt : {}).slice(0, LIMITS.logins)) {
      if (LOGIN_RE.test(login) && typeof t === "string" && !Number.isNaN(Date.parse(t))) graceEndsAt[login] = new Date(t).toISOString();
    }

    const settings = db.prepare("SELECT * FROM screentime_settings WHERE family_id = ? AND enabled = 1 AND login_name != ''").all(fid);
    let dirty = false;
    db.transaction(() => {
      for (const s of settings) {
        const reported = usage[s.login_name];
        if (!Number.isFinite(reported) || reported <= 0) continue;
        const seconds = Math.min(Math.floor(reported), 86400);
        const id = `${s.id}:${date}:${dev.id}`;
        const row = db.prepare("SELECT seconds FROM screentime_usage WHERE id = ? AND family_id = ?").get(id, fid);
        if (!row) {
          insertRow(fid, "screentime_usage", { id, user_id: s.id, date, device_id: dev.id, seconds, updated_at: now() });
          dirty = true;
        } else if (seconds > row.seconds) {
          updateRow(fid, "screentime_usage", id, { seconds, updated_at: now() });
          dirty = true;
        }
      }
    })();

    const prev = live.get(dev.id);
    const next = { familyId: fid, at: Date.now(), active, states, graceEndsAt, hostname: str(b.hostname, 64) || "" };
    live.set(dev.id, next);
    if (dirty || !prev || Date.now() - prev.at > ONLINE_MS || JSON.stringify([prev.active, prev.states]) !== JSON.stringify([active, states])) changed(fid);

    const names = new Map(db.prepare("SELECT id, name FROM users WHERE family_id = ?").all(fid).map((u) => [u.id, u.name]));
    res.json({
      date,
      serverTime: now(),
      members: settings.map((s) => {
        const day = dayFor(fid, s.id, date, s);
        const o = settingsRowToObj(s);
        return {
          login: s.login_name, userId: s.id, name: names.get(s.id) || "",
          allowanceSeconds: day.allowanceSeconds, bonusSeconds: day.bonusSeconds, usedSeconds: day.usedSeconds,
          deviceSeconds: day.byDevice.find((d) => d.deviceId === dev.id)?.seconds || 0,
          remainingSeconds: day.remainingSeconds,
          weekdayMinutes: o.weekdayMinutes, weekendMinutes: o.weekendMinutes, warnMinutes: o.warnMinutes, graceMinutes: o.graceMinutes,
        };
      }),
    });
  });
}

module.exports = { initScreentimeSchema, registerScreentime, SCREENTIME_TABLES, isWeekend, shiftDate };
