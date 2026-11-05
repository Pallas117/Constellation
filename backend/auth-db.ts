import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The better-auth SQLite file: accounts, sessions and the `role` column.
 * `.auth.db` at the repo root unless AUTH_DB_PATH is set; tests point it at a
 * throwaway file so they never open the real one (backend/test-setup.ts).
 */
export function authDbPath(): string {
  const override = process.env.AUTH_DB_PATH?.trim();
  return override ? override : path.join(path.dirname(fileURLToPath(import.meta.url)), "../.auth.db");
}
