// Runs every check:* suite from package.json in sequence (npm run check:all).
// Exits non-zero if any suite fails; prints a summary table at the end.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
const names = Object.keys(scripts).filter((k) => k.startsWith("check:") && k !== "check:all");

const results = [];
for (const name of names) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const r = spawnSync(/^win/.test(process.platform) ? "npm.cmd" : "npm", ["run", name], {
    stdio: "inherit",
    shell: /^win/.test(process.platform),
  });
  results.push({ name, ok: r.status === 0 });
}

const failed = results.filter((r) => !r.ok);
console.log("\n========== check:all summary ==========");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
console.log(`${results.length - failed.length}/${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
