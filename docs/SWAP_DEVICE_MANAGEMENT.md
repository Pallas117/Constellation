# SWAP Device Management

This document describes the new spacecraft SWAP (Spacecraft, Work, Automation, Power) monitoring and load distribution system.

## Goals

- Monitor thermal, power, and compute across networked devices.
- Automatically assign tasks across three redundancy layers.
- Preserve device health while keeping operations live.
- Persist telemetry and assignment decisions for R&D and training.

## Layers

- L1: Primary active devices with high health score and lowest thermal/power stress.
- L2: Secondary standby devices that can accept load if L1 is overloaded or degraded.
- L3: Fallback devices for deep redundancy and offload buffering.

## Backend

### New services

- `backend/services/device-swap-manager.ts`
  - Computes health scores from telemetry.
  - Generates swap plans and redundancy tier assignments.
  - Rebalances the network automatically and writes plan events to `bedrock` telemetry.

- `backend/services/device-registry.ts`
  - Adds telemetry ingestion for each device.
  - Maintains device health status and swap metadata.

### New API endpoints

- `POST /api/device/:id/telemetry`
  - Reports thermal, battery, power, compute, and network metrics.

- `GET /api/device/swap/plan`
  - Returns the current SWAP assignment plan for all devices.

- `POST /api/device/swap/rebalance`
  - Recomputes the device plan given workload constraints.

## Automation

- The backend runs a periodic auto-balance loop every `SWAP_BALANCE_INTERVAL_MS`.
- The `SelfHealerAgent` is now started and can trigger ingestion reset or training when system health drifts.
- Device plan decisions are stored to local `bedrock` telemetry so the data path is available for R&D.

## Training & R&D

- Swap plans and telemetry events are appended to `data/bedrock/telemetry.jsonl`.
- This creates a labeled stream of device health, thermal response, and load assignment decisions.
- Future model training can consume these events to improve predictive scheduling and thermal management.
