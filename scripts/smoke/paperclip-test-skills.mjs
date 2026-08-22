// Read-only entry point: paperclip-test-skills
// Runs skill regression fixtures without production mutations.
// Usage: node scripts/smoke/paperclip-test-skills.mjs [--json]
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "paperclip-skill-fixtures.test.mjs");
const contract = join(here, "..", "paperclip-skill-contract.mjs");
const json = process.argv.includes("--json");

function run() {
  const contractCheck = spawnSync(process.execPath, ["--check", contract], { encoding: "utf8" });
  if (contractCheck.status !== 0) {
    console.error(JSON.stringify({ CONTRACT_SYNTAX: "FAIL", stderr: contractCheck.stderr }));
    process.exitCode = 1;
    return;
  }
  const result = spawnSync(process.execPath, ["--test", fixtures], { encoding: "utf8" });
  const passed = result.status === 0;
  if (json) {
    console.log(JSON.stringify({
      HARNESS: "paperclip-test-skills",
      MODE: "DIAGNOSE (read-only)",
      WRITES_PERFORMED: 0,
      FIXTURES: passed ? "PASS" : "FAIL",
      CASES: ["A-zero-token", "B-access-prereq", "C-host-plugin-leak", "D-in-review-reuse", "E-idempotent-create", "F-active-run-guard", "G-layer-split-no-loop", "H-board-only", "I-rollback-path", "J-diagnose-zero-write"],
      EXIT_CODE: result.status,
    }, null, 2));
  } else {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.status ?? 1;
}

run();
