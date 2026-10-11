// Creates/updates the better-auth tables in .auth.db, including the `role`
// column that backend/auth.ts reads. Safe to re-run: it only adds what's missing.
import { getMigrations } from "better-auth/db/migration";
import { auth } from "../better-auth.js";

const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length === 0 && toBeAdded.length === 0) {
  console.log("auth schema is up to date");
} else {
  console.log("creating:", toBeCreated.map((t) => t.table).join(", ") || "-");
  console.log("adding columns to:", toBeAdded.map((t) => t.table).join(", ") || "-");
  await runMigrations();
  console.log("done");
}
