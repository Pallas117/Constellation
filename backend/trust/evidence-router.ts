/**
 * Operator console "Evidence" view (GAU-59): the pilot flow a buyer sees, over HTTP.
 * Mounted at /api/trust/evidence behind the session and API_POLICY (operator and above).
 *
 *   GET  /options   what can be analysed here: stored storms, shipped mappings, the synthetic sample, the published keys
 *   POST /analyse   a log + mapping + storm -> the ingest report, trust records and the unsigned evidence pack
 *   POST /pdf       a pack that verifies -> its PDF (exactly what `trust:ingest --pdf` writes)
 *   POST /verify    a pack -> the lines `npm run trust:verify` prints, against the published keyring
 *
 * Nothing is stored: the pack goes back to the browser, which holds it and sends it again for the
 * PDF and the check. Nothing is signed: there is no signing route and no private key is read
 * here. A pack is signed by the key holder at the host with `npm run trust:sign`.
 */
import express, { type Request, type Response } from "express";
import { asyncRoute } from "../lib/async-route.js";
import type { EvidencePack } from "./evidence.js";
import { renderEvidencePdf } from "./evidence-pdf.js";
import { mappingProblems, type LogMapping } from "./ingest.js";
import { checkPack } from "./pack-check.js";
import { builtInMappings, PilotError, pilotEvents, runPilot, sampleLog, type PilotRunner } from "./pilot-run.js";
import { keyStatus, loadKeyring, PUBLISHED_KEYRING_PATH, type Keyring } from "./signing.js";

/** The published keyring as the report names it (the path in the repository, not on this host). */
export const KEYRING_LABEL = "backend/trust/signing-keys.json";
/** What the console shows for an unsigned pack. The key file never leaves its holder's machine. */
export const SIGN_ON_HOST = "npm run trust:sign -- pack.json --sign-key <private key file> --pdf pack.pdf";
/** A log larger than this is run from the command line (docs/PILOT_RUNBOOK.md); the JSON body limit is 2 MB. */
export const MAX_LOG_BYTES = 1_000_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const subjectOf = (v: unknown) => (typeof v === "string" && /^[\w .()+-]{1,100}$/.test(v) ? v : "pack.json");

export function createEvidenceRouter(deps: { run?: PilotRunner; keyring?: () => Keyring; now?: () => number } = {}) {
  const run = deps.run ?? runPilot;
  const keyring = deps.keyring ?? (() => loadKeyring(PUBLISHED_KEYRING_PATH));
  const now = deps.now ?? Date.now;
  const router = express.Router();
  let busy = false; // one replay at a time: each is a short-lived process of its own

  router.get("/options", (_req: Request, res: Response) => {
    res.json({
      events: pilotEvents(),
      mappings: builtInMappings(),
      sample: sampleLog(),
      maxLogBytes: MAX_LOG_BYTES,
      keys: keyring().keys.map((k) => ({ keyId: k.keyId, purposes: k.purposes, status: keyStatus(k, now()) })),
      keyring: KEYRING_LABEL,
      signOnHost: SIGN_ON_HOST,
    });
  });

  router.post("/analyse", asyncRoute(async (req: Request, res: Response) => {
    const body: unknown = req.body;
    if (!isObject(body) || typeof body.log !== "string" || typeof body.eventId !== "string") {
      res.status(400).json({ error: "Send { log, eventId, mappingId | mapping }" });
      return;
    }
    const log = Buffer.from(body.log, "utf8");
    if (log.length === 0 || log.length > MAX_LOG_BYTES) {
      res.status(log.length ? 413 : 400).json({ error: log.length ? `The log is over ${MAX_LOG_BYTES / 1_000_000} MB: run it from the command line (docs/PILOT_RUNBOOK.md)` : "The log is empty" });
      return;
    }
    const mapping = isObject(body.mapping) ? (body.mapping as unknown as LogMapping) : builtInMappings().find((m) => m.id === body.mappingId);
    const problems = mapping ? mappingProblems(mapping) : [`unknown mapping "${String(body.mappingId)}"`];
    if (!mapping || problems.length) {
      res.status(422).json({ error: `The mapping can't be used: ${problems.join("; ")}` });
      return;
    }
    if (!pilotEvents().some((e) => e.id === body.eventId)) {
      res.status(422).json({ error: "Unknown replay event" });
      return;
    }
    if (busy) {
      res.status(429).setHeader("retry-after", "15").json({ error: "Another analysis is running; try again in a moment" });
      return;
    }
    busy = true;
    try {
      const result = await run({ log, mapping, eventId: body.eventId });
      res.json({ ...result, signed: false, signOnHost: SIGN_ON_HOST });
    } catch (e) {
      if (e instanceof PilotError) res.status(422).json({ error: e.message });
      else {
        console.error("[trust/evidence] analyse failed:", e instanceof Error ? e.message : e);
        res.status(500).json({ error: "The analysis could not be run" });
      }
    } finally {
      busy = false;
    }
  }));

  /** The pack in the body, with every problem found; a pack that throws while being checked is reported, not a 500. */
  const packIn = (req: Request, allowUnsigned: boolean) => {
    const body: unknown = req.body;
    const pack = (isObject(body) && isObject(body.pack) ? body.pack : null) as EvidencePack | null;
    const subject = subjectOf(isObject(body) ? body.name : undefined);
    if (!pack) return { pack: null, subject, check: null };
    try {
      return { pack, subject, check: checkPack(pack, keyring(), { subject, keyringLabel: KEYRING_LABEL, allowUnsigned }) };
    } catch {
      const problems = ["not a readable evidence pack"];
      return { pack, subject, check: { ok: false, problems, notes: [], lines: [`${subject}: FAILED`, `  - ${problems[0]}`] } };
    }
  };

  router.post("/verify", (req: Request, res: Response) => {
    const { check } = packIn(req, isObject(req.body) && (req.body as Record<string, unknown>).allowUnsigned === true);
    if (!check) {
      res.status(400).json({ error: "Send { pack, name?, allowUnsigned? }" });
      return;
    }
    res.json({ ...check, keyring: KEYRING_LABEL });
  });

  router.post("/pdf", (req: Request, res: Response) => {
    // Integrity decides whether a PDF is drawn; an unsigned pack's PDF says it is not signed.
    const { pack, check } = packIn(req, true);
    if (!pack || !check) {
      res.status(400).json({ error: "Send { pack }" });
      return;
    }
    if (!check.ok) {
      res.status(422).json({ error: "No PDF for a pack that does not verify", problems: check.problems });
      return;
    }
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `attachment; filename="${/^ep_[0-9a-f]{20}$/.test(pack.packId) ? pack.packId : "pack"}.pdf"`);
    res.setHeader("cache-control", "no-store");
    res.send(renderEvidencePdf(pack));
  });

  return router;
}
