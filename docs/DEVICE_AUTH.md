# Device Authentication and Proofing

This document describes the repository-native device registration and proofing flow.

## Backend

### Routes

- `POST /api/device/register`
  - Authenticated route.
  - Request body: `{ fingerprintHash, fingerprintSignals?, name? }`
  - Creates a device record bound to the authenticated operator.

- `POST /api/device/:id/proof`
  - Authenticated route.
  - Request body: `{ sig, timestamp, nonce? }`
  - Verifies HMAC proof against a derived device secret: `200` marks the device `trusted`,
    `401` marks it `untrusted` (including malformed signatures), and `503` means proofs are
    disabled because `DEVICE_AUTH_SECRET` is not configured (status unchanged).

- `POST /api/device/:id/heartbeat`
  - Authenticated route.
  - Refreshes `lastSeen` on a device.

- `POST /api/device/:id/status`
  - Authenticated route.
  - Updates device `status`, `fingerprintHash`, and other metadata.

- `POST /api/device/:id/quality`
  - Authenticated route.
  - Records quality telemetry for a device.

## Secret

- `DEVICE_AUTH_SECRET`: HMAC key used to derive per-device secrets. Use at least 32 random
  characters, e.g. `openssl rand -hex 32`, in every environment including local development.
- There is no fallback key. If the variable is unset, shorter than 32 characters or a value that
  has been public in this repo, device proofs are disabled (fail closed): `POST /api/device/:id/proof`
  answers `503` and leaves the device status unchanged, and the server logs one error (never the key).
- `npm run check:security-compliance` reports this as control `NIST-IA-3`.
- Rotating the key invalidates every outstanding device proof.

## Frontend

- `frontend/src/lib/device-auth.ts` provides helpers for:
  - Device registration on login
  - Proof submission
  - Heartbeat updates
  - Status updates

- `frontend/src/pages/Login.tsx` now attempts device registration immediately after operator sign-in.

## Notes

- Device proof verification uses `timestamp` and optional `nonce` to prevent replay attacks.
- Proofs must be submitted within `DEVICE_PROOF_TTL_MS` milliseconds (default 60 seconds).
- Device records are stored in the backend in-memory registry and appended to `bedrock` telemetry for persistence.
