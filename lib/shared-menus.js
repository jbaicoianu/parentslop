/**
 * Shared menus: a potluck-style menu checklist (Thanksgiving dinner, a birthday party...) that a family
 * plans together with people outside the family, through a secret link.
 *
 * Access:
 *   - A menu belongs to one family (family_id) and goes through that family's event log like every
 *     other family table.
 *   - Family members reach it under /api/shared-menus/:id with their normal session. Any member can
 *     view and edit items; parents create menus, edit details, control the link and delete.
 *   - Anyone with the link (/m/<token>) reaches it under /api/m/:token. They join by typing a name;
 *     that creates a participant row and an httpOnly cookie (psm_<menu id>=<participant id>.<secret>,
 *     only a hash of the secret is stored). Turning link sharing off or making a new link locks guests out.
 *     A family member who opens the link while logged in is treated as a family member.
 *
 * Inside a menu everyone who has joined can add items, edit them and comment. People sign up to bring an
 * item (a row in shared_menu_claims) and tick off their own part when it's ready. An item wants one person
 * (the default), a set number, or anyone who likes (wanted = 0, e.g. wine). You sign yourself up and drop
 * out; family members can also assign or release anyone. Items and comments can be deleted by whoever
 * added them, or by a family member.
 */

const crypto = require("crypto");
const express = require("express");

const SHARED_MENU_TABLES = ["shared_menus", "shared_menu_participants", "shared_menu_items", "shared_menu_comments", "shared_menu_claims"];

const CATEGORIES = ["appetizers", "mains", "sides", "desserts", "drinks", "other"];
const LIMITS = {
  title: 120, notes: 2000, name: 40, itemName: 120, itemNotes: 1000, comment: 2000,
  items: 300, comments: 3000, participants: 50, wanted: 20,
};
// People's colors. No greens: green means "ready" on the menu.
const COLORS = ["#f59e0b", "#6366f1", "#ec4899", "#06b6d4", "#f97316", "#a855f7", "#60a5fa", "#ef4444", "#eab308", "#e879f9"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;

const TEMPLATES = {
  thanksgiving: [
    ["Roast turkey", "mains"], ["Gravy", "mains"],
    ["Stuffing", "sides"], ["Mashed potatoes", "sides"], ["Cranberry sauce", "sides"],
    ["Green bean casserole", "sides"], ["Sweet potatoes", "sides"], ["Dinner rolls & butter", "sides"],
    ["Cheese & crackers", "appetizers"],
    ["Pumpkin pie", "desserts"], ["Apple pie", "desserts"], ["Whipped cream", "desserts"],
    // Third value: how many people (0 = anyone who likes; default 1).
    ["Wine", "drinks", 0], ["Cider & sparkling water", "drinks", 0],
    ["Ice", "other"], ["To-go containers for leftovers", "other"],
  ],
};

function addColumn(db, table, col, def) {
  if (db.pragma(`table_info(${table})`).some((c) => c.name === col)) return;
  const crr = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(`${table}__crsql_itrig`);
  if (crr) db.exec(`SELECT crsql_begin_alter('${table}')`);
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  if (crr) db.exec(`SELECT crsql_commit_alter('${table}')`);
}

function initSharedMenusSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_menus (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      owner_id TEXT DEFAULT '',
      title TEXT DEFAULT '',
      event_date TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      share_token TEXT DEFAULT '',
      share_enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT ''
    )
  `);
  // member_id is set for family members (id "<menu id>:<member id>"), secret_hash for guests.
  // custom_name = 1 when a family member picked their own name for this menu (otherwise display_name
  // follows their family profile name).
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_menu_participants (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      menu_id TEXT DEFAULT '',
      member_id TEXT DEFAULT '',
      display_name TEXT DEFAULT '',
      color TEXT DEFAULT '',
      secret_hash TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      custom_name INTEGER DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_menu_items (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      menu_id TEXT DEFAULT '',
      name TEXT DEFAULT '',
      category TEXT DEFAULT 'other',
      notes TEXT DEFAULT '',
      claimed_by TEXT DEFAULT '',
      done INTEGER DEFAULT 0,
      added_by TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      wanted INTEGER DEFAULT 1
    )
  `);
  // Who's bringing what: one row per (item, person), id "<item id>:<participant id>" so concurrent
  // sign-ups converge. done = that person's part is ready. (claimed_by/done on items predate this table
  // and are migrated into it on first use.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_menu_claims (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      menu_id TEXT DEFAULT '',
      item_id TEXT DEFAULT '',
      participant_id TEXT DEFAULT '',
      done INTEGER DEFAULT 0,
      created_at TEXT DEFAULT ''
    )
  `);
  // item_id '' is the menu's general discussion.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_menu_comments (
      id TEXT NOT NULL PRIMARY KEY,
      family_id TEXT DEFAULT '',
      menu_id TEXT DEFAULT '',
      item_id TEXT DEFAULT '',
      participant_id TEXT DEFAULT '',
      body TEXT DEFAULT '',
      created_at TEXT DEFAULT ''
    )
  `);
  for (const table of SHARED_MENU_TABLES) {
    try { db.exec(`SELECT crsql_as_crr('${table}')`); } catch (e) {
      if (!e.message.includes("already")) throw e;
    }
  }
  // Databases created before per-menu names.
  addColumn(db, "shared_menu_participants", "custom_name", "INTEGER DEFAULT 0");
  // ...and before items could take more than one person.
  addColumn(db, "shared_menu_items", "wanted", "INTEGER DEFAULT 1");
  db.exec("CREATE INDEX IF NOT EXISTS shared_menus_token ON shared_menus (share_token)");
  db.exec("CREATE INDEX IF NOT EXISTS shared_menu_items_menu ON shared_menu_items (menu_id)");
  db.exec("CREATE INDEX IF NOT EXISTS shared_menu_comments_menu ON shared_menu_comments (menu_id)");
  db.exec("CREATE INDEX IF NOT EXISTS shared_menu_participants_menu ON shared_menu_participants (menu_id)");
  db.exec("CREATE INDEX IF NOT EXISTS shared_menu_claims_menu ON shared_menu_claims (menu_id)");
}

