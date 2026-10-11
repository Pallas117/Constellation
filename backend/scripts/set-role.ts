// Usage: npm run auth:set-role -- <email> <viewer|operator|admin>
// Roles live only in the local better-auth DB; users cannot set their own.
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROLES = new Set(["viewer", "operator", "admin"]);
const [email, role] = process.argv.slice(2);

if (!email || !role || !ROLES.has(role)) {
  console.error("Usage: npm run auth:set-role -- <email> <viewer|operator|admin>");
  process.exit(2);
}

const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.auth.db");
const db = new Database(dbPath);
const result = db.prepare("UPDATE user SET role = ? WHERE lower(email) = lower(?)").run(role, email);
if (result.changes !== 1) {
  console.error(`No user with email ${email}. They must sign up first.`);
  process.exit(1);
}
console.log(`${email} is now ${role}. Existing sessions pick this up on their next request.`);
