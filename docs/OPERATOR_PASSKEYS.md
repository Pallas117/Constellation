# Operator passkeys, step-up and sign-out (GAU-235)

Operators sign in to the Gauss console with one touch: Touch ID on a Mac, Face ID or a fingerprint on a phone. Admin changes ask for a second touch. Sign-out is one click, and operator sessions end by themselves after a stretch with no activity. Requirement: `REQ-SEC-003` in `requirements/requirements.json`.

## What it is

- **Passkeys (WebAuthn)**, through better-auth's own passkey plugin (`@better-auth/passkey`, the same version as `better-auth`). Configuration: `backend/better-auth.ts`. Policy and constants: `backend/passkey-policy.ts`.
- **User verification is required.** Registration asks for a discoverable credential with `userVerification: "required"`, and sign-in options are rewritten from the plugin's `"preferred"` to `"required"`. The plugin itself verifies with `requireUserVerification: false`, so `better-auth.ts` refuses any registration or sign-in whose authenticator did not verify the person before anything is stored or a session is created.
- **Biometrics never leave the device.** The device checks the fingerprint or face (or its own PIN or passcode, which it falls back to). The server only learns that the check passed (the UV flag) and checks a signature over a fresh challenge. Gauss stores a credential ID, the public key, a signature counter, the AAGUID, a device type, a "backed up" flag, transports, a name and a date. Nothing biometric.
- **Origin and RP ID are pinned.** Without an `origin` setting the plugin trusts whatever Origin header a request carries; here it is the configured list, so a ceremony from any other site fails.

## What it is not

- **Not post-quantum.** Passkeys sign with ECDSA P-256 or Ed25519, which a large enough quantum computer could break. What they do give: the private key never leaves the device, and each sign-in signs a fresh server challenge, so there is no password to phish, reuse or replay.
- **The operator geometry is not an authentication factor.** See below.
- **Password and Google sign-in still work.** Passkeys are added alongside them. Making the console passkey-only is a separate decision.

## Sign-in, step-up and sign-out

| Action | How | Server side |
|---|---|---|
| Add a passkey | Header geometry → *Passkeys and sign-in* (`/account/security`) → *Add a passkey* | Needs a signed-in session less than a day old (plugin's fresh-session check) |
| Sign in | Login page → *Sign in with passkey*, one touch, no email typed | New session stamped with `passkeyAt` and `passkeyCredentialId`; the browser's previous session is revoked |
| Step-up | An admin change answered `428 STEP_UP_REQUIRED` → the console asks for a touch and retries once | Same as sign-in; when signed in, the browser is offered only this account's passkeys |
| Sign out | *Sign out* in the console header or on the account page; *Sign out everywhere* revokes every session | Session row deleted |
| Idle | No pointer, key or touch input in any Gauss tab for 15 minutes (operator and admin sessions); a warning a minute before | Sessions unused for 12 hours expire (sliding, refreshed at most every 15 minutes) |

**Step-up rules** live in `backend/rbac.ts`: a policy entry with `stepUp: true` needs a passkey sign-in in the last 5 minutes (`STEP_UP_MAX_AGE_MS`). Marked today: role changes (`POST /api/admin/users/:id/role`), CyberTiger block and unblock, and model training. A test fails if an admin-only change is added without it. The refusal is **428, not 401 or 403**, because CyberTiger counts 401/403 answers and blocks the address; a stale touch is not an attack. Password or Google sessions never count as a touch, and the development bypass (`AUTH_REQUIRED=false`, never in production) counts as stepped up.

**Role changes** (`/api/admin/users`, admin only) refuse changing your own role and demoting the last admin. Logs carry user IDs, not emails. `npm run auth:set-role` stays the way to make the first admin.

**Idle limit:** `VITE_IDLE_SIGNOUT_MINUTES` at build time (default 15, 1 to 240; `0` turns it off, for example on a wall display that is watched, not touched). Activity is shared between tabs through the `gauss.lastActivity` timestamp in local storage.

## The operator geometry

Each operator gets a rotating tesseract of their own: four marked vertices drawn as a path, three lit edges, one of six identity colours and a spin direction in each rotation plane. They come from `SHA-256("gauss-operator-geometry-v1\0" ‖ passkey public key)` (`frontend/src/lib/operator-geometry.ts`). The same passkey always gives the same figure; it opens at a new orientation each time. The letters of the marked vertices (for example `C·H·M·P`) are something to say out loud. The figure uses the same tesseract as the signing-key pattern lock (`frontend/src/lib/tesseract.ts` mirrors `backend/trust/pattern-page.ts`).

It shows on the login page (resolving after the touch), in the console header and on the account page. With more than one passkey, it follows the one this session signed in with.

**It is a recognition cue, not a security control.** It is drawn from the public key, which is not secret: anyone who can read the key can draw the figure, and a fake login page could show any figure it likes. It helps an operator notice whose session is open on a shared screen. The touch is what signs them in.

## Hosts

WebAuthn runs only in a secure context (https, or http on `localhost`), and a passkey belongs to one relying-party ID (the host name).

- Default: RP ID `localhost`. Passkeys work at `http://localhost:8080` (always-on install) and `http://localhost:5173` (dev). Not at `127.0.0.1`: an IP address can't use RP ID `localhost`, so the login page links to the same page at `localhost`.
- The tailnet share (`gauss-services.sh tailnet on`) is plain HTTP, so browsers refuse WebAuthn there and the login page says so. To use passkeys over the tailnet, serve it over HTTPS (`tailscale serve` with HTTPS certificates enabled for the tailnet) and set `PASSKEY_RP_ID=<host>.<tailnet>.ts.net` and `PASSKEY_ORIGINS=https://<host>.<tailnet>.ts.net` in the backend `.env`. Passkeys made at `localhost` don't work at that host, and the other way round: one RP ID per deployment.
- Origins come from `PASSKEY_ORIGINS`, else from `ALLOWED_ORIGINS`, keeping only those that can use the RP ID. The backend logs the result at start (`[backend] passkeys: RP ID …`), and `/api/sso-options` tells the login page (`passkey.rpId`, or `null` when off).

## Limits and rate limiting

- Passkey routes are limited per client address (CyberTiger's address logic): 60 requests a minute across `/api/auth/passkey/*`, and 10 a minute for the two verify routes. Over the limit the answer is 429 with `Retry-After`. `/api/auth` sits in front of CyberTiger, so this limiter is its only throttle.
- Attestation is `none`: Gauss doesn't check which make of authenticator holds the key. A synced passkey (iCloud Keychain, Google Password Manager) is shown as "synced across your devices".
- The server can't tell a biometric from the device PIN; both set the UV flag.

## Deploying

The backend adds the `passkey` table and the session columns `passkeyAt` and `passkeyCredentialId` at start (`ensureAuthSchema()`, additive only, the same as `npm run auth:migrate`). If that fails, the backend doesn't start, and `gauss-services.sh deploy` rolls back.

## Privacy

Passkeys add, per account: the passkey's name, public key, credential ID, counter, AAGUID, device type, backed-up flag, transports and date added, plus each session's passkey time and credential ID. No biometric data. The public site's privacy notice (`website/public/privacy/index.html`) covers the website workspace, not this console; whether it should mention console accounts is Josh's call. The older login fingerprint (`frontend/src/lib/operator-fingerprint.ts`, sent by password sign-in) is unchanged, and passkey sign-in doesn't send it.
