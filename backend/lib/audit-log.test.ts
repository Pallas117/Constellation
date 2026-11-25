import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { AUDIT_GENESIS_HASH, AuditLog, ipTarget, recordAudit, type AuditEntryInput } from "./audit-log.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gauss-audit-test-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const freshFile = () => path.join(dir, `audit-${++n}.db`);

const entry = (over: Partial<AuditEntryInput> = {}): AuditEntryInput => ({
  actorId: "user_abc123",
  role: "admin",
  action: "cybertiger.block",
  target: ipTarget("203.0.113.7"),
  result: "ok",
  requestId: "req-1",
  ...over,
});

describe("audit log", () => {
  it("audit log appends rows linked to the previous row hash", () => {
    const log = new AuditLog(freshFile(), () => new Date("2026-11-26T00:00:00Z"));
    const a = log.append(entry());
    const b = log.append(entry({ action: "cybertiger.unblock", requestId: "req-2" }));
    assert.equal(a.seq, 1);
    assert.equal(a.prevHash, AUDIT_GENESIS_HASH);
    assert.match(a.rowHash, /^[0-9a-f]{64}$/);
    assert.equal(b.seq, 2);
    assert.equal(b.prevHash, a.rowHash);
    assert.equal(b.time, "2026-11-26T00:00:00.000Z");
    assert.deepEqual(
      log.recent(10).map((r) => r.action),
      ["cybertiger.unblock", "cybertiger.block"],
    );
    log.close();
  });

  it("audit log verify walks the chain and passes when untouched", () => {
    const file = freshFile();
    const log = new AuditLog(file);
    assert.deepEqual(log.verify(), { ok: true, rows: 0 });
    for (let i = 0; i < 5; i += 1) log.append(entry({ requestId: `req-${i}` }));
    log.close();
    const reopened = new AuditLog(file);
    assert.deepEqual(reopened.verify(), { ok: true, rows: 5 });
    reopened.close();
  });

  it("audit log refuses update and delete", () => {
    const file = freshFile();
    const log = new AuditLog(file);
    log.append(entry());
    const raw = new DatabaseSync(file);
    assert.throws(() => raw.exec("UPDATE audit_log SET result = 'failed'"), /append-only/);
    assert.throws(() => raw.exec("DELETE FROM audit_log"), /append-only/);
    raw.close();
    assert.equal(log.verify().ok, true);
    log.close();
  });

  it("audit log verify detects an edited row and a removed middle row", () => {
    const file = freshFile();
    const log = new AuditLog(file);
    for (let i = 0; i < 4; i += 1) log.append(entry({ requestId: `req-${i}` }));
    // An attacker with file access can drop the triggers; the hash chain still shows it.
    const raw = new DatabaseSync(file);
    raw.exec("DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;");
    raw.exec("UPDATE audit_log SET result = 'denied' WHERE seq = 2");
    const edited = log.verify();
    assert.equal(edited.ok, false);
    assert.equal(edited.ok === false && edited.firstBadSeq, 2);

    const file2 = freshFile();
    const log2 = new AuditLog(file2);
    for (let i = 0; i < 4; i += 1) log2.append(entry({ requestId: `req-${i}` }));
    const raw2 = new DatabaseSync(file2);
    raw2.exec("DROP TRIGGER audit_log_no_delete; DELETE FROM audit_log WHERE seq = 3");
    const removed = log2.verify();
    assert.equal(removed.ok, false);
    assert.equal(removed.ok === false && removed.firstBadSeq, 4);
    raw.close();
    raw2.close();
    log.close();
    log2.close();
  });

  it("audit log stores no secret fields", () => {
    const file = freshFile();
    const log = new AuditLog(file);
    // A careless caller passes the whole auth context and a body: only the fixed fields are kept.
    const careless = {
      ...entry(),
      token: "sess_SECRET_TOKEN_value",
      email: "someone@example.com",
      password: "hunter2-SECRET",
      body: { apiKey: "gk_SECRET_KEY" },
    } as AuditEntryInput;
    log.append(careless);
    log.close();
    const raw = new DatabaseSync(file);
    const columns = (raw.prepare("PRAGMA table_info(audit_log)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(columns, [
      "seq",
      "time",
      "actor_id",
      "role",
      "action",
      "target",
      "result",
      "request_id",
      "prev_hash",
      "row_hash",
    ]);
    const dump = JSON.stringify(raw.prepare("SELECT * FROM audit_log").all());
    raw.close();
    for (const secret of ["SECRET", "someone@example.com", "hunter2", "203.0.113.7"]) {
      assert.equal(dump.includes(secret), false, `stored ${secret}`);
    }
  });

  it("audit log rejects free text in id fields and bad results", () => {
    const log = new AuditLog(freshFile());
    assert.throws(() => log.append(entry({ target: "Bearer abc def" })), /invalid target/);
    assert.throws(() => log.append(entry({ action: "Drop Table" })), /invalid action/);
    assert.throws(() => log.append(entry({ result: "maybe" as never })), /invalid result/);
    assert.throws(() => log.append(entry({ role: "admin; --" })), /invalid role/);
    assert.equal(log.verify().rows, 0);
    // recordAudit never throws into the request path.
    assert.doesNotThrow(() => recordAudit(log, entry({ target: "x y" })));
    assert.doesNotThrow(() => recordAudit(null, entry()));
    log.close();
  });
});
