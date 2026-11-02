# Evidence and release signing (GAU-67)

Evidence packs (GAU-60) are hash-chained, so anyone can tell whether a pack changed after it was made. That is integrity. Signing adds authorship: an Ed25519 signature shows which Gauss key made the pack, so a customer no longer needs a trusted copy of the pack hash, only the published keyring. Release files (archives, checksum lists, SBOMs) are signed the same way with a separate key.

Code: `backend/trust/signing.ts`. Commands: `trust:keys`, `trust:sign`, `trust:verify` (in `scripts/trust/`). Tests: `backend/trust/signing.test.ts` (REQ-TR-006). Crypto inventory: [CRYPTO_INVENTORY.md](CRYPTO_INVENTORY.md).

Scope (export control, REG-04): signing, authentication and their key management only. Nothing here encrypts files or data.

## Verify a pack (customers, offline)

You need three files from Gauss: the pack (`pack.json`), its PDF (`pack.pdf`) and the Gauss keyring (`signing-keys.json`). Then, in a checkout of the Gauss repository at the release tag, after `npm ci` with Node 22 (no network is needed after that):

```bash
npm run trust:verify -- pack.json --pdf pack.pdf --keyring signing-keys.json
```

It recomputes every record hash, the hash chain and the pack hash, checks the wording rules, checks the signature against the keyring, and checks that the PDF is exactly the rendering of that pack. Exit code 0 means everything checks out, 1 means something does not (each problem is listed), 2 means the command was used wrongly.

```
pack.json: OK. 3 records, pack hash 9f2c…; signed by key ed25519:4be1… on 2026-10-24T09:12:03.000Z (keyring signing-keys.json); pack.pdf matches
```

What the result means:

| Output | Meaning |
|---|---|
| `OK` | The pack is intact and a current Gauss key signed it. |
| `OK` with `NOTE: key … was retired` | The pack is intact and was signed before that key was rotated out. It stands; newer packs use the current key. |
| `FAILED … the signature does not verify` | A record, the pack, the signature, the key id or the signing time was changed after signing. |
| `FAILED … which is not in the keyring` | The pack was signed by a key Gauss has not published (or you have an old keyring). |
| `FAILED … was revoked` | The key may have been compromised, so nothing it signed is accepted. Ask Gauss for a copy signed with a current key. |
| `FAILED … the pack is not signed` | No signature. `--allow-unsigned` checks integrity only. |

The keyring is the trust anchor: take it from Gauss through a channel other than the pack (the repository at a release tag, or handed over at contract), never from the pack itself. The PDF prints the signing key id, so you can also compare it with the id Gauss gave you.

## Sign

Packs are signed when they are made (`npm run trust:ingest -- … --pack pack.json --pdf pack.pdf --sign-key <key file>`) or afterwards:

```bash
npm run trust:sign -- pack.json --sign-key ~/.config/gauss/keys/evidence-2026-10.pem --pdf pack.pdf
```

Signing never changes the pack hash, so chained packs stay chained and an old pack can be re-signed. The PDF shows the signature, so it is written again. Every new signature is checked against the keyring before it is written.

Release files get a detached signature next to them (`<file>.sig.json`):

```bash
npm run trust:sign -- --file gauss-v0.1.0.tar.gz --sign-key ~/.config/gauss/keys/release-2026-10.pem
npm run trust:verify -- --file gauss-v0.1.0.tar.gz
```

Container images are not built yet (GAU-68); signing them is a follow-up.

## Key storage

