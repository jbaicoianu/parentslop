/**
 * Applies CRDT events to the local SQLite database using Last-Writer-Wins (LWW) semantics.
 *
 * Each field in an event has a version number (ver). A field is only applied
 * if its version exceeds the currently stored version in field_versions.
 */

// Tables that participate in the event log
const EVENT_TABLES = new Set([
  "stores", "feedback", "tasks", "users", "currencies", "shop_items",
  "completions", "redemptions", "balance_adjustments", "job_claims", "worklog_entries",
]);

// Primary key column for each event table
const PK_COL = {
  stores: "key",
  feedback: "id",
  tasks: "id",
  users: "id",
  currencies: "id",
  shop_items: "id",
  completions: "id",
  redemptions: "id",
  balance_adjustments: "id",
  job_claims: "id",
  worklog_entries: "id",
};

// Tables whose changes affect derived user_balances
const BALANCE_TABLES = new Set(["completions", "redemptions", "balance_adjustments"]);

function initFieldVersionsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS field_versions (
      tbl TEXT NOT NULL,
      pk TEXT NOT NULL,
      col TEXT NOT NULL,
      ver INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tbl, pk, col)
    )
  `);
}

/**
 * Get the current LWW version for a field. Returns 0 if not yet tracked.
 */
function getFieldVersion(db, table, pk, col) {
  const row = db.prepare(
    "SELECT ver FROM field_versions WHERE tbl = ? AND pk = ? AND col = ?"
  ).get(table, pk, col);
  return row ? row.ver : 0;
}

/**
 * Build event fields from a data object, assigning next (incremented) versions.
 * Returns { colName: { v: value, ver: nextVer }, ... }
 */
function buildFields(db, table, pk, data) {
  const pkCol = PK_COL[table] || "id";
  const fields = {};
  for (const [col, value] of Object.entries(data)) {
    if (col === pkCol) continue; // PK is in the event's pk field, not in fields
    const ver = getFieldVersion(db, table, pk, col) + 1;
    fields[col] = { v: value, ver };
  }
  return fields;
}

/**
 * Persist field version bumps to the local field_versions table.
 */
function updateFieldVersions(db, table, pk, fields) {
  const upsert = db.prepare(
    "INSERT INTO field_versions (tbl, pk, col, ver) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(tbl, pk, col) DO UPDATE SET ver = excluded.ver"
  );
  for (const [col, { ver }] of Object.entries(fields)) {
    upsert.run(table, pk, col, ver);
  }
}

/**
 * Clear field versions for a deleted row.
 */
function clearFieldVersions(db, table, pk) {
  db.prepare("DELETE FROM field_versions WHERE tbl = ? AND pk = ?").run(table, pk);
}

/**
 * Apply a single event to SQLite with LWW semantics.
 *
 * Events come in two formats:
 *   - `data` (flat key-value): used for inserts. All fields treated as ver=1.
 *   - `fields` (LWW versioned `{col: {v, ver}}`): used for updates.
 *
 * The `family_id` from the event envelope is injected into the row data
 * if the table has a family_id column and it's not already present.
 *
 * Returns true if any changes were made.
 */
function applyEvent(db, event) {
  const { table, pk, op } = event;
  if (!EVENT_TABLES.has(table)) return false;

  const pkCol = PK_COL[table] || "id";

  if (op === "delete") {
    db.prepare(`DELETE FROM "${table}" WHERE "${pkCol}" = ?`).run(pk);
    clearFieldVersions(db, table, pk);
    return true;
  }

  // Normalize: convert flat `data` to LWW `fields` with ver=1
  let fields = event.fields;
  if (!fields && event.data) {
    fields = {};
    for (const [col, value] of Object.entries(event.data)) {
      if (col === pkCol) continue;
      fields[col] = { v: value, ver: 1 };
    }
    // Inject family_id from envelope if not in data
    if (event.family_id && !fields.family_id) {
      fields.family_id = { v: event.family_id, ver: 1 };
    }
  }

  if (!fields || Object.keys(fields).length === 0) return false;

  // Determine which fields win LWW (event version > current version)
  const winners = {};
  for (const [col, { v, ver }] of Object.entries(fields)) {
    const curVer = getFieldVersion(db, table, pk, col);
    if (ver > curVer) {
      winners[col] = { v, ver };
    }
  }

  if (Object.keys(winners).length === 0) return false;

  const exists = db.prepare(`SELECT 1 FROM "${table}" WHERE "${pkCol}" = ?`).get(pk);

  if (!exists) {
    // INSERT: pk + all winning fields
    const cols = [pkCol, ...Object.keys(winners)];
    const vals = [pk, ...Object.values(winners).map(f => f.v)];
    const ph = cols.map(() => "?").join(", ");
    db.prepare(
      `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(", ")}) VALUES (${ph})`
    ).run(...vals);
  } else {
    // UPDATE: only winning fields
    const sets = Object.keys(winners).map(c => `"${c}" = ?`).join(", ");
    const vals = [...Object.values(winners).map(f => f.v), pk];
    db.prepare(`UPDATE "${table}" SET ${sets} WHERE "${pkCol}" = ?`).run(...vals);
  }

  // Persist field versions
  updateFieldVersions(db, table, pk, winners);

  return true;
}

module.exports = {
  EVENT_TABLES,
  PK_COL,
  BALANCE_TABLES,
  initFieldVersionsTable,
  getFieldVersion,
  buildFields,
  updateFieldVersions,
  clearFieldVersions,
  applyEvent,
};
