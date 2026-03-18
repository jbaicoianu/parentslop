/**
 * Test harness: starts a server against a temp DB on a random port,
 * runs the test callback, then tears everything down.
 *
 * Usage (from a test file):
 *   const { withTestServer, withTwoServers } = require("./harness");
 *   withTestServer(async (base) => { ... });
 *   withTwoServers(async (baseA, baseB, secret) => { ... });
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SERVER_JS = path.join(__dirname, "..", "server.js");
const PROD_DB = path.join(__dirname, "..", "parentslop.db");

// Track temp files for cleanup on exit (handles process.exit() in test code)
const pendingCleanup = [];
process.on("exit", () => {
  for (const tmpDb of pendingCleanup) {
    for (const f of [tmpDb, tmpDb + "-wal", tmpDb + "-shm"]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
});

/**
 * Start a server instance with a given DB path and optional extra env vars.
 * Returns { base, process } where base is the HTTP URL and process is the child.
 */
async function startServer({ tmpDb, extraEnv = {} } = {}) {
  pendingCleanup.push(tmpDb);

  const server = spawn(process.execPath, [SERVER_JS, "--db", tmpDb], {
    env: { ...process.env, PORT: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Ensure server is killed on exit
  process.on("exit", () => { try { server.kill(); } catch {} });

  const base = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      server.kill();
      reject(new Error("Server failed to start within 10s"));
    }, 10000);
    server.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/running on (http:\/\/localhost:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    server.on("error", (err) => { clearTimeout(timeout); reject(err); });
    server.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with code ${code} before starting. Output: ${output}`));
    });
  });

  return { base, process: server };
}

async function withTestServer(testFn) {
  // Copy production DB to a temp file
  const tmpDb = path.join(os.tmpdir(), `parentslop-test-${process.pid}-${Date.now()}.db`);
  fs.copyFileSync(PROD_DB, tmpDb);
  // Copy WAL/SHM files if they exist (ensures consistent snapshot)
  for (const suffix of ["-wal", "-shm"]) {
    const src = PROD_DB + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, tmpDb + suffix);
  }

  const srv = await startServer({ tmpDb });

  try {
    await testFn(srv.base);
  } finally {
    srv.process.kill();
  }
}

/**
 * Spin up two independent servers with fresh (empty) DBs and a shared sync secret.
 * No SYNC_PEERS set — tests drive sync manually.
 */
async function withTwoServers(testFn) {
  const secret = "test-sync-" + Date.now();
  const tmpA = path.join(os.tmpdir(), `parentslop-syncA-${process.pid}-${Date.now()}.db`);
  const tmpB = path.join(os.tmpdir(), `parentslop-syncB-${process.pid}-${Date.now()}.db`);

  const srvA = await startServer({ tmpDb: tmpA, extraEnv: { SYNC_SECRET: secret } });
  const srvB = await startServer({ tmpDb: tmpB, extraEnv: { SYNC_SECRET: secret } });

  try {
    await testFn(srvA.base, srvB.base, secret);
  } finally {
    srvA.process.kill();
    srvB.process.kill();
  }
}

module.exports = { withTestServer, withTwoServers };
