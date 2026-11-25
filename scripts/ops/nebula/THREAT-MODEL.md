# Threat model: Phase 2, `argo net enroll` / renew over Argo bundles (DRAFT)

Status: **DRAFT, not built.** Phase 2 touches authentication and key handling, so it needs Josh's go-ahead, this
threat model reviewed, and an outside review before any code merges. Phase 1 (this folder) has no Argo signing
or renewal: `argo net status` only reads. Nothing below is implemented.

## Goal

A device Argo already trusts gets, or renews, its Nebula certificate without a third-party login and without
Josh copying files by hand: it asks over Argo's store-and-forward bundles, the CA Mac signs, and the certificate
comes back sealed. It works while the mesh itself is down (that is when renewal matters most).

## What exists (checked in `tools/argo`)

- Device keys: Ed25519 signing (`argo-sig-1`, block 192) and HPKE sealing (`argo-seal-1`, block 193:
  ML-KEM-768 + X25519 hybrid, `crypto/hpke`), `bpsec.go`. Pinning with `argo keys trust DEVICE` after a
  fingerprint check (`../vps/confirm-peer.sh` is the pattern).
- Transports that need no tailnet: the hub's mailbox (ciphertext only), a LAN neighbour, Meshtastic radio, a
  USB mule (`docs/ARGO_DTN.md`).
- Bundles are signed, then encrypted, with the primary block bound in the HPKE `info`; receipts are end to end.

## Proposed flow

1. **Device D** (Nebula installed, key pair made locally by `nebula-cert keygen`) builds
   `net-enroll-request {device, nebula public key, wanted address, wanted groups, nonce (128-bit random),
   created (UTC), expires (created + 10 min), current cert fingerprint or none}`.
   Signs with D's Ed25519 key; seals with HPKE to the **CA Mac's** `argo-seal-1` key. Sends as a bundle.
2. **The CA Mac (K)**, in `argo` (not a daemon with standing access to the CA key), checks in this order and
   stops at the first failure:
   - the signature is from a key pinned with `argo keys trust` and not revoked;
   - the nonce is unseen (K keeps seen nonces until their `expires`, capped) and `created` is within ±5 min of K's
     clock (Argo's clock check in `timeintegrity.go` flags a skewed clock rather than trusting it);
   - the request matches **K's allowlist for D** (`device → address, groups`, written by Josh at first enrolment;
     a request never chooses its own address or groups beyond that);
   - for a renewal, the public key equals the one in D's current certificate (a new key = a new enrolment, which
     needs Josh at the Mac);
   - rate limit: one certificate per device per 24 h.
3. **K signs** with `sign.sh` (Keychain dialog: a human clicks Allow for each certificate in the first version;
   unattended renewal is a separate decision, below), 30-day lifetime.
4. **K replies** `net-enroll-reply {certificate, ca.crt, blocklist, request nonce}`, signed by K's Ed25519 key and
   sealed to D's HPKE key. Certificates and the CA certificate are public, but sealing keeps the membership list
   and the blocklist away from the hub and any relay.
5. **D checks** K's signature against its pinned K key, the nonce against its own request, `nebula-cert verify`
   against the `ca.crt` it already has (a reply may not introduce a new CA: CA rotation is a separate, Josh-only
   operation), then installs the certificate and reloads Nebula. Installing into `/etc/nebula` needs root: either
   a tiny root helper that accepts only a verified certificate file, or Josh runs one printed command. To decide.
6. Every enrolment and renewal is logged on K (device, fingerprint, expiry) and texted once ("talos renewed its
   mesh certificate"), never twice for the same certificate.

## Threats

| Threat | What stops it | Residual risk |
|---|---|---|
| **Replay** of an old request (from the hub, a relay or a mule) | nonce cache + ±5 min window + `expires`; renewal must present the same public key; one per day | A replay inside the window gets the same certificate D would get anyway (no gain) |
| **Forged request** | Ed25519 signature from a key pinned after a fingerprint check | A key pinned without checking the fingerprint (trust on first use) is the weak point: keep `confirm-peer`-style checks |
| **Hub or relay reads or alters traffic** | Requests and replies are sealed (HPKE) and signed; certificates verify against the pinned CA | Metadata: who enrols when, bundle sizes |
| **Stolen device** | Remove it from `argo keys trust` (K refuses its requests), add its certificate fingerprint to the blocklist, sent to all nodes in signed bundles; 30-day expiry as backstop | Until every node has the blocklist, the thief can reach what the device's groups allow, for at most the certificate's remaining days |
| **Stolen or compromised CA Mac** | Key in the Keychain, item trusts no app, so use needs the login password or a dialog click; FileVault at rest; CA limited to 10.117.0.0/24 and four groups | An attacker with the Mac unlocked can sign anything inside those limits. Response: new CA, re-sign every device, old CA out of every `ca.crt`. Keep an offline backup so the CA can be rebuilt elsewhere |
| **Malware on the CA Mac as the user** | Same Keychain dialog per use; no daemon holds the key; requests only for allowlisted device → address, groups | A user who clicks "Always Allow" removes the dialog: the runbook says never to |
| **A device asks for more** (hub group, another address) | K's allowlist decides, not the request | Allowlist edits are Josh-only, at the Mac |
| **Downgrade to the old path** (Tailscale) | Out of scope: both run until Tailscale is retired | |
| **Clock attacks** (K's clock wrong, certificates born expired or too long) | K refuses to sign if Argo's clock check is not ok; lifetimes are fixed by `sign.sh` (max 90 days) | |
| **Lighthouse compromise** | It holds only its own key and certificate; it can't decrypt tunnels or mint certificates | It can drop or delay traffic, and see metadata. Blocklist its certificate and stand up another |

## Unattended renewal (open decision for Josh)

The first version keeps a person in the loop (the Keychain dialog). Unattended renewal would need the CA key
usable without a click, which turns "steal the Mac while unlocked" into "malware as the user can sign". Options:
an intermediate CA with a short life and only renewal rights; a hardware key (Secure Enclave can't hold an
Ed25519 key, so this would mean P-256 CA, which nebula-cert supports with `-curve P256`); or accept monthly
clicks. Not decided.

## Crypto rules

Standard primitives only (Ed25519, HPKE from `crypto/hpke`, Nebula's own Noise handshake); no new constructions.
No public claims of "post-quantum" or any grade or compliance; Nebula's tunnels use Curve25519 (or P-256) Noise
handshakes and are not post-quantum, whatever Argo's bundle sealing is.