- One key per purpose: `evidence-pack` and `release-artifact`. The signed statement carries its type, so a release signature can never pass as a pack signature, and the keyring says what each key may sign.
- The private key is a PKCS#8 PEM file outside any repository, for example `~/.config/gauss/keys/`, in a directory only its owner can open (700), with the file at mode 600, on a disk with FileVault on. The tools refuse a key file inside the repository or one other users can read, and never overwrite one. `.gitignore` ignores `*.pem` and `*.key`.
- Never put a private key in the repository, `.env*` files, environment variables, logs, URLs, chat or agent transcripts, cloud drives or the tailnet mesh folder. The keyring check refuses any private key material, and `npm run security:secrets` flags it in staged changes.
- Agents must not open, print or copy the key file. This is a rule, not a technical control: the agents run as the same user. With the key locked (below), an agent cannot sign without its owner's finger or pattern, which is the point.
- Each person signs with their own keys, made on their own Mac and locked to their own fingerprint (next section). The keyring lists everyone's public keys with their names, so a signature's key id says who signed. Keys are never copied between people or Macs.
- Where there is no Touch ID (over SSH, or a Mac without it), lock the key under a geometry pattern instead (the section after). Either way a copy of the file alone is not enough to sign. A YubiKey or HSM is still the stronger option and a follow-up; Node's crypto cannot use one directly.
- Backup: none. A lost key is not a disaster: make a new one and retire the old one. Packs it signed keep verifying. Josh chose (2026-11-02) to lock keys rather than keep copies. A Mac that is lost or wiped, a changed set of fingerprints, or a forgotten pattern is the same as a lost key.

## Lock a key to your fingerprint (Touch ID)

Josh, 2026-11-02: tie signing to biometrics, so each person has their own. The key is locked to a key in the Mac's Secure Enclave that only works after a fingerprint enrolled on that Mac when it was made.

```bash
npm run trust:keys -- lock --key ~/.config/gauss/keys/evidence-2026-11.pem --touch-id --remove-plain
npm run trust:keys -- new --touch-id --owner "Merve" --out ~/.config/gauss/keys/evidence-merve.locked --purpose evidence-pack --note "Merve's evidence key"
```

- `lock --touch-id` locks an existing key; `new --touch-id` makes one that is never stored unlocked. Both ask for one touch to check the lock before anything is deleted. `--owner` defaults to the login name.
- Signing (`trust:sign`, `trust:ingest --sign-key`) asks for one touch. Touch ID needs you at the Mac: it does not work over SSH, so sign at the Mac or use a pattern-locked key there.
- How it works: an ephemeral P-256 key agrees a secret with the enclave key (ECDH); HKDF-SHA256 and AES-256-GCM seal the signing key with it, with the file's header bound in. To unlock, the enclave gives the same secret only after Touch ID (`scripts/trust/secure-enclave.swift`, built on first use with the Command Line Tools). Every lock uses a fresh ephemeral key, so no two files share a secret, and the enclave key cannot be read out or used on another Mac.
- The enclave key is tied to the fingerprints enrolled when it was made: adding or removing a fingerprint retires it for good (make a new signing key and retire the old one). That stops anyone from adding their own finger to your Mac to sign as you.

## Lock a key under a geometry pattern

The pattern is drawn on the 16 vertices of a rotating tesseract, the figure of the UI-UX-Gauss geometric lock. The vertices are labelled A to P. Each time the page opens, the figure starts in a new orientation, so the shape you draw differs while the vertices, and so the pattern, stay the same.

```bash
npm run trust:keys -- lock --key ~/.config/gauss/keys/evidence-2026-11.pem --remove-plain
npm run trust:keys -- lock --key ~/.config/gauss/keys/release-2026-11.pem --remove-plain
```

