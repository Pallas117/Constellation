/**
 * The pattern once a day per passkey (GAU-235, Josh 2026-11-04): after an operator draws their
 * pattern in a passkey session, a new passkey sign-in with the SAME passkey within
 * PATTERN_DEVICE_HOURS (default 20) starts already drawn, so coming back after an idle sign-out is
 * one touch. A duress drawing is never remembered and forgets every passkey of that operator; the
 * sensor's "unusual access" flag forgets the passkey it came from. 0 hours turns this off.
 *
 * The trade (documented in docs/OPERATOR_PASSKEYS.md): within that window, someone holding the
 * unlocked device and able to pass its biometric gets in without the pattern.
 */
import type Database from "better-sqlite3";

export const PATTERN_DEVICE_HOURS = 20;

export function deviceHoursFrom(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PATTERN_DEVICE_HOURS?.trim();
  if (raw === undefined || raw === "") return PATTERN_DEVICE_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 24) : PATTERN_DEVICE_HOURS;
}

export function createDeviceMemory(db: Database.Database, options: { hours?: number; now?: () => number } = {}) {
  const hours = options.hours ?? deviceHoursFrom();
  const now = options.now ?? Date.now;
  db.exec(`CREATE TABLE IF NOT EXISTS operator_pattern_device (
    userId TEXT NOT NULL,
    credentialId TEXT NOT NULL,
    drawnAt INTEGER NOT NULL,
    PRIMARY KEY (userId, credentialId)
  )`);
  const upsert = db.prepare(
    "INSERT INTO operator_pattern_device (userId, credentialId, drawnAt) VALUES (?, ?, ?) ON CONFLICT(userId, credentialId) DO UPDATE SET drawnAt = excluded.drawnAt",
  );
  const get = db.prepare<[string, string], { drawnAt: number }>("SELECT drawnAt FROM operator_pattern_device WHERE userId = ? AND credentialId = ?");
  const forgetOne = db.prepare("DELETE FROM operator_pattern_device WHERE userId = ? AND credentialId = ?");
  const forgetAll = db.prepare("DELETE FROM operator_pattern_device WHERE userId = ?");

  return {
    hours,
    /** Remember a good (never a duress) drawing in a session opened with this passkey. */
    remember(userId: string, credentialId: string | null | undefined): void {
      if (hours > 0 && credentialId) upsert.run(userId, credentialId, now());
    },
    /** Whether a new sign-in with this passkey may start already drawn. */
    fresh(userId: string, credentialId: string | null | undefined): boolean {
      if (hours <= 0 || !credentialId) return false;
      const row = get.get(userId, credentialId);
      return Boolean(row && now() - row.drawnAt < hours * 3_600_000);
    },
    /** Forget one passkey's drawing, or every passkey of the operator. */
    forget(userId: string, credentialId?: string | null): void {
      if (credentialId) forgetOne.run(userId, credentialId);
      else forgetAll.run(userId);
    },
  };
}

export type DeviceMemory = ReturnType<typeof createDeviceMemory>;
