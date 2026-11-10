/**
 * Projects module: personal project backlogs with tasks, dependencies, external issue links
 * (GitHub), personal tracks and a daily pick list.
 *
 * Ownership and sharing:
 *   - A project is visible only to the family members on it (table project_members). The creator is
 *     its owner; the owner can add or remove other members (parents or kids). Every endpoint checks
 *     membership server-side; projects you aren't on are reported as "not found".
 *   - The project itself (name, goal, status, tasks, links) is shared by everyone on it. Where it sits
 *     for each person (track and lane) lives on that person's project_members row.
 *   - Tracks, daily picks and the GitHub token belong to one member.
 *   - Tasks may be assigned to one member of the project; others don't get them as suggestions.
 *
 * Tables are cr-sqlite CRRs and go through the event log like every other family table. For now all
 * endpoints are parent-only (kids can be members and assignees, but the tab is hidden for them).
 */

const crypto = require("crypto");

const PROJECT_TABLES = ["project_tracks", "projects", "project_members", "project_tasks", "project_picks"];

const PROJECT_STATUSES = ["Active", "Paused", "Dormant", "Archive", "Done", "Dropped"];
const TASK_STATUSES = ["todo", "doing", "blocked", "done", "dropped"];
const TASK_SIZES = ["xs", "s", "m", "l", "xl"];
const ENERGIES = ["low", "medium", "high"];
const PICK_OUTCOMES = ["", "done", "partial", "skipped"];
// Inventory statuses that a re-import may overwrite; anything else was set by hand.
const INVENTORY_STATUSES = ["Active", "Paused", "Dormant", "Archive"];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function addColumn(db, table, col, def) {
  if (db.pragma(`table_info(${table})`).some((c) => c.name === col)) return;
  const crr = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(`${table}__crsql_itrig`);
  if (crr) db.exec(`SELECT crsql_begin_alter('${table}')`);
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  if (crr) db.exec(`SELECT crsql_commit_alter('${table}')`);
}

