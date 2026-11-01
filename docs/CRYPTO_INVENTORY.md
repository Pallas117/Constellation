# Crypto inventory

Each cryptographic primitive in the Gauss code and what it is for. Written for GAU-67 (REG-04: keep evidence and release signing to signing, authentication and their key management) and as input to the export classification (REG-01, GAU-65). It is not a classification: that needs counsel.

Source: a sweep of main for crypto calls (`createHash`, `createHmac`, `randomBytes`, `randomUUID`, `sign`/`verify`, WebCrypto `subtle`, `getRandomValues`, Go `crypto/*` imports), redone in full on main d53b82b, 2026-11-02. The first sweep (2026-10-24) missed Argo's bundle security (`tools/argo/bpsec.go`, on main since #153 on 2026-10-23) and a few hashing and random-id sites; they are now listed below. Third-party libraries were not swept and are marked UNVERIFIED.

## Evidence and release signing (GAU-67)

| Primitive | Where | Purpose | Function |
|---|---|---|---|
| Ed25519 signature (RFC 8032), Node `crypto.sign`/`verify` | `backend/trust/signing.ts` | Sign each evidence pack (a statement of its pack hash, chain head, key id and signing time) and release files (name, size, SHA-256) | Authentication and integrity (digital signature) |
| Ed25519 key generation, Node `generateKeyPairSync` | `scripts/trust/keys.ts` | Make a signing key | Key management for signing |
| SHA-256 | `backend/trust/signing.ts` | Key id (fingerprint of the public key); digest of a release file | Integrity, identification |
| PKCS#8 and SPKI PEM encoding | `backend/trust/signing.ts`, `scripts/trust/keys.ts` | Store the private key (not encrypted; file mode 600, outside the repository) and publish the public key | Key management (encoding only) |

No encryption, key exchange or key wrapping. The private key file has no passphrase on purpose: the tools add no encryption of their own and rely on file permissions and FileVault (macOS, not Gauss code). See [EVIDENCE_SIGNING.md](EVIDENCE_SIGNING.md).

## Evidence packs and trust records (GAU-60, GAU-66)

| Primitive | Where | Purpose | Function |
|---|---|---|---|
| SHA-256 | `backend/trust/record.ts`, `evidence.ts`, `ingest.ts`, `scripts/trust/ingest-log.ts` | Record hashes, the hash chain, the pack hash, hashes of the customer log and the replay archive | Integrity |

## Elsewhere in the product

| Primitive | Where | Purpose | Function |
|---|---|---|---|
| HMAC-SHA-256 and constant-time compare | `backend/services/device-auth.ts` | Device proofs keyed by `DEVICE_AUTH_SECRET` | Authentication |
| Random bytes (CSPRNG) and SHA-256 | `backend/commerce/store.ts` | Make customer API keys; only their SHA-256 is stored | Authentication (secret generation, hashed storage) |
| Random bytes (CSPRNG) and SHA-256 | `backend/mesh/store.ts` | Make Argo device tokens; only their SHA-256 is stored | Authentication |
| SHA-256 | `backend/world/ids.ts`, `backend/replay/replay.ts` | Content checksums and ids; replay archive hash | Integrity, identification |
| SHA-256 | `backend/lib/local-db.ts` | Checksums of each telemetry archive (raw and gzip) in its manifest, checked before rows are trimmed (GAU-157, #121) | Integrity |
| SHA-256 (WebCrypto) | `frontend/src/lib/operator-fingerprint.ts` | Hash of browser signals for device recognition | Identification |
| RSASSA-PKCS1-v1_5 with SHA-256 (RS256), WebCrypto verify | `website/worker/auth.js` | Check sign-in tokens from the identity provider | Authentication |
| HMAC-SHA-256 (WebCrypto) and constant-time compare | `website/worker/stripe.js` | Check payment-provider webhook signatures | Authentication |
| SHA-256 (WebCrypto), `getRandomValues` | `website/worker/data.js`, `website/worker/calls.js` | Hashed sender for rate limiting (the raw address is never stored); random ids | Identification, privacy |
| Ed25519 signature (Go `crypto/ed25519`) | `tools/argo/bpsec.go` | Integrity block (`argo-sig-1`): the source node signs each store-and-forward bundle | Authentication and integrity |
| HPKE (RFC 9180): ML-KEM-768 + X25519 hybrid KEM, HKDF-SHA256, AES-256-GCM (Go `crypto/hpke`) | `tools/argo/bpsec.go` | Confidentiality block (`argo-seal-1`): encrypts each bundle's payload and its integrity block to the destination node (GAU-193, #153) | **Confidentiality encryption of data** |
| Key generation (Ed25519 seed, ML-KEM-768 + X25519 key pair), CSPRNG | `tools/argo/bpsec.go` | Each Argo node's keys, kept in `node.key` (mode 600) in Argo's config folder | Key management for the two rows above |
| SHA-256 (Go), random bytes | `tools/argo/store.go`, `bundle.go`, `relay.go` | Bundle ids; checksums and random ids of relay transfers | Integrity, identification |
| SHA-256 | `backend/mesh/bundles.ts` | Bundle ids and short fingerprints on the hub | Identification |
| SHA-256 | `scripts/release/sbom.ts` | Stable ids in the release SBOM | Identification |
| Random UUID (CSPRNG) | `backend/cybertiger/daemon.ts`, `website/worker/app.js` | Request and event ids; a 10-minute token that hands an email to the next admin page without putting it in a URL | Identification |
| TLS client with X.509 (Go `crypto/tls`, `crypto/x509`) | `tools/argo/probe.go` | Connectivity probes to TLS endpoints | Transport, from Go's standard library; classification TBC (counsel) |

UNVERIFIED (third-party, not swept): better-auth password hashing and session tokens; TLS in Node, Cloudflare and the browser; WireGuard in Tailscale. These are transport and authentication supplied by platforms and libraries.

## Pending changes that would alter this inventory

- **PR #158 (GAU-199, open, head a48f2e8):** adds RFC 9173's standard BPSec contexts to Argo for interop with other DTN nodes: BIB-HMAC-SHA2 (HMAC-SHA-256/384/512 integrity) and BCB-AES-GCM (AES-GCM confidentiality) with RFC 3394 AES key wrap (`tools/argo/bpsec9173.go`, `aeskw.go`, importing `crypto/aes`, `crypto/cipher`, `crypto/hmac`). That would be a second confidentiality mechanism, not the first: main has encrypted Argo bundles since #153 (the HPKE row above). So the REG-01 question for confidentiality encryption already applies to Argo on main, whether or not #158 merges. Classification is counsel's (GAU-65). An earlier version of this note said #158 would bring that question in; it was wrong.
