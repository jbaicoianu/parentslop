/**
 * Test harness: copies the production DB to a temp file, starts a server
 * against it on a random port, runs the test callback, then tears everything down.
 *
 * Usage (from a test file):
 *   const { withTestServer } = require("./harness");
 *   withTestServer(async (base) => { ... });
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

async function withTestServer(testFn) {
  // Copy production DB to a temp file
  const tmpDb = path.join(os.tmpdir(), `parentslop-test-${process.pid}-${Date.now()}.db`);
  fs.copyFileSync(PROD_DB, tmpDb);
  // Copy WAL/SHM files if they exist (ensures consistent snapshot)
  for (const suffix of ["-wal", "-shm"]) {
    const src = PROD_DB + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, tmpDb + suffix);
  }
  pendingCleanup.push(tmpDb);

  // Use port 0 to let the OS pick an available port, but we need to know it.
  // Start the server and parse the port from its stdout.
  const server = spawn(process.execPath, [SERVER_JS, "--db", tmpDb], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });

  // Ensure server is killed on exit
  process.on("exit", () => { try { server.kill(); } catch {} });

  let base;
  try {
    base = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Server failed to start within 10s")), 10000);
      server.stdout.on("data", (chunk) => {
        output += chunk.toString();
        const match = output.match(/running on (http:\/\/localhost:\d+)/);
        if (match) {
          clearTimeout(timeout);
          // Pipe remaining stdout to parent
          server.stdout.pipe(process.stdout);
          resolve(match[1]);
        }
      });
      server.on("error", (err) => { clearTimeout(timeout); reject(err); });
      server.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code} before starting. Output: ${output}`));
      });
    });
  } catch (e) {
    server.kill();
    throw e;
  }

  try {
    await testFn(base);
  } finally {
    server.kill();
  }
}

module.exports = { withTestServer };