// --- Helpers -------------------------------------------------------------------

const newToken = () => crypto.randomBytes(18).toString("base64url");
const hashSecret = (s) => crypto.createHash("sha256").update(s).digest("hex");
const cookieName = (menuId) => `psm_${menuId}`;

/** Trimmed string clipped to max, or undefined when v isn't a string. */
function str(v, max) {
  if (typeof v !== "string") return undefined;
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

function menuRowToObj(r) {
  return { id: r.id, title: r.title, eventDate: r.event_date, notes: r.notes, ownerId: r.owner_id,
    shareEnabled: !!r.share_enabled, createdAt: r.created_at, updatedAt: r.updated_at };
}
function participantRowToObj(r) {
  return { id: r.id, name: r.display_name, color: r.color, kind: r.member_id ? "member" : "guest", createdAt: r.created_at };
}
// claims: this item's shared_menu_claims rows, oldest first.
function itemRowToObj(r, claims = []) {
  const wanted = r.wanted == null ? 1 : r.wanted;
  const cl = claims.map((c) => ({ participantId: c.participant_id, done: !!c.done, createdAt: c.created_at }));
  const covered = cl.length > 0 && (wanted === 0 || cl.length >= wanted);
  return {
    id: r.id, name: r.name, category: r.category, notes: r.notes, wanted, claims: cl,
    covered, ready: covered && cl.every((c) => c.done),
    // For pages loaded before multi-person items: the first person on it, and "ready".
    claimedBy: cl[0]?.participantId || null, done: covered && cl.every((c) => c.done),
    addedBy: r.added_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function commentRowToObj(r) {
  return { id: r.id, itemId: r.item_id || null, participantId: r.participant_id, body: r.body, createdAt: r.created_at };
}

function registerSharedMenus({ app, db, emitEvent, broadcastSSE, requireFamilyAuth, getSession, rateLimit }) {
  const now = () => new Date().toISOString();

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

  const getMember = (fid, mid) => mid && db.prepare("SELECT * FROM family_members WHERE id = ? AND family_id = ?").get(mid, fid);
  const getItem = (menu, id) => db.prepare("SELECT * FROM shared_menu_items WHERE id = ? AND menu_id = ? AND family_id = ?").get(id, menu.id, menu.family_id);
  const participants = (menu) => db.prepare("SELECT * FROM shared_menu_participants WHERE menu_id = ? AND family_id = ? ORDER BY created_at").all(menu.id, menu.family_id);
  const nextColor = (menu) => COLORS[participants(menu).length % COLORS.length];
  const claimsOf = (item) => db.prepare("SELECT * FROM shared_menu_claims WHERE item_id = ? AND family_id = ? ORDER BY created_at, id").all(item.id, item.family_id);
  const itemOut = (item) => itemRowToObj(item, claimsOf(item));
  const isParticipant = (menu, pid) => !!db.prepare("SELECT 1 FROM shared_menu_participants WHERE id = ? AND menu_id = ?").get(pid, menu.id);
  const parseWanted = (v) => (Number.isInteger(v) && v >= 0 && v <= LIMITS.wanted ? v : undefined);

  // Items used to hold one claim (claimed_by/done). Move those into shared_menu_claims, once per process
  // (it's idempotent: migrated items have claimed_by cleared). Runs lazily because the database is
  // loaded after routes are registered.
  let migrated = false;
  function migrateLegacyClaims() {
    if (migrated) return;
    migrated = true;
    try {
      const legacy = db.prepare("SELECT * FROM shared_menu_items WHERE claimed_by != '' OR done != 0").all();
      if (!legacy.length) return;
      db.transaction(() => {
        for (const item of legacy) {
          if (item.claimed_by) {
            const id = `${item.id}:${item.claimed_by}`;
            if (!db.prepare("SELECT 1 FROM shared_menu_claims WHERE id = ?").get(id)) {
              insertRow(item.family_id, "shared_menu_claims", {
                id, menu_id: item.menu_id, item_id: item.id, participant_id: item.claimed_by, done: item.done ? 1 : 0, created_at: item.updated_at || now(),
              });
            }
          }
          updateRow(item.family_id, "shared_menu_items", item.id, { claimed_by: "", done: 0 });
        }
      })();
      console.log(`Shared menus: moved ${legacy.length} item claims into shared_menu_claims`);
    } catch (e) {
      migrated = false;
      console.error("Shared menus claim migration failed:", e.message);
    }
  }
  const migrateOnce = (req, res, next) => { migrateLegacyClaims(); next(); };

  // The participant row for a family member, created on demand. Unless they picked their own name for
  // this menu, it follows their family profile name.
  function memberParticipant(menu, member) {
    const id = `${menu.id}:${member.id}`;
    const row = db.prepare("SELECT * FROM shared_menu_participants WHERE id = ?").get(id);
    if (!row) {
      insertRow(menu.family_id, "shared_menu_participants", {
        id, menu_id: menu.id, member_id: member.id, display_name: member.display_name, color: nextColor(menu), created_at: now(),
      });
      return db.prepare("SELECT * FROM shared_menu_participants WHERE id = ?").get(id);
    }
    if (!row.custom_name && row.display_name !== member.display_name) {
      updateRow(menu.family_id, "shared_menu_participants", id, { display_name: member.display_name });
      row.display_name = member.display_name;
    }
    return row;
  }

  // Set a family member's name on one menu. Blank (or their family name) goes back to following the profile.
  function setMemberName(menu, member, participant, name) {
    const f = !name || name === member.display_name
      ? { display_name: member.display_name, custom_name: 0 }
      : { display_name: name, custom_name: 1 };
    if (f.display_name === participant.display_name && f.custom_name === (participant.custom_name ? 1 : 0)) return participant;
    updateRow(menu.family_id, "shared_menu_participants", participant.id, f);
    return { ...participant, ...f };
  }

  function guestParticipant(req, menu) {
    const raw = req.cookies?.[cookieName(menu.id)];
    if (!raw || typeof raw !== "string") return null;
    const dot = raw.indexOf(".");
    if (dot < 1) return null;
    const pid = raw.slice(0, dot);
    const row = db.prepare("SELECT * FROM shared_menu_participants WHERE id = ? AND menu_id = ? AND family_id = ? AND member_id = ''")
      .get(pid, menu.id, menu.family_id);
    if (!row || !row.secret_hash) return null;
    const a = Buffer.from(hashSecret(raw.slice(dot + 1)), "hex");
    const b = Buffer.from(row.secret_hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? row : null;
  }

  // Live updates: one stream per menu (family members and guests alike).
  const menuClients = new Map(); // menu id -> Set<{ res, guest }>
  function changed(menu) {
    const set = menuClients.get(menu.id);
    if (set) for (const c of set) { try { c.res.write("event: menu:changed\ndata: {}\n\n"); } catch { set.delete(c); } }
    broadcastSSE(menu.family_id, "shared-menus:changed", { id: menu.id });
  }
  function dropGuestStreams(menu) {
    const set = menuClients.get(menu.id);
    if (!set) return;
    for (const c of [...set]) if (c.guest) { set.delete(c); try { c.res.end(); } catch {} }
  }

  // ---- Access resolution ----
  // req.sm = { menu, host, member, isParent, me }  (me: participant row or null)

  function hostContext(menu, member) {
    return { menu, host: true, member, isParent: !!member?.is_admin, me: member ? memberParticipant(menu, member) : null };
  }

  function resolveById(req, res, next) {
    const menu = db.prepare("SELECT * FROM shared_menus WHERE id = ? AND family_id = ?").get(req.params.menuId, req.familyId);
    if (!menu) return res.status(404).json({ error: "menu not found" });
    req.sm = hostContext(menu, getMember(req.familyId, req.memberId));
    next();
  }

  function resolveByToken(req, res, next) {
    const token = req.params.token;
    const menu = typeof token === "string" && token.length >= 16 && token.length <= 64
      && db.prepare("SELECT * FROM shared_menus WHERE share_token = ?").get(token);
    // A family member who follows the link while logged in counts as a family member.
    const session = getSession(req.cookies?.session);
    if (menu && session && session.family_id === menu.family_id) {
      req.sm = hostContext(menu, getMember(menu.family_id, session.member_id));
      return next();
    }
    if (!menu || !menu.share_enabled) return res.status(404).json({ error: "This link doesn't work any more. Ask for a new one." });
    req.sm = { menu, host: false, member: null, isParent: false, me: guestParticipant(req, menu) };
    next();
  }

  const requireJoined = (req, res, next) => {
    if (!req.sm.me) return res.status(403).json({ error: req.sm.host ? "pick a family member first" : "join first", needsJoin: !req.sm.host });
    next();
  };
  const requireHost = (req, res, next) => (req.sm.host ? next() : res.status(403).json({ error: "only the hosts can do that" }));
  const requireParent = (req, res, next) => (req.sm.isParent ? next() : res.status(403).json({ error: "parents only" }));

  function itemsWithClaims(menu) {
    const byItem = new Map();
    for (const c of db.prepare("SELECT * FROM shared_menu_claims WHERE menu_id = ? AND family_id = ? ORDER BY created_at, id").all(menu.id, menu.family_id)) {
      if (!byItem.has(c.item_id)) byItem.set(c.item_id, []);
      byItem.get(c.item_id).push(c);
    }
    return db.prepare("SELECT * FROM shared_menu_items WHERE menu_id = ? AND family_id = ? ORDER BY created_at").all(menu.id, menu.family_id)
      .map((i) => itemRowToObj(i, byItem.get(i.id) || []));
  }

  function stateFor(req) {
    const { menu, host, me, isParent, member } = req.sm;
    const fid = menu.family_id;
    return {
      // Family members: their profile name, and whether they picked a different one for this menu.
      profileName: host && member ? member.display_name : undefined,
      customName: host && me ? !!me.custom_name : undefined,
      menu: { ...menuRowToObj(menu), sharePath: host ? `/m/${menu.share_token}` : undefined },
      participants: participants(menu).map(participantRowToObj),
      items: itemsWithClaims(menu),
      comments: db.prepare("SELECT * FROM shared_menu_comments WHERE menu_id = ? AND family_id = ? ORDER BY created_at").all(menu.id, fid).map(commentRowToObj),
      me: me ? me.id : null,
      host,
      canManage: host && isParent,
      categories: CATEGORIES,
    };
  }

  // ---- Family-side list / create ----

  const familyAuth = [requireFamilyAuth];

  app.get("/api/shared-menus", ...familyAuth, migrateOnce, (req, res) => {
    const rows = db.prepare("SELECT * FROM shared_menus WHERE family_id = ? ORDER BY event_date DESC, created_at DESC").all(req.familyId);
    const guests = db.prepare("SELECT COUNT(*) AS n FROM shared_menu_participants WHERE menu_id = ? AND family_id = ? AND member_id = ''");
    res.json(rows.map((r) => {
      const items = itemsWithClaims(r);
      return {
        ...menuRowToObj(r), itemCount: items.length, claimedCount: items.filter((i) => i.covered).length,
        doneCount: items.filter((i) => i.ready).length, guestCount: guests.get(r.id, req.familyId).n,
      };
    }));
  });

  app.post("/api/shared-menus", ...familyAuth, migrateOnce, (req, res) => {
    const member = getMember(req.familyId, req.memberId);
    if (!member || !member.is_admin) return res.status(403).json({ error: "parents only" });
    const b = req.body || {};
    const title = str(b.title, LIMITS.title);
    if (!title) return res.status(400).json({ error: "title required" });
    const eventDate = str(b.eventDate, 10) || "";
    if (eventDate && !DATE_RE.test(eventDate)) return res.status(400).json({ error: "eventDate must be YYYY-MM-DD" });
    const t = now();
    const id = crypto.randomUUID();
    db.transaction(() => {
      insertRow(req.familyId, "shared_menus", {
        id, owner_id: member.id, title, event_date: eventDate, notes: str(b.notes, LIMITS.notes) || "",
        share_token: newToken(), share_enabled: 1, created_at: t, updated_at: t,
      });
      const menu = db.prepare("SELECT * FROM shared_menus WHERE id = ?").get(id);
      let me = memberParticipant(menu, member);
      // Optional name to show on this menu instead of the family profile name ("James" rather than "Dad").
      const displayName = str(b.displayName, LIMITS.name);
      if (displayName) me = setMemberName(menu, member, me, displayName);
      const template = TEMPLATES[b.template] || [];
      template.forEach(([name, category, wanted = 1], i) => {
        // Spread created_at by a millisecond so the template keeps its order.
        const ts = new Date(Date.parse(t) + i + 1).toISOString();
        insertRow(req.familyId, "shared_menu_items", { menu_id: id, name, category, wanted, added_by: me.id, created_at: ts, updated_at: ts });
      });
    })();
    const menu = db.prepare("SELECT * FROM shared_menus WHERE id = ?").get(id);
    broadcastSSE(req.familyId, "shared-menus:changed", { id });
    res.json({ ...menuRowToObj(menu), sharePath: `/m/${menu.share_token}` });
  });

  // ---- One menu (same handlers for family members and link guests) ----

  const r = express.Router({ mergeParams: true });

  r.get("/state", (req, res) => res.json(stateFor(req)));

  r.get("/stream", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(":\n\n");
    const id = req.sm.menu.id;
    if (!menuClients.has(id)) menuClients.set(id, new Set());
    const client = { res, guest: !req.sm.host };
    menuClients.get(id).add(client);
    const keepAlive = setInterval(() => { try { res.write(":\n\n"); } catch {} }, 30000);
    req.on("close", () => {
      clearInterval(keepAlive);
      const set = menuClients.get(id);
      if (set) { set.delete(client); if (set.size === 0) menuClients.delete(id); }
    });
  });

  // Change how you show up on this menu. Family members can clear it to go back to their profile name.
  r.put("/me", requireJoined, (req, res) => {
    const { menu, host, member } = req.sm;
    const name = str(req.body?.name, LIMITS.name) || "";
    if (host) {
      req.sm.me = setMemberName(menu, member, req.sm.me, name);
    } else {
      if (!name) return res.status(400).json({ error: "name required" });
      if (name !== req.sm.me.display_name) {
        updateRow(menu.family_id, "shared_menu_participants", req.sm.me.id, { display_name: name });
        req.sm.me = { ...req.sm.me, display_name: name };
      }
    }
    changed(menu);
    res.json(stateFor(req));
  });

  // Guests join (or rename themselves) with a display name.
  r.post("/join", (req, res) => {
    const { menu, host } = req.sm;
    if (host) return res.status(400).json({ error: "family members are already on the menu" });
    const name = str(req.body?.name, LIMITS.name);
    if (!name) return res.status(400).json({ error: "name required" });
    if (req.sm.me) {
      updateRow(menu.family_id, "shared_menu_participants", req.sm.me.id, { display_name: name });
    } else {
      if (participants(menu).length >= LIMITS.participants) return res.status(400).json({ error: "this menu has too many people on it" });
      const secret = crypto.randomBytes(24).toString("base64url");
      const id = crypto.randomUUID();
      insertRow(menu.family_id, "shared_menu_participants", {
        id, menu_id: menu.id, display_name: name, color: nextColor(menu), secret_hash: hashSecret(secret), created_at: now(),
      });
      res.cookie(cookieName(menu.id), `${id}.${secret}`, {
        httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: COOKIE_MAX_AGE, path: "/",
      });
      req.sm.me = db.prepare("SELECT * FROM shared_menu_participants WHERE id = ?").get(id);
    }
    changed(menu);
    res.json(stateFor(req));
  });

  // Menu details: family members.
  r.put("/", requireHost, requireJoined, (req, res) => {
    const { menu } = req.sm;
    const b = req.body || {};
    const f = {};
    if (b.title !== undefined) {
      const title = str(b.title, LIMITS.title);
      if (!title) return res.status(400).json({ error: "title required" });
      f.title = title;
    }
    if (b.eventDate !== undefined) {
      const d = str(b.eventDate, 10) || "";
      if (d && !DATE_RE.test(d)) return res.status(400).json({ error: "eventDate must be YYYY-MM-DD" });
      f.event_date = d;
    }
    if (b.notes !== undefined) f.notes = str(b.notes, LIMITS.notes) || "";
    if (Object.keys(f).length) {
      f.updated_at = now();
      updateRow(menu.family_id, "shared_menus", menu.id, f);
      Object.assign(menu, f);
    }
    changed(menu);
    res.json(stateFor(req));
  });

  // Link controls: parents. { enabled: bool } and/or { regenerate: true }.
  r.post("/share", requireHost, requireParent, (req, res) => {
    const { menu } = req.sm;
    const b = req.body || {};
    const f = {};
    if (typeof b.enabled === "boolean") f.share_enabled = b.enabled ? 1 : 0;
    if (b.regenerate === true) f.share_token = newToken();
    if (Object.keys(f).length) {
      f.updated_at = now();
      updateRow(menu.family_id, "shared_menus", menu.id, f);
      Object.assign(menu, f);
      if (f.share_token || f.share_enabled === 0) dropGuestStreams(menu);
    }
    changed(menu);
    res.json(stateFor(req));
  });

  r.delete("/", requireHost, requireParent, (req, res) => {
    const { menu } = req.sm;
    const fid = menu.family_id;
    dropGuestStreams(menu);
    db.transaction(() => {
      for (const t of ["shared_menu_comments", "shared_menu_claims", "shared_menu_items", "shared_menu_participants"]) {
        for (const row of db.prepare(`SELECT id FROM ${t} WHERE menu_id = ? AND family_id = ?`).all(menu.id, fid)) deleteRow(fid, t, row.id);
      }
      deleteRow(fid, "shared_menus", menu.id);
    })();
    changed(menu);
    res.json({ ok: true });
  });

  // ---- Items ----

  // Sign someone up for an item. Returns [status, error] or null. Guests can only sign themselves up;
  // family members can sign anyone up, and on a one-person item that replaces whoever had it.
  function addClaim(req, item, pid) {
    const { menu, me, host } = req.sm;
    if (!pid || !isParticipant(menu, pid)) return [403, "unknown participant"];
    if (pid !== me.id && !host) return [403, "you can only sign yourself up"];
    const claims = claimsOf(item);
    if (claims.some((c) => c.participant_id === pid)) return null;
    const wanted = item.wanted == null ? 1 : item.wanted;
    if (wanted > 0 && claims.length >= wanted) {
      if (!(host && wanted === 1)) return [403, wanted === 1 ? "someone else has already claimed that" : "that's covered already"];
      for (const c of claims) deleteRow(menu.family_id, "shared_menu_claims", c.id);
    }
    insertRow(menu.family_id, "shared_menu_claims", {
      id: `${item.id}:${pid}`, menu_id: menu.id, item_id: item.id, participant_id: pid, done: 0, created_at: now(),
    });
    return null;
  }

  // Take someone off an item: yourself, or anyone if you're family.
  function removeClaim(req, item, pid) {
    const { menu, me, host } = req.sm;
    if (pid !== me.id && !host) return [403, "you can't take someone else off it"];
    const claim = claimsOf(item).find((c) => c.participant_id === pid);
    if (claim) deleteRow(menu.family_id, "shared_menu_claims", claim.id);
    return null;
  }

  // Mark someone's part ready (or not): your own, or anyone's if you're family.
  function setClaimDone(req, item, pid, done) {
    const { menu, me, host } = req.sm;
    if (pid !== me.id && !host) return [403, "only whoever's bringing it can mark it ready"];
    const claim = claimsOf(item).find((c) => c.participant_id === pid);
    if (!claim) return [404, "they aren't bringing this"];
    if (!!claim.done !== done) updateRow(menu.family_id, "shared_menu_claims", claim.id, { done: done ? 1 : 0 });
    return null;
  }

  const itemFor = (req, res) => {
    const item = getItem(req.sm.menu, req.params.itemId);
    if (!item) res.status(404).json({ error: "item not found" });
    return item;
  };
  const pidParam = (req) => (req.params.pid === "me" ? req.sm.me.id : req.params.pid);

  r.post("/items", requireJoined, (req, res) => {
    const { menu, me, host } = req.sm;
    const b = req.body || {};
    const name = str(b.name, LIMITS.itemName);
    if (!name) return res.status(400).json({ error: "name required" });
    const count = db.prepare("SELECT COUNT(*) AS n FROM shared_menu_items WHERE menu_id = ? AND family_id = ?").get(menu.id, menu.family_id).n;
    if (count >= LIMITS.items) return res.status(400).json({ error: "this menu is full" });
    const wanted = b.wanted === undefined ? 1 : parseWanted(b.wanted);
    if (wanted === undefined) return res.status(400).json({ error: `wanted must be 0 (anyone) to ${LIMITS.wanted}` });
    const claimFor = b.claimedBy === undefined || b.claimedBy === null || b.claimedBy === "" ? null : String(b.claimedBy);
    if (claimFor && ((claimFor !== me.id && !host) || !isParticipant(menu, claimFor))) return res.status(403).json({ error: "you can only sign yourself up" });
    const t = now();
    let id;
    db.transaction(() => {
      id = insertRow(menu.family_id, "shared_menu_items", {
        menu_id: menu.id, name, category: CATEGORIES.includes(b.category) ? b.category : "other",
        notes: str(b.notes, LIMITS.itemNotes) || "", wanted, added_by: me.id, created_at: t, updated_at: t,
      });
      if (claimFor) addClaim(req, getItem(menu, id), claimFor);
    })();
    changed(menu);
    res.json(itemOut(getItem(menu, id)));
  });

  r.put("/items/:itemId", requireJoined, (req, res) => {
    const { menu, me, host } = req.sm;
    const item = itemFor(req, res);
    if (!item) return;
    const b = req.body || {};
    const f = {};
    if (b.name !== undefined) {
      const name = str(b.name, LIMITS.itemName);
      if (!name) return res.status(400).json({ error: "name required" });
      f.name = name;
    }
    if (b.category !== undefined) {
      if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: "bad category" });
      f.category = b.category;
    }
    if (b.notes !== undefined) f.notes = str(b.notes, LIMITS.itemNotes) || "";
    if (b.wanted !== undefined) {
      const wanted = parseWanted(b.wanted);
      if (wanted === undefined) return res.status(400).json({ error: `wanted must be 0 (anyone) to ${LIMITS.wanted}` });
      f.wanted = wanted;
    }

    // claimedBy / done: the one-person API from before multi-person items (pages loaded earlier still use it).
    let err = null;
    db.transaction(() => {
      if (b.claimedBy !== undefined) {
        const to = b.claimedBy === null || b.claimedBy === "" ? null : String(b.claimedBy);
        const claims = claimsOf(item);
        if (to) {
          err = addClaim(req, item, to);
        } else if (host) {
          for (const c of claims) deleteRow(menu.family_id, "shared_menu_claims", c.id);
        } else if (claims.some((c) => c.participant_id === me.id)) {
          err = removeClaim(req, item, me.id);
        } else if (claims.length) {
          err = [403, "you can't take someone else off it"];
        }
      }
      if (!err && b.done !== undefined) {
        const claims = claimsOf(item);
        if (claims.some((c) => c.participant_id === me.id)) err = setClaimDone(req, item, me.id, !!b.done);
        else if (host) for (const c of claims) setClaimDone(req, item, c.participant_id, !!b.done);
        else err = [403, "only whoever's bringing it can mark it ready"];
      }
      if (!err && Object.keys(f).length) {
        f.updated_at = now();
        updateRow(menu.family_id, "shared_menu_items", item.id, f);
      }
    })();
    if (err) return res.status(err[0]).json({ error: err[1] });
    changed(menu);
    res.json(itemOut(getItem(menu, item.id)));
  });

  // Sign up: { participantId } (default: yourself).
  r.post("/items/:itemId/claims", requireJoined, (req, res) => {
    const item = itemFor(req, res);
    if (!item) return;
    const err = addClaim(req, item, req.body?.participantId ? String(req.body.participantId) : req.sm.me.id);
    if (err) return res.status(err[0]).json({ error: err[1] });
    changed(req.sm.menu);
    res.json(itemOut(item));
  });

  // { done } for one person's part (":pid" may be "me").
  r.put("/items/:itemId/claims/:pid", requireJoined, (req, res) => {
    const item = itemFor(req, res);
    if (!item) return;
    const err = setClaimDone(req, item, pidParam(req), !!req.body?.done);
    if (err) return res.status(err[0]).json({ error: err[1] });
    changed(req.sm.menu);
    res.json(itemOut(item));
  });

  r.delete("/items/:itemId/claims/:pid", requireJoined, (req, res) => {
    const item = itemFor(req, res);
    if (!item) return;
    const err = removeClaim(req, item, pidParam(req));
    if (err) return res.status(err[0]).json({ error: err[1] });
    changed(req.sm.menu);
    res.json(itemOut(item));
  });

  r.delete("/items/:itemId", requireJoined, (req, res) => {
    const { menu, me, host } = req.sm;
    const item = itemFor(req, res);
    if (!item) return;
    if (!host && item.added_by !== me.id) return res.status(403).json({ error: "only whoever added it (or the hosts) can remove it" });
    db.transaction(() => {
      for (const c of db.prepare("SELECT id FROM shared_menu_comments WHERE item_id = ? AND menu_id = ?").all(item.id, menu.id)) {
        deleteRow(menu.family_id, "shared_menu_comments", c.id);
      }
      for (const c of claimsOf(item)) deleteRow(menu.family_id, "shared_menu_claims", c.id);
      deleteRow(menu.family_id, "shared_menu_items", item.id);
    })();
    changed(menu);
    res.json({ ok: true });
  });

  // ---- Comments ----

  r.post("/comments", requireJoined, (req, res) => {
    const { menu, me } = req.sm;
    const body = str(req.body?.body, LIMITS.comment);
    if (!body) return res.status(400).json({ error: "comment is empty" });
    const itemId = req.body?.itemId ? String(req.body.itemId) : "";
    if (itemId && !getItem(menu, itemId)) return res.status(404).json({ error: "item not found" });
    const count = db.prepare("SELECT COUNT(*) AS n FROM shared_menu_comments WHERE menu_id = ? AND family_id = ?").get(menu.id, menu.family_id).n;
    if (count >= LIMITS.comments) return res.status(400).json({ error: "too many comments on this menu" });
    const id = insertRow(menu.family_id, "shared_menu_comments", {
      menu_id: menu.id, item_id: itemId, participant_id: me.id, body, created_at: now(),
    });
    changed(menu);
    res.json(commentRowToObj(db.prepare("SELECT * FROM shared_menu_comments WHERE id = ?").get(id)));
  });

  r.delete("/comments/:commentId", requireJoined, (req, res) => {
    const { menu, me, host } = req.sm;
    const c = db.prepare("SELECT * FROM shared_menu_comments WHERE id = ? AND menu_id = ? AND family_id = ?").get(req.params.commentId, menu.id, menu.family_id);
    if (!c) return res.status(404).json({ error: "comment not found" });
    if (!host && c.participant_id !== me.id) return res.status(403).json({ error: "you can only delete your own comments" });
    deleteRow(menu.family_id, "shared_menu_comments", c.id);
    changed(menu);
    res.json({ ok: true });
  });

  // Guests are throttled per link: the server sits behind a load balancer without trust proxy, so IPs
  // aren't meaningful. The token itself is 144 random bits; this only curbs spam through a leaked link.
  const byToken = { keyGenerator: (req) => `menu:${req.params.token}`, standardHeaders: true, legacyHeaders: false };
  const guestLimiter = rateLimit({ ...byToken, windowMs: 60 * 1000, max: 600, message: { error: "slow down a little" } });
  const joinLimiter = rateLimit({ ...byToken, windowMs: 60 * 60 * 1000, max: 30, message: { error: "too many people joined this menu just now, try again later" } });

  app.use("/api/shared-menus/:menuId", requireFamilyAuth, migrateOnce, resolveById, r);
  app.use("/api/m/:token", guestLimiter, (req, res, next) => (req.method === "POST" && req.path === "/join" ? joinLimiter(req, res, next) : next()), migrateOnce, resolveByToken, r);
}

module.exports = { SHARED_MENU_TABLES, CATEGORIES, TEMPLATES, initSharedMenusSchema, registerSharedMenus };
