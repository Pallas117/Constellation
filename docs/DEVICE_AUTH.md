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
  - Verifies HMAC proof against a derived device secret.

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

- `DEVICE_AUTH_SECRET`: HMAC secret used to derive per-device secrets.
- Fallback value is used only in local development if the environment variable is not set.

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
