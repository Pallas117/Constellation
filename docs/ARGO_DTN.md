# Argo delay-tolerant networking (GAU-193)

Status: implemented in `tools/argo` and the Gauss hub (`backend/mesh/bundles.ts`); draft PR for review.
Decisions (Josh, 2026-10-23):
- Argo stays "Included" for operators and staff, with no price (the 22 Oct decision).
- The shared internet relay is designed here and shows as "in development" on the site until counsel signs off
  (GAU-65/76/77).

## What problem this solves

Josh's Mac on the phone hotspot, 24 h to 2026-10-23 (Argo incident log): 84.3% available, 24 drops, median
outage 3 min, p95 63 min. Over 7 days: 83% and a p95 of 5 h. Anything that needs both ends online at once (a sync,
a file share, a chat message) fails or stalls on links like this. The customers we target have it worse: an onboard
computer is reachable only during ground passes.

Delay-tolerant networking (DTN) is the space answer:
- Store each unit of data, forward it when a contact appears.
- Confirm it end to end.
- Let the network be disconnected most of the time.

NASA flies it: PACE (2024) is the first operational science mission with DTN on spacecraft and ground, and HDTN
relayed images to the ISS via LCRD in 2024
([NASA DTN overview](https://www.nasa.gov/technology/space-comms/dtn-overview-benefits-successstories-learningresources)).

## What we built

```
 judith (hotspot)                 Gauss hub (tailnet)                 ground-1 / sat-1
 argo send ──► outbox ──HTTP──► /api/mesh/bundles ◄──HTTP── argo sync ──► inbox (~/Downloads/Argo)
   ▲  1 MiB chunks, each a        ciphertext only, per-device          │
   │  signed + sealed BPv7        mailbox, tombstones, quotas          │ signed "delivered"
   └──────────── receipt ◄──────────────────────────────────────────────┘ status report
 argo mule export ──► a drive someone carries ──► argo mule import      (no network at all)
```

| Piece | File | Standard |
|---|---|---|
| CBOR codec (deterministic encoding, hard limits) | `tools/argo/cbor.go` | [RFC 8949](https://www.rfc-editor.org/rfc/rfc8949) |
| Bundles, CRC-16/X-25 and CRC-32C, EIDs, status reports | `tools/argo/bundle.go` | [RFC 9171](https://www.rfc-editor.org/rfc/rfc9171) (BPv7) |
| Integrity and confidentiality blocks | `tools/argo/bpsec.go` | BPSec layout ([RFC 9172](https://www.rfc-editor.org/rfc/rfc9172)), HPKE ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180)), Ed25519 ([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)) |
| Standard BPSec blocks for interop (library only) | `tools/argo/bpsec9173.go`, `aeskw.go` | [RFC 9172](https://www.rfc-editor.org/rfc/rfc9172), [RFC 9173](https://www.rfc-editor.org/rfc/rfc9173), AES key wrap ([RFC 3394](https://www.rfc-editor.org/rfc/rfc3394)) |
| Store-and-forward agent | `tools/argo/relay.go`, `relay_cmd.go` | |
| Hub convergence layer | `tools/argo/hub.go` ↔ `backend/mesh/bundles.ts`, `router.ts` | HTTP (no IETF HTTP CL exists; dtn7-rs has a non-standard one) |
| Link stability | `tools/argo/linkstats.go` | A = MTBF/(MTBF+MTTR) |
| Honest learning per network | `tools/argo/loop.go`, `store.go` | |

### Bundle profile

- **Primary block:**
  - Version 7, CRC-32C.
  - Flags: must-not-fragment; for data bundles also report-delivery and status-time.
  - Destination `dtn://<device>/files`; source = the source *node ID* `dtn://<device>/`; report-to `dtn://<device>/argo`.
  - Creation time in DTN ms with a per-node sequence number; lifetime 7 days by default, 30 at most.
- **Canonical blocks:** CRC-32C on every block; the payload block is last, number 1.
- **Bundle ID:** `sha256("<source>|<created ms>|<seq>")[:16]` hex. It is used for dedup on the receiver and as the
  hub's id; both sides compute it the same way, checked by golden fixtures.
- **Application data unit** (payload plaintext): CBOR
  `[1, "file", name, size, sha256(file), transfer-id(16), index, count, chunk]`. The receiver checks that count
  matches size, the chunk lengths, and the whole-file SHA-256 before the file appears in the inbox. Names are
  reduced to a plain file name, and an existing file is never overwritten.
- **Status report:** the RFC 9171 §6.1.1 admin record, with only "delivered" asserted, signed but not encrypted. It
  goes only to the bundle's source node, so receipts can't be reflected at a third party.

### Security blocks (private block types, BPSec layout)

RFC 9172 reserves negative security-context IDs and has no private range, and HPKE is not a standard BPSec context:
BPSec-COSE and COSE-HPKE are still drafts
([draft-ietf-dtn-bpsec-cose](https://datatracker.ietf.org/doc/draft-ietf-dtn-bpsec-cose/),
[draft-ietf-cose-hpke](https://datatracker.ietf.org/doc/draft-ietf-cose-hpke/)). So Argo uses RFC 9171's private
block types and BPSec's Abstract Security Block fields as a CBOR array:
`[targets, context id 1, flags, security source, (params), results]`.

| Block | Type | Targets | Params | Results |
|---|---|---|---|---|
| `argo-sig-1` | 192 | payload | — | `[1, Ed25519 signature]` over CBOR `["argo-sig-1", primary block, type, number, flags, plaintext payload]` |
| `argo-seal-1` | 193 | payload, then the 192 block | `[1, CBOR [kem 0x647a, kdf 1, aead 2]]`, `[2, HPKE enc]` | empty (tags are inline) |

- **HPKE suite:** ML-KEM-768 + X25519 (X-Wing, `0x647a`), HKDF-SHA256, AES-256-GCM.
  - `info` = CBOR `["argo-seal-1", primary block]`, so a ciphertext can't be replayed into another bundle.
  - AAD per target = CBOR `[type, number, flags]`.
- **Order:** sign first, then encrypt; the encryption also covers the signature, as RFC 9172 §3.8 requires when
  both target the payload.
- **Forwarding:** the block-processing flags are 0, so a standard BPv7 node that can't read these blocks forwards
  them unchanged.
- **Overhead:** about 1.4 KB per 1 MiB chunk (`testdata/bundles/file-chunk.bundle`), mostly the ML-KEM ciphertext.

Keys: `~/.config/argo/node.key` (0600) holds the Ed25519 seed and the HPKE private key. The public half goes to the
Gauss directory (`POST /api/mesh/keys`; the first key set wins, a different one is a 409). Other devices pin a key
the first time they see it. The fingerprint is SHA-256 over CBOR `[sign, kem_id, kem]`, the first 10 bytes shown as
five groups of four hex digits. It is the same code in `argo keys` and on `/mesh`.

### Interoperability (RFC 9173)

`tools/argo/bpsec9173.go` adds the standard BPSec blocks with RFC 9173's default security contexts, for nodes such
as NASA HDTN, dtn7-rs and ION that use pre-placed symmetric keys (GAU-199). It is a library: the relay still uses
blocks 192/193, and no command or key file uses it yet.

- **Supported:**
  - BIB (type 11) with BIB-HMAC-SHA2 (context 1): HMAC 256/256, 384/384 (default) and 512/512.
  - BCB (type 12) with BCB-AES-GCM (context 2): A128GCM and A256GCM (default), 8 to 16-byte IVs (12 by default,
    random), the 128-bit tag as a security result or at the end of the ciphertext.
  - Integrity and AAD scope flags (primary block, target header, security header); keys pre-placed or carried AES
    key wrapped ([RFC 3394](https://www.rfc-editor.org/rfc/rfc3394), `aeskw.go`, checked on its §4 vectors).
  - The Abstract Security Block as a CBOR sequence (RFC 9172 §3.6), unlike Argo's own blocks, which use an array.
  - RFC 9172's block rules: one service per target, no BIB on a security block or an encrypted block, no BCB on
    the primary block or another BCB, and BIBs added before BCBs (§3.2, §3.7 to §3.9).
- **Golden tests:** all four Appendix A examples (A.1 to A.4) verify or decrypt from the published bytes and
  re-encode to them byte for byte (`bpsec9173_test.go`, hex in `testdata/rfc9173/`).
- **Choices to know about:**
  - A primary-block BIB target is wrapped in a byte string, as A.3 publishes it and dtn7-rs computes it.
    [Errata 9192](https://www.rfc-editor.org/errata/eid9192) (reported 2026-09-28, not verified) reads the text as
    the bare block; `BarePrimary` selects that form, and the errata's corrected A.3 bytes are a golden test too.
  - One target per BCB when Argo encrypts: a BCB's targets share one key and IV, and A.4 reuses its IV for two
    targets ([errata 7002](https://www.rfc-editor.org/errata/eid7002)). Argo still decrypts such BCBs.
  - HMAC keys from 16 bytes up to the hash size are accepted: §3.5 asks for the full hash size, but every
    Appendix A example uses a 16-byte key.
- **UNVERIFIED:** live interoperability with HDTN, dtn7-rs or ION. Only the RFC's own examples have been checked.

### Reliability: end to end, because BPv7 has no custody transfer

RFC 9171 moved custody transfer to BIBE. That draft's successor is unreliable by design
([draft-ietf-dtn-bibe](https://datatracker.ietf.org/doc/draft-ietf-dtn-bibe/)), and the CCSDS custody extension
was not yet published at the time of writing (UNVERIFIED). Argo therefore:

1. Writes each bundle to disk (fsync, then rename) before `argo send` returns.
2. Uploads when the hub is reachable. The hub refuses a bundle whose source isn't the uploading device. Retries back
   off from 30 s to 15 min.
3. Re-checks bundles at the hub every 10 min (`POST /api/mesh/bundles/status`). A bundle the hub no longer knows,
   and the destination never confirmed, is queued again.
4. The receiver dedups by bundle ID. It answers a duplicate with a fresh receipt (at most one in flight per
   bundle), and acks the hub only after its own state is on disk.
5. The sender gives up only when the lifetime ends, and tells the person which file.

### Hub API (device token, tailnet only)

| Route | Does |
|---|---|
| `POST /api/mesh/bundles` (octet-stream, ≤ 2 MiB) | Store a bundle. Refused if: bad CRC; source ≠ uploader; unknown destination; fragment; lifetime over 30 d; expired. Rate limit 120/min per device. Each mailbox holds at most 2048 bundles / 512 MiB |
| `GET /api/mesh/bundles` | This device's mailbox: ids, sender, size, times |
| `GET` / `DELETE /api/mesh/bundles/:id` | Fetch / acknowledge one bundle (destination only); acknowledging leaves a tombstone until the lifetime ends |
| `POST /api/mesh/bundles/status` | queued / picked-up / unknown, for this device's own bundles only |
| `GET /api/mesh/directory`, `POST /api/mesh/keys` | Public keys |

- **What `/mesh` shows:** counts and sizes waiting per device and each key fingerprint, never who sent what.
- **Revoking a device** drops its mailbox and its unsent bundles.

### Honest learning per network

The same day's log showed Argo repeating mistakes on a bad network:
- 17 of 18 incidents had an empty network fingerprint.
- "wait" was credited as the fix for OFFLINE 7 times, and "switch network" 3 times though nobody switched.
- Every recovery notified: about 20 alerts for blips of 0.3 to 5 minutes.

What changed:
- Incidents now belong to the network the Mac was on.
- A fix is credited only with evidence. Otherwise the incident cleared by itself, and its duration is kept per
  network and class.
- After three such recoveries, a new incident is announced only if it outlasts that network's usual recovery
  (p90, capped at 30 min); the escalation breaker waits as long.
- Recoveries are announced only for announced incidents, or for those lasting 15 min or more.

Details are in the Argo README, and the tests are in `tools/argo/adaptive_test.go`.

## Test, learn, improve: the simulation

`tools/argo/sim_test.go` runs the real relay code over 5 simulated days with deterministic seeds:
- **judith and field-2:** hotspot links calibrated on the log above. Field-2 is also asleep 23:00-07:00.
- **sat-1:** an onboard computer reachable only in five passes a day, 8-12 min each.
- **Hub:** wiped every 36 h, then down for 10 min.
- **Traffic:** 60 files, a fifth of them 3 chunks.

| Seed 20261023 | Delivered | Receipts | p50 | p95 |
|---|---|---|---|---|
| Direct only (both ends online at once; optimistic, ignores transfer time) | 60/60 | n/a | 2 h 32 min | 10 h 50 min |
| Relay that trusts the hub (no re-check, no re-receipt) | 59/60 | 57/60 | 2 h 22 min | 7 h 24 min |
| Relay, end to end (shipped) | 60/60 | 60/60 | 2 h 24 min | 7 h 24 min |

What the runs taught us, and what changed because of them:
- **A bundle's source must be the node ID.** Receipts didn't match until it was (RFC 9171 §4.3.1).
- **A ground station on the mule path never learned the sender's key.** Carried folders now include the exporter's
  public key, pinned only for a device not pinned yet.
- **Re-importing the same stick queued a second receipt.** Now one is in flight per bundle.
- **Idle ticks rewrote the state file with a full fsync every minute.** That was mostly from a "last OK" timestamp.
  Path health now changes only on an up/down transition, and an unchanged state isn't written. The simulation went
  from 102 s to 15 s, and laptops write less.
- **Honest result:** with these traces both ends are often online at once, so for laptop-to-laptop files the relay
  does not beat an idealised direct path on speed. Its value there is that nothing is lost, receipts are signed,
  and the hub can lose data safely. For the pass-limited node, the relay cut the p95 from 10 h 50 min to 7 h 24 min.
- **The scenario check is seed-dependent.** On seed 7 the hub wipes hit no bundle in flight, so the check that the
  hub-trusting variant loses something runs only on the default seed.

## Internet through a shared relay (design only; not available)

This continues the 2026-10-19 product brief "Lightbound Private Connectivity" (private Claude doc). The goal: no
single company can link a user to their traffic.

1. **Path ladder per network.** Direct; then the customer's own exit node (Tailscale, MY/SG allow-list, today);
   then the Lightbound relay. Argo picks the rung by the same evidence rules as above: a rung that failed on this
   network is not offered again until it has worked.
2. **Two hops.** Entry relay run by Lightbound, egress relay run by an independent partner in another jurisdiction,
   using MASQUE ([RFC 9298](https://www.rfc-editor.org/rfc/rfc9298), [RFC 9484](https://www.rfc-editor.org/rfc/rfc9484))
   nested so that the entry sees the user and the egress sees the destination.
3. **Anonymous access tokens.** Privacy Pass ([RFC 9576](https://www.rfc-editor.org/rfc/rfc9576)), so payment
   identity is never linked to usage. Rate limits per token are the abuse control.
4. **Store and forward stays separate.** Files keep using the hub. The relay carries live traffic only.

Gates before anything ships:
- Counsel on sanctions and export control (GAU-65/76/77).
- A signed partner agreement that neither side keeps linkable logs.
- An external security review.

Go's standard library has no HTTP/3, so the relay would need a reviewed third-party QUIC stack or a separate
service. That is a decision for Josh and the reviewer. The site says "It isn't available yet."

## Threat model (store and forward)

| Adversary | Can | Cannot |
|---|---|---|
| Hub operator or anyone who breaches it | See who sends to whom, when, and how much; delay or drop bundles (the sender sees "picked up" never turn into "confirmed", and re-sends if the hub says "unknown") | Read or alter content; forge a sender or a receipt; move a ciphertext into another bundle |
| Network on the path | Same as the hub, minus mailbox contents (traffic is inside the tailnet) | As above |
| Carrier of a mule drive | Copy, drop or delay bundles | Read or alter them |
| Holder of a stolen device token | Upload as that device (receivers refuse anything not signed with its key); publish keys for it **only if it never published any** | Replace an already published key (409); read anyone's files |
| Compromised hub on first contact | Offer a wrong key for a device nobody has pinned yet (trust on first use) | Change a pinned key silently: Argo alerts and keeps the old one. Mitigation: compare fingerprints out of band |

Not covered:
- Traffic analysis.
- Forward secrecy against a later theft of the receiving device's private key. Each bundle has a fresh HPKE
  encapsulation, but the recipient key is static; key rotation is a follow-up.
- Denial of service by an enrolled device (bounded by quotas and rate limits).

## Wording rules

- Public copy (site test): no "post-quantum", "PQC" or "quantum-ready".
  - The site says "encrypted end to end … (HPKE, RFC 9180)".
  - The algorithm names are in the README and here as technical fact.
- Never "compliant", "certified" or "space-grade". Say "built on RFC 9171/9172 layouts and RFC 9180".
- CCSDS: BPv7 is an experimental Orange Book (734.20-O-1, April 2025). No Blue Book was found (UNVERIFIED).

## Next

1. **Interoperability.** TCPCLv4 ([RFC 9174](https://www.rfc-editor.org/rfc/rfc9174)) for direct device links.
   The RFC 9173 contexts exist as a library (see above); next is a key store and a live test against HDTN and
   dtn7-rs (Apache-2.0). Copy no code from dtn7-go (GPL), µD3TN (AGPL) or Reticulum (restrictive licence).
2. **Transfer improvements.** Partial-chunk resume; recipient key rotation; Contact Graph Routing once passes are
   scheduled (CCSDS SABR 734.3-B-1).
3. **Phones.** Phones as bundle endpoints (an iOS/Android client).
4. **Per-network history** (GAU-189). Feed per-network reliability into the path ladder.
