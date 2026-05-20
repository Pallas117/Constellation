#!/usr/bin/env bash
# scripts/closed-loop.sh
# ─────────────────────────────────────────────────────────────────────────────
# Gauss Aurora — Closed-Loop Self-Development Cycle
#
# Runs autonomously on mesh nodes (cron every 3h) or on-demand.
# Sequence:
#   1. Git pull latest
#   2. Install deps (offline-preferred)
#   3. TypeScript type-check
#   4. Security compliance check
#   5. Export Bedrock telemetry → raw JSON feed
#   6. Data refinery (Isolation Forest + IQR validation)
#   7. Dataset builder (sliding windows → JSONL)
#   8. Model training + registry update
#   9. (Optional) Apple MLX LoRA fine-tune if on Apple Silicon
#  10. CyberTiger health check via the REST API
#  11. pm2 restart if available, else signal node process
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${REPO_ROOT}/logs"
LOG_FILE="${LOG_DIR}/closed-loop-$(date +%Y%m%d-%H%M%S).log"
PROXY_PORT="${PROXY_PORT:-3001}"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
  esac
done

mkdir -p "${LOG_DIR}"

log() { echo "[closed-loop] $*" | tee -a "${LOG_FILE}"; }
ok()  { log "[OK] $*"; }
err() { log "[ERR] $*"; }

log "═══════════════════════════════════════════════════"
log "  Gauss Aurora Closed-Loop Cycle — $(date)"
log "═══════════════════════════════════════════════════"

cd "${REPO_ROOT}"

# ── Step 1: Git pull ──────────────────────────────────────────────────────────
log "Step 1: git pull"
if git pull --ff-only 2>>"${LOG_FILE}"; then
  ok "Git up to date"
else
  log "[WARN] git pull failed — continuing with local code"
fi

# ── Step 2: npm install (offline-preferred) ───────────────────────────────────
log "Step 2: npm ci --prefer-offline"
if [[ "${DRY_RUN}" != "true" ]]; then
  npm ci --prefer-offline --silent 2>>"${LOG_FILE}" || npm install --prefer-offline --silent 2>>"${LOG_FILE}" || true
fi

# ── Step 3: TypeScript typecheck ──────────────────────────────────────────────
log "Step 3: tsc --noEmit"
if npx tsc --noEmit 2>>"${LOG_FILE}"; then
  ok "TypeScript clean"
else
  err "TypeScript errors — aborting cycle"
  exit 1
fi

# ── Step 4: Security compliance ───────────────────────────────────────────────
log "Step 4: security compliance"
if npm run --silent check:security-compliance 2>>"${LOG_FILE}"; then
  ok "Security compliance passed"
else
  err "Security compliance failed — aborting cycle"
  exit 1
fi

# ── Step 5: Export Bedrock telemetry → raw feed ───────────────────────────────
log "Step 5: Export Bedrock telemetry"
RAW_FEED="ml/data/raw_feed.json"
mkdir -p ml/data
# Attempt to pull from the running backend; fall back to Bedrock SQLite export
if curl -sf "http://localhost:${PROXY_PORT}/api/feed/space-weather?limit=2000" \
     -o "${RAW_FEED}" 2>>"${LOG_FILE}"; then
  # Wrap in expected {points:[...]} envelope if needed
  python3 -c "
import json, sys
data = json.load(open('${RAW_FEED}'))
if isinstance(data, list):
    json.dump({'points': data}, open('${RAW_FEED}', 'w'))
elif 'points' not in data and 'canonicalPoints' in data:
    data['points'] = data['canonicalPoints']
    json.dump(data, open('${RAW_FEED}', 'w'))
" 2>>"${LOG_FILE}"
  ok "Fetched telemetry from backend API"
else
  log "[WARN] Backend not reachable — using existing raw feed if present"
fi

# ── Step 6: Data Refinery ─────────────────────────────────────────────────────
log "Step 6: Data Refinery (Isolation Forest + IQR)"
CLEAN_FEED="ml/data/clean_feed.json"
if [[ -f "${RAW_FEED}" ]]; then
  python3 ml/refinery/refinery.py \
    --input "${RAW_FEED}" \
    --output "${CLEAN_FEED}" \
    --quarantine ml/data/quarantine.jsonl \
    --report ml/data/refinery_report.json \
    2>>"${LOG_FILE}" && ok "Refinery complete" || log "[WARN] Refinery encountered issues"
else
  log "[WARN] No raw feed found — skipping refinery"
  CLEAN_FEED="${RAW_FEED}"
fi

# ── Step 7: Dataset Builder ───────────────────────────────────────────────────
log "Step 7: Dataset Builder"
if [[ -f "${CLEAN_FEED}" ]]; then
  python3 ml/train/dataset_builder.py \
    --input "${CLEAN_FEED}" \
    --output ml/data/train_dataset.jsonl \
    --input-steps 24 \
    --horizon-steps 12 \
    2>>"${LOG_FILE}" && ok "Dataset built" || log "[WARN] Dataset builder failed"
fi

# ── Step 8: Model Training ────────────────────────────────────────────────────
log "Step 8: Model training"
if [[ -f "ml/data/train_dataset.jsonl" ]]; then
  SAMPLE_COUNT=$(wc -l < ml/data/train_dataset.jsonl)
  log "  Training on ${SAMPLE_COUNT} samples"
  if [[ "${DRY_RUN}" != "true" ]]; then
    python3 ml/train/train_unet.py \
      --dataset ml/data/train_dataset.jsonl \
      --model-version "unet-auto-$(date +%Y%m%d%H%M)" \
      2>>"${LOG_FILE}" && ok "Training complete" || log "[WARN] Training failed"
  else
    ok "(dry-run) Training skipped"
  fi
else
  log "[WARN] No training dataset — skipping training"
fi

# ── Step 9: Apple MLX LoRA fine-tune (Mac/Apple Silicon only) ─────────────────
if command -v python3 >/dev/null 2>&1 && python3 -c "import mlx" 2>/dev/null; then
  log "Step 9: Apple MLX LoRA fine-tune"
  if [[ "${DRY_RUN}" != "true" ]] && [[ -f "ml/train/mlx_lora_finetune.py" ]]; then
    python3 ml/train/mlx_lora_finetune.py 2>>"${LOG_FILE}" && ok "MLX fine-tune complete" || log "[WARN] MLX fine-tune failed"
  fi
else
  log "Step 9: MLX not available — skipping LoRA fine-tune"
fi

# ── Step 10: Service restart ───────────────────────────────────────────────────
log "Step 10: Service health + restart"
if [[ "${DRY_RUN}" != "true" ]]; then
  if command -v pm2 >/dev/null 2>&1; then
    pm2 restart gauss-proxy 2>>"${LOG_FILE}" && ok "pm2 restart OK" || log "[WARN] pm2 restart failed"
  else
    log "[INFO] pm2 not available — send SIGUSR1 to hot-reload if supported"
  fi
fi

log "═══════════════════════════════════════════════════"
log "  Closed-Loop Cycle COMPLETE — $(date)"
log "  Log: ${LOG_FILE}"
log "═══════════════════════════════════════════════════"
