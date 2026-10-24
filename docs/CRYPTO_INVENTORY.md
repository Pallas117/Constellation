# Crypto inventory

Each cryptographic primitive in the Gauss code and what it is for. Written for GAU-67 (REG-04: keep evidence and release signing to signing, authentication and their key management) and as input to the export classification (REG-01, GAU-65). It is not a classification: that needs counsel.

Source: a sweep of the code for crypto calls (`createHash`, `createHmac`, `randomBytes`, `sign`/`verify`, WebCrypto `subtle`, `getRandomValues`, Go `crypto/*` imports) on main 1e9087b plus this branch, 2026-10-24. Third-party libraries were not swept and are marked UNVERIFIED.

## Evidence and release signing (GAU-67, this change)

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
| SHA-256 (WebCrypto) | `frontend/src/lib/operator-fingerprint.ts` | Hash of browser signals for device recognition | Identification |
| RSASSA-PKCS1-v1_5 with SHA-256 (RS256), WebCrypto verify | `website/worker/auth.js` | Check sign-in tokens from the identity provider | Authentication |
| HMAC-SHA-256 (WebCrypto) and constant-time compare | `website/worker/stripe.js` | Check payment-provider webhook signatures | Authentication |
| SHA-256 (WebCrypto), `getRandomValues` | `website/worker/data.js`, `website/worker/calls.js` | Hashed sender for rate limiting (the raw address is never stored); random ids | Identification, privacy |
| SHA-256 (Go) | `tools/argo/store.go` | Store-and-forward bundle ids | Integrity, identification |
| TLS client with X.509 (Go `crypto/tls`, `crypto/x509`) | `tools/argo/probe.go` | Connectivity probes to TLS endpoints | Transport, from Go's standard library; classification TBC (counsel) |

UNVERIFIED (third-party, not swept): better-auth password hashing and session tokens; TLS in Node, Cloudflare and the browser; WireGuard in Tailscale. These are transport and authentication supplied by platforms and libraries.

## Pending changes that would alter this inventory

- **PR #158 (GAU-199, open, head a48f2e8):** adds RFC 9173 BPSec to Argo, including BCB-AES-GCM, which encrypts bundle payloads for confidentiality, plus HPKE and AES key wrap (`tools/argo/bpsec9173.go`, `aeskw.go`, `bpsec.go` import `crypto/aes`, `crypto/cipher`, `crypto/hpke`). That is confidentiality encryption of data, which REG-04 keeps out of GAU-67 because it brings Cat 5 Pt 2 into scope (REG-01). It needs Josh's (and counsel's) decision before it merges, especially if Argo ships to operators. Observed from the imports on that branch only; the code was not reviewed.
