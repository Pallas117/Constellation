# Replay pilot runbook (GAU-59)

How a paid replay pilot runs, from a signed brief to a delivered evidence pack. The customer
sends the inference log from their own period; Gauss judges each inference against the space
environment as it was published at that time, and returns a signed evidence pack the customer
can check offline. This repository is public: keep customer names, prices and contract terms
out of it (they live in the admin console and the contract).

Code: `scripts/replay/fetch-event.ts`, `scripts/trust/ingest-log.ts`, `backend/trust/`. Design:
[ARCHITECTURE.md §3.4](ARCHITECTURE.md#34-trust-records-and-evidence-backendtrust). Signing:
[EVIDENCE_SIGNING.md](EVIDENCE_SIGNING.md). Requirements: REQ-TR-017 to REQ-TR-019 (window),
REQ-TR-001 to REQ-TR-016 (records, packs, signing).

## 0. Where things live

Customer logs are customer data. **Never commit them, never paste them into chat or an AI
tool, never put them in the repository or the tailnet mesh folder.** Use a working folder
outside the repo that the device policy treats as local-only (`gauss-guard <path>` must
answer SENSITIVE; it never leaves the device), for example `~/gauss/local/pilots/<slug>/`:

```
<slug>/
  log/            the customer's file exactly as received (never edited; its SHA-256 goes in the pack)
  mapping.json    the column mapping you wrote for it
  archive/        the environment archive for their window (step 3)
  out/            records.jsonl, report.json, pack.json, pack.pdf
```

The environment archive holds open data only (below), but it sits next to the log so the pack's
Inputs section can be reproduced. The pack itself contains per-inference records, so treat it
as customer data until it is delivered.

## 1. Intake (lightbound.space)

1. The customer fills in the pilot brief at `/gauss/apply/` (fit, readiness, pilot brief).
2. An admin reviews it in `/app/admin/`, approves it with a quote inside the published range
   and sets the plan and billing.
3. The customer signs in to `/app/` and pays (Stripe Checkout) or, if the admin allowed it,
   requests an invoice. The workspace unlocks when billing shows paid or active.
4. The admin moves the account through the workspace pilot steps. Start the technical work
   when the brief names the period (from/to, with time zone), the spacecraft or fleet, the
   model(s) and the log format.

Details: `website/README.md` (Plans, payment and sign-in). Nothing here touches the customer's
log; it only opens the account.

## 2. Receive the log

- Route: email, to the project mailbox, as an attachment. Ask for a password-protected
  archive and agree the password by another channel. Do not accept links to cloud drives.
- Format: CSV, JSON (one array of objects) or JSONL, one row per inference, UTF-8. Each row
  needs: inference time (ISO 8601 **with a zone**, or epoch seconds/milliseconds), spacecraft
  or unit id, model id, the output (one or more columns), and optionally a confidence from 0
  to 1, a processor profile id, and position (latitude, longitude in degrees GEO, altitude in
  km). Without a position the orbit-dependent fields read "unknown"; Gauss never assumes one.
- On arrival: move the file into `log/`, record its SHA-256 (`shasum -a 256`), and reply that
  it was received (the hash only). Delete the email attachment per the retention decision (step 10).
- A time without a zone is rejected unless the mapping sets `assumeUtc` and the customer has
  confirmed in writing that the log is UTC.

## 3. Fetch the environment for their window

From the brief's period (UTC). Up to 31 days make one archive; longer periods are split
automatically into `<slug>-p1`, `<slug>-p2` …

```bash
npm run replay:fetch -- --window 2026-03-02T00:00:00Z 2026-03-20T00:00:00Z --id pilot-2026-03 \
  --out ~/gauss/local/pilots/pilot-2026-03/archive/pilot-2026-03.json.gz
```

- Without `--out`, the file goes to `backend/replay/events/<slug>.json.gz`. Do not commit it
  for a customer window: the window itself says when the customer operated. Use `--out`.
- Times need a zone and the window must end in the past. The archive starts 6 h earlier so the
  L1 history is warm. If iSWA answers 429 or a server error the tool backs off and retries; a
  404 or an empty answer stops with the dataset id.
- The archive records its source (NASA CCMC iSWA HAPI, NOAA SWPC real-time products, public
  domain, with the acknowledgement text), retrieval time and the dataset ids. Kyoto Dst is
  not fetched: its redistribution terms are unchecked, so Dst is the labelled model estimate.
- If the period needs several archives, ingest each piece with the log rows for its dates
  (split the log by date, keeping the original file untouched, or ingest the whole log against
  each piece and keep that piece's rows from the pack's rows). Chain the packs with
  `--previous-pack` (step 6). Record in the report which rows each pack covers.

## 4. Write the column mapping

Mappings are JSON, schema `gauss.log-mapping/0.1`; examples are in `backend/trust/mappings/`.
Keep the customer's mapping in the pilot folder (not the repo) unless it is generic enough to
be reused. Example for a CSV with epoch-millisecond times, one satellite per file:

```json
{
  "schema": "gauss.log-mapping/0.1",
  "id": "customer-a-csv",
  "version": "0.1.0",
  "format": "csv",
  "timeFormat": "unix-ms",
  "columns": {
    "time": "ts_ms",
    "modelId": "model_name",
    "output": ["class", "detections"],
    "confidence": "conf",
    "latDeg": "lat",
    "lonDeg": "lon",
    "altKm": "alt_km"
  },
  "constants": { "spacecraftId": "UNIT-1" }
}
```

Increase `version` whenever the mapping changes: the pack records mapping id and version. A
mapping that names a missing column, or gives only some of latDeg/lonDeg/altKm, fails the
whole file with the reason, before anything is judged. Check the mapping on the first rows
before the full run.

## 5. Run the ingest

```bash
P=~/gauss/local/pilots/pilot-2026-03
npm run trust:ingest -- $P/log/inferences.csv $P/mapping.json \
  --archive $P/archive/pilot-2026-03.json.gz \
  --out $P/out/records.jsonl --report $P/out/report.json \
  --pack $P/out/pack.json --pdf $P/out/pack.pdf
```

- `--replay <slug>` is for an archive inside `backend/replay/events/` (named storms);
  `--archive <path>` is for one elsewhere. Give exactly one.
- `--from/--to` set the analysis window of the pack (default: the archive's replay window).
- The pack's Inputs section records the log SHA-256, mapping id and version, the archive
  SHA-256, the policy, and the software commit and requirements version. Run it from a clean
  checkout at a known commit; a `+modified` commit in the pack means the tree had changes.

## 6. Read the report

`report.json` and the console list, per row:

- **rejected**: malformed, duplicate or out-of-order rows, with the reason.
- **outside the archive window**: the row's time has no environment in the archive, so it is
  not judged. The pack lists it as not used, with the reason. If many rows fall here, the
  period in the brief and the log disagree: ask the customer, then re-fetch a wider window.
- **verdicts**: consistent, degraded-context, unknown. "Unknown" is a valid, honest result
  (stale, missing or conflicting inputs), not an error.

Send the rejected rows back to the customer by email as a table of row number and reason (no
other row content), so they can fix the export or confirm the intent. Re-run with the
corrected log (a new file hash). For an extension or a second period, chain with
`--previous-pack <earlier pack.json>`; it is checked (and its signature) first.

Do not describe results as compliant, certified or qualified, and do not state harm to
hardware or odds of a wrong output: the pack wording rules refuse it.

## 7. Sign

The release key is Josh's. An agent never opens, prints or signs with it. Sign at the Mac with
the key unlocked by touch or pattern:

```bash
npm run trust:sign -- $P/out/pack.json --sign-key ~/.config/gauss/keys/<evidence key> --pdf $P/out/pack.pdf
```

(or add `--sign-key` to the ingest run). See [EVIDENCE_SIGNING.md](EVIDENCE_SIGNING.md) for
key storage, locks and rotation.

## 8. Verify before delivery

```bash
npm run trust:verify -- $P/out/pack.json --pdf $P/out/pack.pdf --keyring backend/trust/signing-keys.json
```

Exit 0 only. Keep the output with the delivery record.

## 9. Deliver

In `/app/admin/` (Evidence, per account) attach the PDF, the pack JSON and the public keyring
to the customer's account. Only a PDF starting `%PDF-` and parsing JSON are accepted, at most
8 MB each; the customer downloads them from `/app/`. This delivery path is in the full release
only (`website/README.md`, Evidence delivery); on a public release, send the three files by
the same encrypted email route as step 2 and say so in the delivery record.

## 10. The customer checks it offline

Give them the steps in [EVIDENCE_SIGNING.md](EVIDENCE_SIGNING.md) (Verify a pack): the pack,
the PDF and the keyring taken from a channel other than the pack (the repository at the release
tag, or handed over at contract); then `npm run trust:verify -- pack.json --pdf pack.pdf
--keyring signing-keys.json` in a checkout of the repository, with no network. They can also
recompute the log hash against their own copy of the file.

## Retention

How long Gauss keeps the customer's log, the archive and the pack after delivery, and when it
deletes them: **Josh decides** (open). Until decided, keep everything in the pilot folder,
local-only, and delete nothing. Architecture context: [ARCHITECTURE.md §3.4](ARCHITECTURE.md#34-trust-records-and-evidence-backendtrust).

## Checklist

- [ ] Brief names period (with zone), units, models, log format
- [ ] Log received by the agreed route; SHA-256 noted; stored outside the repo, local-only
- [ ] Archive fetched with `--out` (outside the repo); source and retrieval time in it
- [ ] Mapping written and version set; first rows checked
- [ ] Ingest run from a clean commit; report read; rejected and outside-window rows sent back
- [ ] Pack signed by Josh's key; `trust:verify` exit 0
- [ ] Delivered; customer pointed to the offline check
- [ ] Retention applied as Josh decided
