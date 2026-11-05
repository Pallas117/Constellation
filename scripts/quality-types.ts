// quality:types: run `tsc --noEmit` on each project config and report how many of the
// project's own files each one checked. Fails on any type error, and also when a config
// checks zero files: until #21, `quality:types` passed while checking nothing, because the
// root tsconfig is solution-style and plain `tsc` matched no files.
// Usage: node --import tsx scripts/quality-types.ts <tsconfig> [tsconfig...]
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const configs = process.argv.slice(2);

if (configs.length === 0) {
  console.error("usage: node --import tsx scripts/quality-types.ts <tsconfig> [tsconfig...]");
  process.exit(2);
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
let failed = false;
let totalFiles = 0;
let totalErrors = 0;

for (const config of configs) {
  const run = spawnSync(process.execPath, [tsc, "--noEmit", "--listFiles", "-p", config], { encoding: "utf8" });
  const lines = `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n");
  // --listFiles prints absolute paths; everything else is a diagnostic.
  const files = lines.filter((line) => line.startsWith("/") && !line.includes("/node_modules/"));
  const diagnostics = lines.filter((line) => line.trim() !== "" && !line.startsWith("/"));
  const errors = diagnostics.filter((line) => /\berror TS\d+:/.test(line)).length;

  if (diagnostics.length > 0) console.log(diagnostics.join("\n"));

  const ok = run.status === 0 && files.length > 0;
  const note = files.length === 0 ? " (checked no files: the config matches nothing)" : "";
  console.log(`${ok ? "✓" : "✗"} ${config}: ${count(files.length, "file")}, ${count(errors, "error")}${note}`);

  failed ||= !ok;
  totalFiles += files.length;
  totalErrors += errors;
}

console.log(`quality:types: ${count(configs.length, "config")}, ${count(totalFiles, "file")}, ${count(totalErrors, "error")}`);
process.exit(failed ? 1 : 0);