function initProjectsSchema(db) {
  // Tracks are one member's life areas (Home & Family, Work, Open Source...).
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_tracks (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      member_id TEXT DEFAULT '',
      slug TEXT DEFAULT '',
      name TEXT DEFAULT '',
      icon TEXT DEFAULT '',
      color TEXT DEFAULT '#8b8fa8',
      intention TEXT DEFAULT '',
      focus_limit INTEGER DEFAULT 2,
      sort_order REAL DEFAULT 0,
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT ''
    )
  `);
  // projects.priority and projects.track_id predate per-member placement and are no longer used;
  // placement lives on project_members.
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      slug TEXT DEFAULT '',
      name TEXT DEFAULT '',
      machine TEXT DEFAULT '',
      path TEXT DEFAULT '',
      category TEXT DEFAULT '',
      kind TEXT DEFAULT '',
      status TEXT DEFAULT 'Active',
      backup TEXT DEFAULT '',
      last_activity TEXT DEFAULT '',
      note TEXT DEFAULT '',
      goal TEXT DEFAULT '',
      priority INTEGER DEFAULT 1,
      showcase_rank INTEGER DEFAULT 0,
      tier TEXT DEFAULT '',
      pitch TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      related TEXT DEFAULT '[]',
      links TEXT DEFAULT '[]',
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      completed_at TEXT DEFAULT '',
      archived INTEGER DEFAULT 0,
      track_id TEXT DEFAULT ''
    )
  `);
  // One row per (project, member). id is "<project id>:<member id>" so concurrent adds converge.
  // lane: 3 Focus, 2 Next, 1 Later, 0 Someday.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_members (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      project_id TEXT DEFAULT '',
      member_id TEXT DEFAULT '',
      role TEXT DEFAULT 'collaborator',
      track_id TEXT DEFAULT '',
      lane INTEGER DEFAULT 1,
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT ''
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_tasks (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      project_id TEXT DEFAULT '',
      title TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'todo',
      priority INTEGER DEFAULT 1,
      size TEXT DEFAULT 's',
      energy TEXT DEFAULT 'medium',
      depends_on TEXT DEFAULT '[]',
      sort_order REAL DEFAULT 0,
      external_type TEXT DEFAULT '',
      external_key TEXT DEFAULT '',
      external_url TEXT DEFAULT '',
      external_state TEXT DEFAULT '',
      external_updated_at TEXT DEFAULT '',
      labels TEXT DEFAULT '[]',
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      completed_at TEXT DEFAULT '',
      assignee_id TEXT DEFAULT ''
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_picks (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      member_id TEXT DEFAULT '',
      date TEXT DEFAULT '',
      task_id TEXT DEFAULT '',
      outcome TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    )
  `);
  // Databases created by earlier versions of this module.
  addColumn(db, "projects", "track_id", "TEXT DEFAULT ''");
  addColumn(db, "project_tracks", "member_id", "TEXT DEFAULT ''");
  addColumn(db, "project_tasks", "assignee_id", "TEXT DEFAULT ''");
  for (const table of PROJECT_TABLES) {
    try { db.exec(`SELECT crsql_as_crr('${table}')`); } catch (e) {
      if (!e.message.includes("already")) throw e;
    }
  }
}

// --- Row mapping ---------------------------------------------------------------

function jsonOr(val, def) {
  try { const v = JSON.parse(val); return v ?? def; } catch { return def; }
}

function projectRowToObj(r, mine, members) {
  return {
    id: r.id, slug: r.slug, name: r.name, machine: r.machine, path: r.path,
    category: r.category, kind: r.kind, status: r.status, backup: r.backup,
    lastActivity: r.last_activity, note: r.note, goal: r.goal,
    showcaseRank: r.showcase_rank || null, tier: r.tier, pitch: r.pitch,
    tags: jsonOr(r.tags, []), related: jsonOr(r.related, []), links: jsonOr(r.links, []),
    createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
    archived: !!r.archived,
    // The caller's own placement and role.
    trackId: mine?.track_id || "", priority: mine?.lane ?? 1, role: mine?.role || "",
    members: (members || []).map((m) => ({ memberId: m.member_id, role: m.role })),
  };
}

function trackRowToObj(r) {
  return {
    id: r.id, slug: r.slug, name: r.name, icon: r.icon, color: r.color, intention: r.intention,
    focusLimit: r.focus_limit, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function taskRowToObj(r) {
  return {
    id: r.id, projectId: r.project_id, title: r.title, notes: r.notes, status: r.status,
    priority: r.priority, size: r.size, energy: r.energy, dependsOn: jsonOr(r.depends_on, []),
    sortOrder: r.sort_order, externalType: r.external_type, externalKey: r.external_key,
    externalUrl: r.external_url, externalState: r.external_state,
    externalUpdatedAt: r.external_updated_at, labels: jsonOr(r.labels, []),
    assigneeId: r.assignee_id || "",
    createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
  };
}

function pickRowToObj(r) {
  return {
    id: r.id, memberId: r.member_id, date: r.date, taskId: r.task_id,
    outcome: r.outcome, note: r.note, createdAt: r.created_at,
  };
}

// --- Validation helpers ----------------------------------------------------------

const str = (v, max = 2000) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
const oneOf = (v, list, def) => (list.includes(v) ? v : def);
const clampInt = (v, lo, hi, def) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const strList = (v, maxItems = 50, maxLen = 200) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, maxItems).map((x) => x.slice(0, maxLen)) : null;
const REPO_RE = /^(?!\.)[\w.-]+\/(?!\.)[\w.-]+$/;
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function cleanLinks(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const l of v.slice(0, 20)) {
    if (!l || typeof l !== "object") continue;
    if (l.type === "github" && typeof l.repo === "string" && REPO_RE.test(l.repo)) {
      const issue = Number.parseInt(l.issue, 10);
      out.push(Number.isFinite(issue) && issue > 0 ? { type: "github", repo: l.repo, issue } : { type: "github", repo: l.repo });
    } else if (l.type === "url" && typeof l.url === "string" && /^https?:\/\//.test(l.url)) {
      out.push({ type: "url", url: l.url.slice(0, 500), label: str(l.label, 100) });
    }
  }
  return out;
}

// Split an inventory "next step" into separate starter tasks.
function tasksFromAction(action) {
  return str(action, 2000).split(/;\s+/).map((s) => s.trim().replace(/\.$/, "")).filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
}

// Guess a size/energy for an imported starter task from its wording.
function guessTaskShape(title) {
  const t = title.toLowerCase();
  if (/\b(git init|push|commit|add a remote|copy off|snapshot|delete|drop|keep one)\b/.test(t)) return { size: "s", energy: "low" };
  if (/\b(write up|essay|post|demo|polish|publish|document|package)\b/.test(t)) return { size: "l", energy: "high" };
  return { size: "m", energy: "medium" };
}

const memberRowId = (projectId, memberId) => `${projectId}:${memberId}`;
const tokenKey = (fid, mid) => `${fid}:github_token:${mid}`;

// --- Routes ------------------------------------------------------------------------

function registerProjects({ app, db, emitEvent, broadcastSSE, requireFamilyAuth, requireAdmin }) {
  // requireAdmin also guarantees a member is selected (req.memberId). The database isn't open yet when
  // routes are registered, so the one-time ownership migration runs on the first projects request.
  let migrated = false;
  const migrateOnce = (req, res, next) => {
    if (!migrated) {
      migrated = true;
      try { migrateOwnership(); } catch (e) { console.error("Projects ownership migration failed:", e.message); }
    }
    next();
  };
  const auth = [requireFamilyAuth, requireAdmin, migrateOnce];
  const now = () => new Date().toISOString();
  const changed = (fid) => broadcastSSE(fid, "projects:changed", {});

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

  // ---- Access ----
  const membership = (fid, pid, mid) => db.prepare("SELECT * FROM project_members WHERE family_id = ? AND project_id = ? AND member_id = ?").get(fid, pid, mid);
  const projectMembers = (fid, pid) => db.prepare("SELECT * FROM project_members WHERE family_id = ? AND project_id = ? ORDER BY created_at").all(fid, pid);
  const isFamilyMember = (fid, mid) => !!db.prepare("SELECT 1 FROM family_members WHERE id = ? AND family_id = ?").get(mid, fid);
  // A project the caller is on, or undefined (treated as not found, so other people's projects stay invisible).
  const visibleProject = (req, id) => db.prepare(
    "SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id AND m.member_id = ? AND m.family_id = p.family_id WHERE p.id = ? AND p.family_id = ?",
  ).get(req.memberId, id, req.familyId);
  const visibleTask = (req, id) => db.prepare(
    "SELECT t.* FROM project_tasks t JOIN project_members m ON m.project_id = t.project_id AND m.member_id = ? AND m.family_id = t.family_id WHERE t.id = ? AND t.family_id = ?",
  ).get(req.memberId, id, req.familyId);
  const myTrack = (req, id) => db.prepare("SELECT * FROM project_tracks WHERE id = ? AND family_id = ? AND member_id = ?").get(id, req.familyId, req.memberId);
  const getTrack = (fid, id) => db.prepare("SELECT * FROM project_tracks WHERE id = ? AND family_id = ?").get(id, fid);
  const getTask = (fid, id) => db.prepare("SELECT * FROM project_tasks WHERE id = ? AND family_id = ?").get(id, fid);
  const projectOut = (req, row) => projectRowToObj(row, membership(req.familyId, row.id, req.memberId), projectMembers(req.familyId, row.id));

  function addMember(fid, pid, mid, { role = "collaborator", trackId = "", lane = 2 } = {}) {
    const t = now();
    insertRow(fid, "project_members", {
      id: memberRowId(pid, mid), project_id: pid, member_id: mid, role, track_id: trackId, lane, created_at: t, updated_at: t,
    });
  }

  // Data written before ownership existed: give every project and track to the family's first parent.
  // Runs once per process (see migrateOnce) and goes through the event log like any other write.
  function migrateOwnership() {
    const fams = db.prepare(`SELECT DISTINCT family_id FROM projects WHERE id NOT IN (SELECT project_id FROM project_members)
      UNION SELECT DISTINCT family_id FROM project_tracks WHERE member_id = ''`).all();
    for (const { family_id: fid } of fams) {
      const owner = db.prepare("SELECT id FROM family_members WHERE family_id = ? AND is_admin = 1 ORDER BY created_at LIMIT 1").get(fid);
      if (!owner) continue;
      db.transaction(() => {
        for (const tr of db.prepare("SELECT id FROM project_tracks WHERE family_id = ? AND member_id = ''").all(fid)) {
          updateRow(fid, "project_tracks", tr.id, { member_id: owner.id });
        }
        for (const p of db.prepare("SELECT * FROM projects WHERE family_id = ? AND id NOT IN (SELECT project_id FROM project_members)").all(fid)) {
          addMember(fid, p.id, owner.id, { role: "owner", trackId: p.track_id || "", lane: p.priority ?? 1 });
        }
      })();
      console.log(`Projects: assigned existing projects and tracks to their first parent in family ${fid}`);
    }
  }
  // Shared project fields from a client/import payload. Only keys present are returned.
  function projectFields(b) {
    const f = {};
    if ("slug" in b) f.slug = str(b.slug, 100);
    if ("name" in b) f.name = str(b.name, 200);
    if ("machine" in b) f.machine = str(b.machine, 100);
    if ("path" in b) f.path = str(b.path, 500);
    if ("category" in b) f.category = str(b.category, 100);
    if ("kind" in b) f.kind = str(b.kind, 50);
    if ("status" in b) f.status = oneOf(b.status, PROJECT_STATUSES, "Active");
    if ("backup" in b) f.backup = str(b.backup, 50);
    if ("lastActivity" in b) f.last_activity = str(b.lastActivity, 30);
    if ("note" in b) f.note = str(b.note, 4000);
    if ("goal" in b) f.goal = str(b.goal, 2000);
    if ("showcaseRank" in b) f.showcase_rank = clampInt(b.showcaseRank, 0, 999, 0);
    if ("tier" in b) f.tier = str(b.tier, 30);
    if ("pitch" in b) f.pitch = str(b.pitch, 2000);
    if ("tags" in b) { const v = strList(b.tags); if (v) f.tags = JSON.stringify(v); }
    if ("related" in b) { const v = strList(b.related); if (v) f.related = JSON.stringify(v); }
    if ("links" in b) { const v = cleanLinks(b.links); if (v) f.links = JSON.stringify(v); }
    if ("archived" in b) f.archived = b.archived ? 1 : 0;
    return f;
  }

  // The caller's own placement: which of their tracks, and which lane (sent as "priority").
  function placementFields(req, b) {
    const f = {};
    if ("trackId" in b) {
      const tid = str(b.trackId, 64);
      if (tid === "" || myTrack(req, tid)) f.track_id = tid;
    }
    if ("priority" in b) f.lane = clampInt(b.priority, 0, 3, 1);
    return f;
  }

  function trackFields(b) {
    const f = {};
    if ("slug" in b) f.slug = str(b.slug, 60);
    if ("name" in b) f.name = str(b.name, 80);
    if ("icon" in b) f.icon = str(b.icon, 16);
    if ("color" in b && COLOR_RE.test(b.color)) f.color = b.color;
    if ("intention" in b) f.intention = str(b.intention, 500);
    if ("focusLimit" in b) f.focus_limit = clampInt(b.focusLimit, 1, 10, 2);
    if ("sort" in b && Number.isFinite(Number(b.sort))) f.sort_order = Number(b.sort);
    if ("sortOrder" in b && Number.isFinite(Number(b.sortOrder))) f.sort_order = Number(b.sortOrder);
    return f;
  }

  function taskFields(req, b, projectId) {
    const f = {};
    if ("title" in b) f.title = str(b.title, 300);
    if ("notes" in b) f.notes = str(b.notes, 8000);
    if ("status" in b) f.status = oneOf(b.status, TASK_STATUSES, "todo");
    if ("priority" in b) f.priority = clampInt(b.priority, 0, 3, 1);
    if ("size" in b) f.size = oneOf(b.size, TASK_SIZES, "s");
    if ("energy" in b) f.energy = oneOf(b.energy, ENERGIES, "medium");
    if ("sortOrder" in b && Number.isFinite(Number(b.sortOrder))) f.sort_order = Number(b.sortOrder);
    if ("labels" in b) { const v = strList(b.labels, 20, 50); if (v) f.labels = JSON.stringify(v); }
    if ("dependsOn" in b) {
      const v = strList(b.dependsOn, 50, 64);
      // Only tasks the caller can see; anything else is dropped.
      if (v) f.depends_on = JSON.stringify([...new Set(v.filter((id) => visibleTask(req, id)))]);
    }
    if ("assigneeId" in b) {
      const a = str(b.assigneeId, 64);
      if (a === "" || membership(req.familyId, projectId, a)) f.assignee_id = a;
    }
    return f;
  }

  function withCompletion(f, existingStatus) {
    if (!("status" in f)) return f;
    const closed = (s) => s === "done" || s === "dropped" || s === "Done" || s === "Dropped";
    if (closed(f.status) && !closed(existingStatus)) f.completed_at = now();
    if (!closed(f.status) && closed(existingStatus)) f.completed_at = "";
    return f;
  }

  // Would adding `deps` to task `id` create a cycle?
  function createsCycle(fid, id, deps) {
    const seen = new Set();
    const stack = [...deps];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === id) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const row = getTask(fid, cur);
      if (row) stack.push(...jsonOr(row.depends_on, []));
    }
    return false;
  }

  // ---- GitHub token: one per member, never returned to the client ----
  // Registered before /api/projects/:id so "github-token" isn't taken for a project id. The generic
  // store API refuses github_token* keys, so the other parent can't read it either.
  const getToken = (req) => db.prepare("SELECT value FROM stores WHERE key = ?").get(tokenKey(req.familyId, req.memberId))?.value || "";

  app.get("/api/projects/github-token", ...auth, (req, res) => {
    res.json({ configured: !!getToken(req) });
  });

  app.put("/api/projects/github-token", ...auth, (req, res) => {
    const value = str(req.body?.value, 400).trim();
    const key = tokenKey(req.familyId, req.memberId);
    const t = now();
    db.prepare("INSERT INTO stores (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(key, value, t);
    emitEvent(req.familyId, "stores", key, "upsert", { key, value, updated_at: t });
    res.json({ configured: !!value });
  });

  // ---- State: everything the caller can see ----
  app.get("/api/projects/state", ...auth, (req, res) => {
    const fid = req.familyId;
    const mid = req.memberId;
    const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
    const projects = db.prepare(
      "SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id AND m.family_id = p.family_id WHERE p.family_id = ? AND m.member_id = ?",
    ).all(fid, mid);
    const ids = new Set(projects.map((p) => p.id));
    const allMembers = db.prepare(
      "SELECT pm.* FROM project_members pm WHERE pm.family_id = ? AND pm.project_id IN (SELECT project_id FROM project_members WHERE family_id = ? AND member_id = ?) ORDER BY pm.created_at",
    ).all(fid, fid, mid);
    const byProject = new Map();
    for (const m of allMembers) {
      if (!byProject.has(m.project_id)) byProject.set(m.project_id, []);
      byProject.get(m.project_id).push(m);
    }
    const tasks = db.prepare("SELECT * FROM project_tasks WHERE family_id = ?").all(fid).filter((t) => ids.has(t.project_id));
    const taskIds = new Set(tasks.map((t) => t.id));
    res.json({
      me: mid,
      people: db.prepare("SELECT id, display_name, is_admin FROM family_members WHERE family_id = ? ORDER BY is_admin DESC, created_at").all(fid)
        .map((m) => ({ id: m.id, name: m.display_name, isAdmin: !!m.is_admin })),
      tracks: db.prepare("SELECT * FROM project_tracks WHERE family_id = ? AND member_id = ? ORDER BY sort_order, name").all(fid, mid).map(trackRowToObj),
      projects: projects.map((p) => {
        const ms = byProject.get(p.id) || [];
        return projectRowToObj(p, ms.find((m) => m.member_id === mid), ms);
      }),
      tasks: tasks.map(taskRowToObj),
      picks: db.prepare("SELECT * FROM project_picks WHERE family_id = ? AND member_id = ? AND date >= ?").all(fid, mid, since)
        .filter((p) => taskIds.has(p.task_id)).map(pickRowToObj),
    });
  });

  // ---- Tracks (the caller's own) ----
  app.post("/api/project-tracks", ...auth, (req, res) => {
    const f = trackFields(req.body || {});
    if (!f.name) return res.status(400).json({ error: "name required" });
    const max = db.prepare("SELECT MAX(sort_order) AS m FROM project_tracks WHERE family_id = ? AND member_id = ?").get(req.familyId, req.memberId).m;
    const t = now();
    const id = insertRow(req.familyId, "project_tracks", { sort_order: (max ?? -1) + 1, ...f, member_id: req.memberId, created_at: t, updated_at: t });
    changed(req.familyId);
    res.json(trackRowToObj(getTrack(req.familyId, id)));
  });

  app.put("/api/project-tracks/:id", ...auth, (req, res) => {
    const existing = myTrack(req, req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    const f = trackFields(req.body || {});
    f.updated_at = now();
    updateRow(req.familyId, "project_tracks", existing.id, f);
    changed(req.familyId);
    res.json(trackRowToObj(getTrack(req.familyId, existing.id)));
  });

  // Deleting a track leaves its projects unassigned (for you) rather than deleting them.
  app.delete("/api/project-tracks/:id", ...auth, (req, res) => {
    const existing = myTrack(req, req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    db.transaction(() => {
      for (const { id } of db.prepare("SELECT id FROM project_members WHERE family_id = ? AND member_id = ? AND track_id = ?").all(req.familyId, req.memberId, existing.id)) {
        updateRow(req.familyId, "project_members", id, { track_id: "", updated_at: now() });
      }
      deleteRow(req.familyId, "project_tracks", existing.id);
    })();
    changed(req.familyId);
    res.json({ ok: true });
  });

  // ---- Projects ----
  app.post("/api/projects", ...auth, (req, res) => {
    const b = req.body || {};
    const f = projectFields(b);
    if (!f.name) return res.status(400).json({ error: "name required" });
    const place = placementFields(req, b);
    const t = now();
    let id;
    db.transaction(() => {
      id = insertRow(req.familyId, "projects", { ...f, created_at: t, updated_at: t });
      addMember(req.familyId, id, req.memberId, { role: "owner", trackId: place.track_id || "", lane: place.lane ?? 2 });
    })();
    changed(req.familyId);
    res.json(projectOut(req, visibleProject(req, id)));
  });

  // Shared fields go to the project (any member may edit); trackId/priority go to the caller's own placement.
  app.put("/api/projects/:id", ...auth, (req, res) => {
    const existing = visibleProject(req, req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    const b = req.body || {};
    const f = withCompletion(projectFields(b), existing.status);
    const place = placementFields(req, b);
    db.transaction(() => {
      if (Object.keys(f).length) { f.updated_at = now(); updateRow(req.familyId, "projects", existing.id, f); }
      if (Object.keys(place).length) {
        place.updated_at = now();
        updateRow(req.familyId, "project_members", membership(req.familyId, existing.id, req.memberId).id, place);
      }
    })();
    changed(req.familyId);
    res.json(projectOut(req, visibleProject(req, existing.id)));
  });

  // Set who is on a project (owner only). Body: { memberIds: [...] }. The owner always stays on.
  // People removed lose their placement, their task assignments and their picks for its tasks.
  app.put("/api/projects/:id/members", ...auth, (req, res) => {
    const existing = visibleProject(req, req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    const mine = membership(req.familyId, existing.id, req.memberId);
    if (mine.role !== "owner") return res.status(403).json({ error: "only the owner can change who's on a project" });
    const wanted = strList(req.body?.memberIds, 50, 64);
    if (!wanted) return res.status(400).json({ error: "memberIds array required" });
    const want = new Set(wanted.filter((m) => isFamilyMember(req.familyId, m)));
    want.add(req.memberId);
    const current = projectMembers(req.familyId, existing.id);
    db.transaction(() => {
      for (const m of current) {
        if (want.has(m.member_id)) continue;
        removeMember(req.familyId, existing.id, m);
      }
      for (const mid of want) {
        if (!current.some((m) => m.member_id === mid)) addMember(req.familyId, existing.id, mid);
      }
    })();
    changed(req.familyId);
    res.json(projectOut(req, visibleProject(req, existing.id)));
  });

  // Leave a project someone else owns.
  app.delete("/api/projects/:id/members/me", ...auth, (req, res) => {
    const existing = visibleProject(req, req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    const mine = membership(req.familyId, existing.id, req.memberId);
    if (mine.role === "owner") return res.status(400).json({ error: "the owner can't leave; delete the project or remove the others instead" });
    db.transaction(() => removeMember(req.familyId, existing.id, mine))();
    changed(req.familyId);
    res.json({ ok: true });
  });

  function removeMember(fid, pid, m) {
    const t = now();
    for (const task of db.prepare("SELECT id FROM project_tasks WHERE family_id = ? AND project_id = ? AND assignee_id = ?").all(fid, pid, m.member_id)) {
      updateRow(fid, "project_tasks", task.id, { assignee_id: "", updated_at: t });
    }
    for (const pk of db.prepare("SELECT p.id FROM project_picks p JOIN project_tasks t ON t.id = p.task_id WHERE p.family_id = ? AND p.member_id = ? AND t.project_id = ?").all(fid, m.member_id, pid)) {
      deleteRow(fid, "project_picks", pk.id);
    }
    deleteRow(fid, "project_members", m.id);
  }

  app.delete("/api/projects/:id", ...auth, (req, res) => {
    const existing = visibleProject(req, req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    if (membership(req.familyId, existing.id, req.memberId).role !== "owner") return res.status(403).json({ error: "only the owner can delete a project" });
    const fid = req.familyId;
    const taskIds = db.prepare("SELECT id FROM project_tasks WHERE project_id = ? AND family_id = ?").all(existing.id, fid);
    db.transaction(() => {
      for (const { id } of taskIds) {
        for (const p of db.prepare("SELECT id FROM project_picks WHERE task_id = ? AND family_id = ?").all(id, fid)) deleteRow(fid, "project_picks", p.id);
        deleteRow(fid, "project_tasks", id);
      }
      for (const m of projectMembers(fid, existing.id)) deleteRow(fid, "project_members", m.id);
      deleteRow(fid, "projects", existing.id);
    })();
    changed(fid);
    res.json({ ok: true });
  });

  // Import or refresh the caller's projects from the project-backlog inventory (rows keyed by slug,
  // matched only against projects the caller owns). New projects are private to the caller.
  // Inventory facts are refreshed; anything set by hand (goal, links, Done/Dropped, placement) is kept.
  app.post("/api/projects/import", ...auth, (req, res) => {
    const rows = Array.isArray(req.body?.projects) ? req.body.projects.slice(0, 1000) : null;
    if (!rows) return res.status(400).json({ error: "projects array required" });
    const trackRows = Array.isArray(req.body?.tracks) ? req.body.tracks.slice(0, 50) : [];
    const fid = req.familyId;
    const mid = req.memberId;
    const result = { created: 0, updated: 0, tasksCreated: 0, tracksCreated: 0 };
    db.transaction(() => {
      // Tracks are created once from the inventory; after that they're edited in the app.
      const trackBySlug = new Map(db.prepare("SELECT id, slug FROM project_tracks WHERE family_id = ? AND member_id = ?").all(fid, mid).map((t) => [t.slug, t.id]));
      for (const tr of trackRows) {
        if (!tr || typeof tr.id !== "string" || !tr.name || trackBySlug.has(tr.id)) continue;
        const t = now();
        const id = insertRow(fid, "project_tracks", { ...trackFields({ ...tr, slug: tr.id }), member_id: mid, created_at: t, updated_at: t });
        trackBySlug.set(tr.id, id);
        result.tracksCreated++;
      }
      for (const r of rows) {
        if (!r || typeof r.id !== "string" || !r.name) continue;
        const inv = {
          slug: r.id, name: r.name, machine: r.machine, path: r.path, category: r.category, kind: r.kind,
          status: r.status, backup: r.backup, lastActivity: r.last, note: r.note,
          showcaseRank: r.rank || 0, tier: r.tier || "", pitch: r.pitch || "",
          tags: typeof r.tags === "string" ? r.tags.split(";").map((s) => s.trim()).filter(Boolean) : r.tags,
          related: typeof r.related === "string" ? r.related.split(";").map((s) => s.trim()).filter(Boolean) : r.related,
        };
        if (Array.isArray(r.links)) inv.links = r.links;
        const trackId = typeof r.track === "string" ? trackBySlug.get(r.track) || "" : "";
        const f = projectFields(inv);
        const existing = db.prepare(
          "SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id AND m.member_id = ? AND m.role = 'owner' WHERE p.family_id = ? AND p.slug = ?",
        ).get(mid, fid, r.id);
        const t = now();
        if (existing) {
          if (!INVENTORY_STATUSES.includes(existing.status)) delete f.status;
          if (jsonOr(existing.links, []).length && f.links) delete f.links;
          const diff = {};
          for (const [k, v] of Object.entries(f)) if (existing[k] !== v) diff[k] = v;
          if (Object.keys(diff).length) {
            diff.updated_at = t;
            updateRow(fid, "projects", existing.id, diff);
            result.updated++;
          }
          // Only fill in a track you haven't chosen yourself.
          const mine = membership(fid, existing.id, mid);
          if (!mine.track_id && trackId) updateRow(fid, "project_members", mine.id, { track_id: trackId, updated_at: t });
        } else {
          const pid = insertRow(fid, "projects", { ...f, created_at: t, updated_at: t });
          addMember(fid, pid, mid, { role: "owner", trackId, lane: r.status === "Active" ? 2 : 1 });
          result.created++;
          tasksFromAction(r.action).forEach((title, i) => {
            insertRow(fid, "project_tasks", {
              project_id: pid, title, status: "todo", priority: 1, ...guessTaskShape(title),
              sort_order: i, created_at: t, updated_at: t,
            });
            result.tasksCreated++;
          });
        }
      }
    })();
    changed(fid);
    res.json(result);
  });

  // ---- Tasks ----
  app.post("/api/projects/:id/tasks", ...auth, (req, res) => {
    const project = visibleProject(req, req.params.id);
    if (!project) return res.status(404).json({ error: "project not found" });
    const f = taskFields(req, req.body || {}, project.id);
    if (!f.title) return res.status(400).json({ error: "title required" });
    const maxOrder = db.prepare("SELECT MAX(sort_order) AS m FROM project_tasks WHERE project_id = ? AND family_id = ?").get(project.id, req.familyId).m;
    const t = now();
    const id = insertRow(req.familyId, "project_tasks", {
      status: "todo", priority: 1, size: "s", energy: "medium",
      ...f, project_id: project.id, sort_order: f.sort_order ?? (maxOrder ?? -1) + 1,
      created_at: t, updated_at: t,
    });
    changed(req.familyId);
    res.json(taskRowToObj(getTask(req.familyId, id)));
  });

  app.put("/api/project-tasks/:id", ...auth, (req, res) => {
    const existing = visibleTask(req, req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    const b = req.body || {};
    let projectId = existing.project_id;
    if ("projectId" in b) {
      const target = visibleProject(req, b.projectId);
      if (!target) return res.status(400).json({ error: "unknown project" });
      projectId = target.id;
    }
    const f = withCompletion(taskFields(req, b, projectId), existing.status);
    if (f.depends_on && createsCycle(req.familyId, existing.id, JSON.parse(f.depends_on))) {
      return res.status(400).json({ error: "that dependency would create a cycle" });
    }
    if (projectId !== existing.project_id) {
      f.project_id = projectId;
      // An assignee who isn't on the new project can't keep the task.
      const a = f.assignee_id ?? existing.assignee_id;
      if (a && !membership(req.familyId, projectId, a)) f.assignee_id = "";
    }
    f.updated_at = now();
    updateRow(req.familyId, "project_tasks", existing.id, f);
    changed(req.familyId);
    res.json(taskRowToObj(getTask(req.familyId, existing.id)));
  });

  app.delete("/api/project-tasks/:id", ...auth, (req, res) => {
    const existing = visibleTask(req, req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    db.transaction(() => {
      // Drop the task from other tasks' dependency lists.
      for (const row of db.prepare("SELECT id, depends_on FROM project_tasks WHERE family_id = ? AND depends_on LIKE ?").all(req.familyId, `%${existing.id}%`)) {
        const deps = jsonOr(row.depends_on, []).filter((d) => d !== existing.id);
        updateRow(req.familyId, "project_tasks", row.id, { depends_on: JSON.stringify(deps), updated_at: now() });
      }
      for (const p of db.prepare("SELECT id FROM project_picks WHERE task_id = ? AND family_id = ?").all(existing.id, req.familyId)) {
        deleteRow(req.familyId, "project_picks", p.id);
      }
      deleteRow(req.familyId, "project_tasks", existing.id);
    })();
    changed(req.familyId);
    res.json({ ok: true });
  });

  // ---- External issues ----
  // Upsert external items (e.g. GitHub issues) as tasks, keyed by external_key. Only tasks in projects
  // the caller is on are matched, so syncing never touches (or reveals) anyone else's private projects.
  // `claim`: true for an epic link (its sub-issues belong to this project even if another of your
  // projects had them); false for a whole-repo link, which only picks up issues none of them has.
  function upsertExternal(req, project, source, repo, items, { claim = true } = {}) {
    const fid = req.familyId;
    const result = { created: 0, updated: 0, closed: 0, skipped: 0 };
    const t = now();
    const findTask = (key) => db.prepare(
      `SELECT t.* FROM project_tasks t JOIN project_members m ON m.project_id = t.project_id AND m.member_id = ? AND m.family_id = t.family_id
       WHERE t.family_id = ? AND t.external_type = ? AND t.external_key = ?`,
    ).get(req.memberId, fid, source, key);
    db.transaction(() => {
      for (const it of items.slice(0, 500)) {
        if (!it || !Number.isFinite(Number(it.number))) continue;
        const key = `${repo}#${Number(it.number)}`;
        const state = String(it.state || "").toLowerCase() === "closed" ? "closed" : "open";
        const labels = Array.isArray(it.labels) ? it.labels.map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean).slice(0, 20) : [];
        const row = findTask(key);
        if (row && row.project_id !== project.id && !claim) { result.skipped++; continue; }
        if (it.parentTitle) labels.unshift(str(it.parentTitle, 50));
        const base = {
          title: str(it.title, 300), external_url: str(it.url || it.html_url, 500),
          external_state: state, external_updated_at: str(it.updatedAt || it.updated_at, 40),
          labels: JSON.stringify(labels.map((l) => str(l, 50))),
        };
        if (row) {
          const f = {};
          for (const [k, v] of Object.entries(base)) if (row[k] !== v) f[k] = v;
          if (state === "closed" && !["done", "dropped"].includes(row.status)) { f.status = "done"; f.completed_at = t; result.closed++; }
          if (state === "open" && row.external_state === "closed" && row.status === "done") { f.status = "todo"; f.completed_at = ""; }
          if (row.project_id !== project.id && claim) {
            f.project_id = project.id;
            if (row.assignee_id && !membership(fid, project.id, row.assignee_id)) f.assignee_id = "";
          }
          if (Object.keys(f).length) { f.updated_at = t; updateRow(fid, "project_tasks", row.id, f); result.updated++; }
        } else {
          if (state === "closed") continue; // don't import history, only live work
          insertRow(fid, "project_tasks", {
            ...base, project_id: project.id, status: "todo", priority: 1, size: "m", energy: "medium",
            external_type: source, external_key: key, created_at: t, updated_at: t,
            sort_order: 1000 + Number(it.number),
          });
          result.created++;
        }
      }
      // Blocked-by edges become dependencies. Manual dependencies on non-external tasks are kept.
      for (const it of items) {
        if (!it || !Array.isArray(it.blockedBy)) continue;
        const row = findTask(`${repo}#${Number(it.number)}`);
        if (!row) continue;
        const manual = jsonOr(row.depends_on, []).filter((id) => {
          const d = getTask(fid, id);
          return d && !(d.external_type === source && d.external_key.startsWith(`${repo}#`));
        });
        const fromGh = it.blockedBy.map((n) => findTask(`${repo}#${Number(n)}`)?.id).filter(Boolean);
        const next = JSON.stringify([...new Set([...manual, ...fromGh])].filter((id) => id !== row.id));
        if (next !== row.depends_on) updateRow(fid, "project_tasks", row.id, { depends_on: next, updated_at: t });
      }
    })();
    return result;
  }

  // Push issues fetched elsewhere (e.g. by tools/projects with the gh CLI).
  app.post("/api/projects/:id/external-sync", ...auth, (req, res) => {
    const project = visibleProject(req, req.params.id);
    if (!project) return res.status(404).json({ error: "project not found" });
    const { source, repo, items } = req.body || {};
    if (source !== "github" || typeof repo !== "string" || !REPO_RE.test(repo) || !Array.isArray(items)) {
      return res.status(400).json({ error: "source 'github', repo 'owner/name' and items[] required" });
    }
    const result = upsertExternal(req, project, source, repo, items, { claim: req.body.claim !== false });
    changed(req.familyId);
    res.json(result);
  });

  // Fetch a project's linked GitHub repos server-side, using the caller's own token if they set one.
  app.post("/api/projects/:id/sync-github", ...auth, async (req, res) => {
    const project = visibleProject(req, req.params.id);
    if (!project) return res.status(404).json({ error: "project not found" });
    const links = jsonOr(project.links, []).filter((l) => l.type === "github");
    if (!links.length) return res.status(400).json({ error: "no GitHub repo linked" });
    const token = getToken(req);
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "parentslop-projects" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const total = { created: 0, updated: 0, closed: 0, repos: [] };
    const gh = async (path) => {
      const r = await fetch(`https://api.github.com/repos/${path}`, { headers });
      if (!r.ok) throw new Error(`GitHub returned ${r.status} for ${path}`);
      return r.json();
    };
    // Epics first, so their sub-issues are claimed before any whole-repo link looks at them.
    links.sort((a, b) => (b.issue ? 1 : 0) - (a.issue ? 1 : 0));
    for (const { repo, issue } of links) {
      try {
        let issues;
        if (issue) {
          issues = [];
          const walk = async (n, parentTitle, depth) => {
            if (depth > 6 || issues.length > 400) return;
            for (const s of await gh(`${repo}/issues/${n}/sub_issues?per_page=100`)) {
              const isEpic = (s.labels || []).some((l) => (l.name || l) === "epic");
              if (!isEpic) issues.push({ ...s, parentTitle });
              await walk(s.number, isEpic ? s.title : parentTitle, depth + 1);
            }
          };
          await walk(issue, "", 0);
          for (const it of issues) {
            try { it.blockedBy = (await gh(`${repo}/issues/${it.number}/dependencies/blocked_by`)).map((b) => b.number); } catch { /* API unavailable */ }
          }
        } else {
          issues = (await gh(`${repo}/issues?state=all&per_page=100&sort=updated`)).filter((i) => !i.pull_request);
        }
        const one = upsertExternal(req, project, "github", repo, issues, { claim: !!issue });
        total.created += one.created; total.updated += one.updated; total.closed += one.closed;
        total.repos.push({ repo, issue: issue || null, issues: issues.length });
      } catch (e) {
        total.repos.push({ repo, error: e.message });
      }
    }
    changed(req.familyId);
    res.json(total);
  });

  // ---- Daily picks (the caller's own) ----
  app.post("/api/project-picks", ...auth, (req, res) => {
    const { date, taskId } = req.body || {};
    if (!isDate(date)) return res.status(400).json({ error: "date YYYY-MM-DD required" });
    if (!visibleTask(req, taskId)) return res.status(404).json({ error: "task not found" });
    const dup = db.prepare("SELECT * FROM project_picks WHERE family_id = ? AND member_id = ? AND date = ? AND task_id = ?").get(req.familyId, req.memberId, date, taskId);
    if (dup) return res.json(pickRowToObj(dup));
    const id = insertRow(req.familyId, "project_picks", {
      member_id: req.memberId, date, task_id: taskId, outcome: "", note: "", created_at: now(),
    });
    changed(req.familyId);
    res.json(pickRowToObj(db.prepare("SELECT * FROM project_picks WHERE id = ?").get(id)));
  });

  const myPick = (req, id) => db.prepare("SELECT * FROM project_picks WHERE id = ? AND family_id = ? AND member_id = ?").get(id, req.familyId, req.memberId);

  app.put("/api/project-picks/:id", ...auth, (req, res) => {
    const existing = myPick(req, req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    const f = {};
    if ("outcome" in (req.body || {})) f.outcome = oneOf(req.body.outcome, PICK_OUTCOMES, "");
    if ("note" in (req.body || {})) f.note = str(req.body.note, 2000);
    updateRow(req.familyId, "project_picks", existing.id, f);
    // A pick marked done closes its task too (if you can still see it), and undoing that reopens it.
    if ("outcome" in f && f.outcome !== existing.outcome && (f.outcome === "done" || existing.outcome === "done")) {
      const task = visibleTask(req, existing.task_id);
      if (task && f.outcome === "done" && !["done", "dropped"].includes(task.status)) {
        updateRow(req.familyId, "project_tasks", task.id, { status: "done", completed_at: now(), updated_at: now() });
      } else if (task && f.outcome !== "done" && task.status === "done") {
        updateRow(req.familyId, "project_tasks", task.id, { status: "todo", completed_at: "", updated_at: now() });
      }
    }
    changed(req.familyId);
    res.json(pickRowToObj(db.prepare("SELECT * FROM project_picks WHERE id = ?").get(existing.id)));
  });

  app.delete("/api/project-picks/:id", ...auth, (req, res) => {
    const existing = myPick(req, req.params.id);
    if (!existing) return res.status(404).json({ error: "not found" });
    deleteRow(req.familyId, "project_picks", existing.id);
    changed(req.familyId);
    res.json({ ok: true });
  });
}

module.exports = { PROJECT_TABLES, initProjectsSchema, registerProjects, tasksFromAction };
