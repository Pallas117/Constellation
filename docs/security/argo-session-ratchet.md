# Argo session ratchet (v0): design and threat model

Status: **R&D, unreviewed, off by default, not mounted on any route.** `ARGO_SESSION_RATCHET=on` is the flag the later wiring will read; today nothing reads it but the tests. It touches auth and crypto, so Josh merges it and it is switched on only after an outside review of the composition. Requirement: `REQ-SEC-007`. Code: `backend/argo-session/`.

**It authenticates requests; it does not encrypt them.** Confidentiality of request and response bodies comes from TLS alone. Nothing here should be described as making the login or the traffic quantum-resistant: the hybrid key exchange only feeds a MAC chain.

The frame: invent the **protocol** (how a per-session key is made, steps and dies); keep every **primitive** standard.

## Primitives (all from Node 26's built-in OpenSSL; no new dependency, nothing hand-rolled)

| Primitive | Standard | Use |
|---|---|---|
| ML-KEM-768 | FIPS 203 | Hybrid key establishment for the session root |
| X25519 | RFC 7748 | Hybrid key establishment (classical half) |
| HKDF-SHA-384 | RFC 5869 | Session root from both shared secrets, salted with the transcript hash |
| HMAC-SHA-384 | RFC 2104 | Chain keys, message keys, request and answer tags |
| ML-DSA-65 + Ed25519 | FIPS 204, RFC 8032 | Server signs the root transcript; both signatures must verify |
| SHA-256 / SHA-384 | FIPS 180-4 | Context digest, transcript hash, cookie-token fingerprint |

## Protocol

1. **Root, at sign-in.** The client sends an ephemeral ML-KEM-768 encapsulation key (1184 bytes) and an X25519 share (32 bytes). The server encapsulates, adds its own ephemeral X25519 share and hashes the transcript (length-prefixed): suite, handle, user id, sign-in time (ms), passkey credential id (empty for now), the client address it observed (CyberTiger's `extractClientIp`), both client shares, the KEM ciphertext, its X25519 share and its two signing public keys. `root = HKDF-SHA-384(ss_mlkem ‖ ss_x25519, salt = transcript, info = suite ‖ " root", L = 48)`; `ck0 = HMAC(root, "chain")`; the root and both shared secrets are zeroed. The server signs the transcript with ML-DSA-65 and Ed25519. The client recomputes the transcript, checks both signatures (against pinned keys when it has them) and derives the same `ck0`.
2. **Step, per request** (header `x-argo-session: <handle>.<step>.<tag>`, optional `x-argo-net: <class>`). `ck(n+1) = HMAC(ck(n), 0x02)`; `mk(n) = HMAC(ck(n), 0x01 ‖ ctx)` with `ctx = SHA-256(lp("ctx/v0", network class))`; `tag = HMAC(mk(n), lp("req", n, METHOD, path?query))[0..32]`. The server's answer tag is `HMAC(mk(n), lp("ack", n))[0..32]`.
3. **Concurrency.** Requests may arrive out of order: the server keeps chain keys for up to 64 skipped steps, each usable once; a step 64 or more ahead is refused.
4. **Death.** The state is zeroed and deleted on: a wrong tag (wrong key, context, method, path or step), a replayed or too-far step, a malformed step, another cookie session, a client address that differs from the one pinned at the root, 30 minutes idle, 12 hours after the root, sign-out or cookie revocation (`killToken`), an admin revocation (`killUser`), a new root on the same cookie session, the per-user cap (4) or the global cap (5000), and a restart (state is memory-only).

## What it is meant to protect against

- **Stolen session cookie:** without the chain state the cookie is not enough for routes that will need a step; with the chain state, a request from another cookie session or another address fails and kills the ratchet.
- **Replay and reorder:** each step is accepted once; out-of-order steps are accepted only inside the window and only once.
- **Forward secrecy within the chain:** used chain and message keys are zeroed; a later capture of server memory does not give earlier message keys.
- **Hybrid root:** the root needs both the ML-KEM and the X25519 secret, so a break of one alone does not give it. This is an argument, not a proof; checking it is the outside review's job.

## What it does not protect (known gaps)

- **No confidentiality.** See the top. Bodies, headers and answers are protected by TLS only.
- **Request bodies are not in the tag.** The tag binds step, method, path and query.
- **The declared network class is a commitment, not evidence:** a thief with the chain state can declare any class. The enforcing binding is the server-observed address.
- **Server signing keys are per boot**; a client learns them in the root answer unless pinned. Pinning and storing them as secrets needs Josh.
- **A compromised client device** holding the chain state on the owner's own address is out of scope.
- **Traffic analysis** (sizes, timing) is not hidden.
- **Availability:** any failed step, including an honest duplicate retry, ends the ratchet. Chosen deliberately: death on doubt.
- **No client yet** except the Node reference client in `ratchet.ts` (used by the tests). A browser needs ML-KEM in WebCrypto or a reviewed library; a Go client has `crypto/mlkem` and X25519 in the standard library but no ML-DSA yet.

## TODO (not built; each is its own reviewed change)

- **Passkey binding.** Make the root commit to a fresh passkey assertion whose challenge is derived from the client's key shares, so the biometric-unlocked device key vouches for this exact root. The transcript already has the field (empty). Independent of the open passkey PRs; it will use whatever passkey sign-in lands on main.
- **Duress.** A duress sign-in should kill every ratchet of that cookie session at once (`killToken`), open a decoy session and raise a silent alert. Only the kill exists.
- **Encrypted channel.** Either an AEAD channel (e.g. AES-256-GCM or ChaCha20-Poly1305 with keys from the chain) for request and answer bodies, or a standing statement that confidentiality is TLS's job. Until one is chosen, the second is the truth.
- **Wiring.** A root route in `API_POLICY` (operator, explicit), a guard after `enforceApiPolicy` that answers 428 (not 401/403, so CyberTiger does not block the operator's own address) and reports failures to the security log without tags or keys, and revocation statements signed for offline delivery.

## Evidence

- `backend/argo-session/ratchet.test.ts`: derivations against vectors computed with Python's `cryptography`, `hashlib` and `hmac` (independent of Node's code), X25519 against RFC 7748 section 6.1, seeded signing keys, the root (hybrid agreement, pinned keys, both signatures, transcript binding, malformed and low-order shares), steps (fresh key per request, replay, reorder window, too far, wrong context, method or path, other cookie session or address, malformed), death (idle, age, revocation by token and user, per-user cap) and the flag.

## Review gates before it is switched on

1. Threat model reviewed by Josh.
2. Outside cryptographic review of the composition (not the primitives). Reviewer and budget TBC.
3. A real client and a real-device run.
4. Passkey sign-in on main, then the passkey-binding TODO.
