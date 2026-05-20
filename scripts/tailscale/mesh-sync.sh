#!/usr/bin/env bash
# scripts/tailscale/mesh-sync.sh
# ─────────────────────────────────────────────────────────────────────────────
# Propagates Bedrock telemetry and ML model updates to all Tailscale mesh nodes.
# Run on the primary Mac after a closed-loop cycle or when re-connecting online.
#
# Required env vars:
#   MESH_NODES  — comma-separated Tailscale IPs, e.g. "100.64.0.2,100.64.0.3"
#   MESH_USER   — SSH user on remote nodes (default: gauss)
#   MESH_REPO   — path to repo on remote nodes (default: ~/Gauss-Aurora)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

MESH_NODES="${MESH_NODES:-}"
MESH_USER="${MESH_USER:-gauss}"
MESH_REPO="${MESH_REPO:-~/Gauss-Aurora}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { echo "[mesh-sync] $*"; }

if [[ -z "${MESH_NODES}" ]]; then
  log "No MESH_NODES configured. Set MESH_NODES=ip1,ip2 in .env"
  exit 1
fi

# Files to sync to each node
SYNC_PATHS=(
  "ml/data/clean_feed.json"
  "ml/data/train_dataset.jsonl"
  "ml/models/registry.json"
)

IFS=',' read -ra NODES <<< "${MESH_NODES}"

for NODE in "${NODES[@]}"; do
  NODE="$(echo "${NODE}" | tr -d '[:space:]')"
  log "Syncing to node: ${MESH_USER}@${NODE}"

  # Test connectivity
  if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${MESH_USER}@${NODE}" "echo ok" >/dev/null 2>&1; then
    log "[WARN] Cannot reach ${NODE} — skipping"
    continue
  fi

  # Sync ML data and models
  for SYNC_PATH in "${SYNC_PATHS[@]}"; do
    SRC="${REPO_ROOT}/${SYNC_PATH}"
    if [[ -f "${SRC}" ]]; then
      rsync -avz --progress \
        "${SRC}" \
        "${MESH_USER}@${NODE}:${MESH_REPO}/${SYNC_PATH}" \
        2>&1 | sed "s/^/  /" || log "[WARN] rsync failed for ${SYNC_PATH}"
    fi
  done

  # Trigger closed-loop cycle on remote node
  log "Triggering closed-loop on ${NODE}"
  ssh "${MESH_USER}@${NODE}" \
    "cd ${MESH_REPO} && bash scripts/closed-loop.sh >> logs/remote-loop.log 2>&1 &" || \
    log "[WARN] Remote closed-loop trigger failed on ${NODE}"

  log "Node ${NODE} sync complete"
done

log "Mesh sync finished for ${#NODES[@]} node(s)"
