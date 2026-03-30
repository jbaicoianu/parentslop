/**
 * Append-only event log for CRDT event sourcing.
 *
 * All family data lives under a shared data directory:
 *   {dataDir}/families/{family_id}/events.jsonl   — append-only event log
 *   {dataDir}/families/{family_id}/snapshot.json   — latest materialized state
 *
 * The data directory should live on shared storage (EFS) so all server
 * instances see the same log. Writes use O_APPEND for atomicity.
 *
 * S3 is used for off-site backup of event logs and snapshots, not as the
 * primary write path.
 *
 * When no dataDir is configured, event writes are no-ops and the local
 * SQLite DB is the sole source of truth.
 */

const fs = require("fs");
const path = require("path");
const { ulid } = require("ulid");

let s3 = null;
let BUCKET = null;
let dataDir = null;

function init({ s3Client, bucket, dir } = {}) {
  s3 = s3Client || null;
  BUCKET = bucket || null;
  dataDir = dir || null;
  if (dataDir) {
    fs.mkdirSync(path.join(dataDir, "families"), { recursive: true });
  }
}

function isEnabled() {
  return !!dataDir;
}

function generateId() {
  return ulid();
}

/** Get the directory for a given family, creating it if needed. */
function familyDir(familyId) {
  const dir = path.join(dataDir, "families", familyId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path to a family's event log. */
function eventsPath(familyId) {
  return path.join(familyDir(familyId), "events.jsonl");
}

/** Path to a family's latest snapshot. */
function snapshotPath(familyId) {
  return path.join(familyDir(familyId), "snapshot.json");
}

function appendEvent(familyId, event) {
  const id = generateId();
  const fullEvent = { id, ts: Date.now(), ...event, family_id: familyId };

  if (!dataDir) return fullEvent;

  fs.appendFileSync(eventsPath(familyId), JSON.stringify(fullEvent) + "\n", { flag: "a" });

  return fullEvent;
}

function replayEvents(familyId, sinceId = null) {
  if (!dataDir) return [];

  const file = eventsPath(familyId);
  if (!fs.existsSync(file)) return [];

  const content = fs.readFileSync(file, "utf8");
  const events = [];
  let pastSince = !sinceId;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!pastSince) {
        if (event.id === sinceId) pastSince = true;
        continue;
      }
      events.push(event);
    } catch {
      // Skip malformed lines
    }
  }

  // ULIDs are lexicographically sortable by time
  return events.sort((a, b) => a.id.localeCompare(b.id));
}

function listFamilyIds() {
  if (!dataDir) return [];
  const familiesDir = path.join(dataDir, "families");
  if (!fs.existsSync(familiesDir)) return [];

  return fs.readdirSync(familiesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

// --- Local snapshots (per-family materialized state) -------------------------

/**
 * Write a snapshot for a single family to its local data directory.
 * This serves as a rolling backup — on startup, replay snapshot + events
 * since snapshot to rebuild state quickly.
 */
function writeLocalSnapshot(familyId, data) {
  if (!dataDir) return;
  const file = snapshotPath(familyId);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file); // atomic replace
}

function readLocalSnapshot(familyId) {
  if (!dataDir) return null;
  const file = snapshotPath(familyId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// --- S3 backup (off-site copies of event logs + snapshots) -------------------

function s3Enabled() {
  return !!(s3 && BUCKET);
}

/** Back up a family's event log and snapshot to S3. */
async function backupFamilyToS3(familyId) {
  if (!s3Enabled() || !dataDir) return;

  const { PutObjectCommand } = require("@aws-sdk/client-s3");

  // Upload event log
  const evFile = eventsPath(familyId);
  if (fs.existsSync(evFile)) {
    const body = fs.readFileSync(evFile);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `families/${familyId}/events.jsonl`,
      Body: body,
      ContentType: "application/x-ndjson",
    }));
  }

  // Upload snapshot
  const snapFile = snapshotPath(familyId);
  if (fs.existsSync(snapFile)) {
    const body = fs.readFileSync(snapFile);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `families/${familyId}/snapshot.json`,
      Body: body,
      ContentType: "application/json",
    }));
  }
}

/** Back up all families to S3. */
async function backupAllToS3() {
  if (!s3Enabled() || !dataDir) return;
  const families = listFamilyIds();
  for (const fid of families) {
    try {
      await backupFamilyToS3(fid);
    } catch (e) {
      console.error(`S3 backup failed for family ${fid}:`, e.message);
    }
  }
  console.log(`S3 backup complete (${families.length} families)`);
}

module.exports = {
  init,
  isEnabled,
  generateId,
  appendEvent,
  replayEvents,
  listFamilyIds,
  familyDir,
  writeLocalSnapshot,
  readLocalSnapshot,
  s3Enabled,
  backupFamilyToS3,
  backupAllToS3,
};
