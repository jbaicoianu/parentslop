#!/usr/bin/env node
/**
 * Recover lost data from S3 backup .db files by comparing against a live JSON export.
 *
 * Usage:
 *   node tools/recover-data.js                          # dry-run report
 *   node tools/recover-data.js --apply --db path.db     # insert into a SQLite DB
 *
 * Options:
 *   --live-json <path>   Live snapshot JSON (default: parentslop-backup-2026-03-30.json)
 *   --backup-dir <path>  Directory of backup .db files (default: /tmp/parentslop-backups/all)
 *   --apply              Actually insert recovered rows (requires --db)
 *   --db <path>          Target SQLite DB for --apply mode
 *   --family <id>        Only recover data for this family (default: all families)
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// --- CLI args ---
const args = process.argv.slice(2);
function arg(name, defaultVal) {
  const idx = args.indexOf(name);
  if (idx === -1) return defaultVal;
  return args[idx + 1];
}
const hasFlag = (name) => args.includes(name);

const LIVE_JSON = arg("--live-json", "parentslop-backup-2026-03-30.json");
const BACKUP_DIR = arg("--backup-dir", "/tmp/parentslop-backups/all");
const APPLY = hasFlag("--apply");
const TARGET_DB = arg("--db", null);
const FAMILY_FILTER = arg("--family", null);

if (APPLY && !TARGET_DB) {
  console.error("Error: --apply requires --db <path>");
  process.exit(1);
}

// --- Load live JSON ---
console.log(`Loading live snapshot: ${LIVE_JSON}`);
const live = JSON.parse(fs.readFileSync(LIVE_JSON, "utf8"));

// Build sets of known IDs from the live data
const liveIds = {
  completions: new Set(live.completions.map((c) => c.id)),
  worklog: new Set((live.worklog || []).map((w) => w.id)),
  jobClaims: new Set((live.jobClaims || []).map((j) => j.id)),
  redemptions: new Set((live.redemptions || []).map((r) => r.id)),
};

// Build a map of live completions by dedup key (user_id + task_id + date) for dedup
const liveCompsByKey = new Map();
for (const c of live.completions) {
  const day = (c.completedAt || "").slice(0, 10);
  const key = `${c.userId}|${c.taskId}|${day}`;
  if (!liveCompsByKey.has(key)) liveCompsByKey.set(key, []);
  liveCompsByKey.get(key).push(c);
}

// User ID → name map from live data
const userNames = {};
for (const u of live.users) userNames[u.id] = u.name;

// Task ID → name map from live data
const taskNames = {};
for (const t of live.tasks) taskNames[t.id] = t.name;

// Family ID (from live data)
const familyId = live.users[0]?.familyId;
console.log(`Family: ${familyId}`);
console.log(
  `Live data: ${live.completions.length} completions, ${(live.worklog || []).length} worklog, ${(live.jobClaims || []).length} job claims, ${(live.redemptions || []).length} redemptions`
);
console.log();

// --- Scan backup DBs ---
const dbFiles = fs
  .readdirSync(BACKUP_DIR)
  .filter((f) => f.endsWith(".db"))
  .sort();
console.log(`Found ${dbFiles.length} backup DBs in ${BACKUP_DIR}`);
console.log();

// Recovered rows, keyed by table
const recovered = {
  completions: new Map(), // id → row
  worklog_entries: new Map(),
  job_claims: new Map(),
  redemptions: new Map(),
  balance_adjustments: new Map(),
};

// For completions dedup: track by (user_id, task_id, date) → earliest row
const compsByDedupKey = new Map();

function safeOpen(dbPath) {
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

for (const dbFile of dbFiles) {
  const dbPath = path.join(BACKUP_DIR, dbFile);
  const db = safeOpen(dbPath);
  if (!db) {
    console.log(`  Skipping ${dbFile} (could not open)`);
    continue;
  }

  try {
    // --- Completions ---
    const comps = db
      .prepare(
        `SELECT * FROM completions WHERE family_id = ? AND status = 'approved'`
      )
      .all(familyId);
    for (const row of comps) {
      if (liveIds.completions.has(row.id)) continue;
      if (recovered.completions.has(row.id)) continue;

      const day = (row.completed_at || "").slice(0, 10);
      const dedupKey = `${row.user_id}|${row.task_id}|${day}`;

      // Check if live already has this user+task+day
      if (liveCompsByKey.has(dedupKey)) continue;

      // Check if we already recovered this user+task+day — keep earliest
      if (compsByDedupKey.has(dedupKey)) {
        const existing = compsByDedupKey.get(dedupKey);
        if (row.completed_at < existing.completed_at) {
          // This one is earlier, replace
          recovered.completions.delete(existing.id);
          recovered.completions.set(row.id, { ...row, _source: dbFile });
          compsByDedupKey.set(dedupKey, row);
        }
        continue;
      }

      recovered.completions.set(row.id, { ...row, _source: dbFile });
      compsByDedupKey.set(dedupKey, row);
    }

    // --- Worklog entries ---
    const wl = db
      .prepare(`SELECT * FROM worklog_entries WHERE family_id = ?`)
      .all(familyId);
    for (const row of wl) {
      if (liveIds.worklog.has(row.id)) continue;
      if (recovered.worklog_entries.has(row.id)) continue;
      recovered.worklog_entries.set(row.id, { ...row, _source: dbFile });
    }

    // --- Job claims ---
    const jc = db
      .prepare(`SELECT * FROM job_claims WHERE family_id = ?`)
      .all(familyId);
    for (const row of jc) {
      if (liveIds.jobClaims.has(row.id)) continue;
      if (recovered.job_claims.has(row.id)) continue;
      recovered.job_claims.set(row.id, { ...row, _source: dbFile });
    }

    // --- Redemptions ---
    const rd = db
      .prepare(`SELECT * FROM redemptions WHERE family_id = ?`)
      .all(familyId);
    for (const row of rd) {
      if (liveIds.redemptions.has(row.id)) continue;
      if (recovered.redemptions.has(row.id)) continue;
      recovered.redemptions.set(row.id, { ...row, _source: dbFile });
    }

    // --- Balance adjustments ---
    const ba = db
      .prepare(`SELECT * FROM balance_adjustments WHERE family_id = ?`)
      .all(familyId);
    for (const row of ba) {
      // No live IDs for this table (not in the JSON export), so just collect unique IDs
      if (recovered.balance_adjustments.has(row.id)) continue;
      recovered.balance_adjustments.set(row.id, { ...row, _source: dbFile });
    }
  } catch (e) {
    console.log(`  Error scanning ${dbFile}: ${e.message}`);
  } finally {
    db.close();
  }
}

// --- Report ---
console.log("\n========================================");
console.log("         RECOVERY REPORT");
console.log("========================================\n");

function reportTable(name, rows, displayFn) {
  const arr = Array.from(rows.values());
  if (arr.length === 0) {
    console.log(`${name}: 0 rows to recover`);
    return;
  }
  console.log(`${name}: ${arr.length} rows to recover`);
  arr.sort((a, b) =>
    (a.completed_at || a.clock_in || a.created_at || a.accepted_at || "").localeCompare(
      b.completed_at || b.clock_in || b.created_at || b.accepted_at || ""
    )
  );
  for (const row of arr) {
    console.log(`  ${displayFn(row)}`);
  }
  console.log();
}

reportTable("Completions", recovered.completions, (r) => {
  const ts = (r.completed_at || "").slice(0, 19).replace("T", " ");
  const user = userNames[r.user_id] || r.user_id;
  const task = taskNames[r.task_id] || r.task_id;
  return `${ts} | ${user.padEnd(8)} | ${task.padEnd(35)} | rewards=${r.rewards}`;
});

reportTable("Worklog entries", recovered.worklog_entries, (r) => {
  const ts = (r.clock_in || "").slice(0, 19).replace("T", " ");
  const dur = r.clock_out
    ? `${Math.round((new Date(r.clock_out) - new Date(r.clock_in)) / 1000)}s`
    : "open";
  const user = userNames[r.user_id] || r.user_id;
  const task = taskNames[r.task_id] || r.task_id;
  return `${ts} | ${user.padEnd(8)} | ${task.padEnd(35)} | dur=${dur}`;
});

reportTable("Job claims", recovered.job_claims, (r) => {
  const day = (r.accepted_at || "").slice(0, 10);
  const user = userNames[r.user_id] || r.user_id;
  const task = taskNames[r.task_id] || r.task_id;
  return `${day} | ${user.padEnd(8)} | ${task.padEnd(35)} | from: ${r._source}`;
});

reportTable("Redemptions", recovered.redemptions, (r) => {
  const day = (r.purchased_at || "").slice(0, 10);
  const user = userNames[r.user_id] || r.user_id;
  return `${day} | ${user.padEnd(8)} | costs=${r.costs} | from: ${r._source}`;
});

reportTable("Balance adjustments", recovered.balance_adjustments, (r) => {
  const day = (r.created_at || "").slice(0, 10);
  const user = userNames[r.user_id] || r.user_id;
  return `${day} | ${user.padEnd(8)} | delta=${r.delta} note=${r.note} | from: ${r._source}`;
});

const totalRows = Object.values(recovered).reduce(
  (sum, m) => sum + m.size,
  0
);
console.log(`Total: ${totalRows} rows to recover across ${Object.entries(recovered).filter(([, m]) => m.size > 0).length} tables`);

if (!APPLY) {
  console.log("\nDry-run mode. Run with --apply --db <path> to insert into a database.");
  process.exit(0);
}

// --- Apply ---
console.log(`\nApplying to: ${TARGET_DB}`);
const targetDb = new Database(TARGET_DB);

function insertRows(table, rows, cols) {
  if (rows.length === 0) return;
  const placeholders = cols.map(() => "?").join(", ");
  const colStr = cols.map((c) => `"${c}"`).join(", ");
  const stmt = targetDb.prepare(
    `INSERT OR IGNORE INTO "${table}" (${colStr}) VALUES (${placeholders})`
  );
  let inserted = 0;
  for (const row of rows) {
    const vals = cols.map((c) => row[c] ?? null);
    const result = stmt.run(...vals);
    if (result.changes > 0) inserted++;
  }
  console.log(`  ${table}: inserted ${inserted}/${rows.length} rows`);
}

const compCols = [
  "id", "family_id", "task_id", "user_id", "status", "completed_at",
  "approved_at", "rejected_at", "rejection_note", "rewards",
  "timer_seconds", "streak_count", "streak_multiplier", "timer_multiplier",
  "bonus_criteria_checked", "bonus_criteria_multiplier", "note",
  "is_penalty", "is_hourly", "total_seconds", "worklog",
];
insertRows(
  "completions",
  Array.from(recovered.completions.values()),
  compCols
);

const wlCols = [
  "id", "family_id", "task_id", "user_id", "clock_in", "clock_out",
  "paused_at", "elapsed_before_pause",
];
insertRows(
  "worklog_entries",
  Array.from(recovered.worklog_entries.values()),
  wlCols
);

const jcCols = [
  "id", "family_id", "task_id", "user_id", "status", "accepted_at",
];
insertRows(
  "job_claims",
  Array.from(recovered.job_claims.values()),
  jcCols
);

const rdCols = [
  "id", "family_id", "shop_item_id", "user_id", "costs", "purchased_at",
  "fulfilled", "fulfilled_at",
];
insertRows(
  "redemptions",
  Array.from(recovered.redemptions.values()),
  rdCols
);

const baCols = [
  "id", "family_id", "user_id", "currency_id", "delta", "note", "created_at",
];
insertRows(
  "balance_adjustments",
  Array.from(recovered.balance_adjustments.values()),
  baCols
);

// Recompute balances
console.log("\nRecomputing balances...");
const recomputeSql = `
  INSERT OR REPLACE INTO user_balances (user_id, currency_id, balance, family_id)
  SELECT user_id, currency_id, SUM(delta) as balance, family_id FROM (
    SELECT c.user_id, je.key as currency_id, je.value as delta, c.family_id
    FROM completions c, json_each(c.rewards) je
    WHERE c.status = 'approved' AND c.family_id = ?
    UNION ALL
    SELECT r.user_id, je.key as currency_id, -je.value as delta, r.family_id
    FROM redemptions r, json_each(r.costs) je
    WHERE r.family_id = ?
    UNION ALL
    SELECT ba.user_id, ba.currency_id, ba.delta, ba.family_id
    FROM balance_adjustments ba
    WHERE ba.family_id = ?
  ) GROUP BY user_id, currency_id
`;
targetDb.prepare(recomputeSql).run(familyId, familyId, familyId);
console.log("Balances recomputed.");

targetDb.close();
console.log("\nDone!");