- Draw the pattern twice in the page that opens on this Mac: 8 to 24 vertices, at least 6 different, never the same vertex twice in a row. Hovering over the figure stops its rotation, and typing the letters works too.
- Over SSH (Termius), or with `--pattern-tty`, type the letters instead; nothing is echoed. Piped input works for scripts.
- The tool writes `<key file>.locked` (mode 600), checks that it unlocks, and with `--remove-plain` overwrites and deletes the unlocked file. On an SSD the old blocks can survive until they are reused; FileVault keeps them encrypted.
- From then on, sign with `--sign-key <file>.locked`. `trust:sign` and `trust:ingest --sign-key` ask for the pattern the same way, and stop after five misses or three minutes. `trust:keys new --lock` makes a key that is locked from the start.
- The page listens on 127.0.0.1 only and closes once it has an answer. It only answers its own address and origin, and only takes a pattern sent with the nonce it served. Nothing secret goes in a URL. Neither the pattern nor the key is printed or logged.
- Strength: the pattern is stretched with scrypt (N = 2^17, r = 8, p = 1: about 0.4 s and 128 MiB per try on an M1), and the key is sealed with AES-256-GCM. The file's header (key id, settings, lock time) is bound to the seal, so editing it fails the unlock. A pattern holds at most about 31 bits of choice, and fewer as people pick shapes, so the lock slows down someone who has copied the file; it does not stop a well-funded attacker who has it for long. Only the key is encrypted, never any data: this is key management for signing (REG-04, [CRYPTO_INVENTORY.md](CRYPTO_INVENTORY.md)).

## First keys

Made on 2026-11-01 and published in `backend/trust/signing-keys.json`: evidence packs `ed25519:fd861c573a359f169d67fc7e9cd9f073`, releases `ed25519:4337a6c2faf6104ba515d546285eea8f`. They were made like this (the dates in the file names differ):

```bash
npm run trust:keys -- new --out ~/.config/gauss/keys/evidence-2026-10.pem --purpose evidence-pack --note "Evidence packs from 2026-10"
npm run trust:keys -- new --out ~/.config/gauss/keys/release-2026-10.pem --purpose release-artifact --note "Releases from 2026-10"
```

Each command prints the keyring entry (public key only). Add both to `keys` in `backend/trust/signing-keys.json`, run `npm run trust:keys -- check`, and merge that in a PR. The key id is `ed25519:` plus the first 32 hex digits of the SHA-256 of the public key, so anyone can recompute it.

## Rotation (planned)

Rotate yearly, when someone who held a key leaves, or when moving to new hardware.

1. Make the new key and add its entry to the keyring (as above). Both keys are current for a moment.
2. Set the old key's `retiredAt` to now. Run `npm run trust:keys -- check` and merge.
3. Sign with the new key from now on. The tools refuse to sign with a retired key.
4. Packs signed by the old key before `retiredAt` keep verifying, with a note that the key is retired. A signature by the old key made after `retiredAt` fails.
5. Delete the old private key (or keep it offline if Josh decides so), send customers the updated keyring, and publish it with the next release.

## Revocation (the key may be compromised)

Retiring is not enough here: whoever holds a stolen key can backdate the signing time.

1. Set the key's `revokedAt` to now. Merge and push the keyring at once and send it to customers.
2. Every pack that key signed now fails. Re-sign the ones still in use with a current key: `npm run trust:sign -- pack.json --sign-key <current key> --pdf pack.pdf`. The pack hash does not change.
3. Make a new key if needed and find out how the old one leaked.

## Formats

Pack signature (in `pack.signature`; the pack hash covers the pack with `signature` set to null):

```json
{ "type": "gauss.evidence-pack-signature/0.1", "algorithm": "Ed25519", "keyId": "ed25519:…", "signedAt": "2026-10-24T09:12:03.000Z", "value": "<base64, 64 bytes>" }
```

The signature is over the UTF-8 canonical JSON (keys sorted, no spaces) of `{ type, algorithm, keyId, signedAt, schema, packId, packHash, chainHead }`, with the pack hash recomputed from the pack. A release-file signature (`gauss.release-artifact-signature/0.1`) adds `file: { name, bytes, sha256 }` and signs `{ type, algorithm, keyId, signedAt, file }`.

Keyring (`gauss.signing-keys/0.1`): `keys[]` of `{ keyId, algorithm: "Ed25519", purposes, publicKey (SPKI PEM), validFrom, retiredAt, revokedAt, note? }`.
