#!/usr/bin/env node
/**
 * Runs all test suites sequentially. Reports combined results.
 * Exits non-zero if any suite fails.
 */

const { execFileSync } = require("child_process");
const path = require("path");

const suites = [
  "tests/security.test.js",
  "tests/fuzz.js",
  "tests/sync.test.js",
  "tests/event-log.test.js",
];

let anyFailed = false;

for (const suite of suites) {
  const fullPath = path.join(__dirname, "..", suite);
  console.log(`\n${"━".repeat(60)}`);
  console.log(`Running ${suite}...`);
  console.log("━".repeat(60));
  try {
    execFileSync(process.execPath, [fullPath], { stdio: "inherit" });
  } catch {
    anyFailed = true;
  }
}

console.log(`\n${"━".repeat(60)}`);
console.log(anyFailed ? "Some test suites had failures." : "All test suites passed.");
console.log("━".repeat(60));
process.exit(anyFailed ? 1 : 0);
