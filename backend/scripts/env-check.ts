// Usage: npm run env:check
// Lists variable NAMES from .env.example that are missing from .env, so a
// local setup can catch up after a pull. Never prints values.
import fs from "node:fs";

const names = (file: string) =>
  fs.existsSync(file)
    ? new Set(
        fs
          .readFileSync(file, "utf8")
          .split("\n")
          .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1])
          .filter((name): name is string => Boolean(name)),
      )
    : null;

const example = names(".env.example");
const local = names(".env");
if (!example) {
  console.error("No .env.example here; run from the repo root.");
  process.exit(2);
}
if (!local) {
  console.log("No .env yet: copy .env.example to .env and fill in what you need.");
  process.exit(1);
}
const missing = [...example].filter((name) => !local.has(name));
if (missing.length === 0) {
  console.log(`.env has all ${example.size} variables from .env.example.`);
} else {
  console.log(`.env is missing ${missing.length} variable(s) from .env.example (add them, empty if unused):`);
  for (const name of missing) console.log(`  ${name}`);
  process.exitCode = 1;
}
