// Usage: npm run auth:clear-pattern -- <email>
// Clears an operator's pattern (GAU-235) so they set a new one at their next sign-in. For an admin
// who forgot theirs; other operators ask an admin (account page, Roles). Run it at the Mac.
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [email] = process.argv.slice(2);
if (!email) {
  console.error("Usage: npm run auth:clear-pattern -- <email>");
  process.exit(2);
}

const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.auth.db");
const db = new Database(dbPath);
const user = db.prepare("SELECT id FROM user WHERE lower(email) = lower(?)").get(email) as { id: string } | undefined;
if (!user) {
  console.error(`No user with email ${email}.`);
  process.exit(1);
}
const hasTable = (name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
const hasColumn = db.prepare("SELECT 1 FROM pragma_table_info('user') WHERE name = 'patternSetAt'").get() !== undefined;
const cleared = db.transaction(() => {
  const removed = hasTable("operator_pattern") ? db.prepare("DELETE FROM operator_pattern WHERE userId = ?").run(user.id).changes : 0;
  if (hasColumn) db.prepare("UPDATE user SET patternSetAt = NULL WHERE id = ?").run(user.id);
  return removed > 0;
})();
console.log(
  cleared
    ? `${email} has no pattern now: they set a new one after their next sign-in.`
    : `${email} had no pattern set.`,
);
