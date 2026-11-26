#!/bin/bash
# Runs queued handover tasks for the unprivileged gauss-agent user (see ../agents-profile.sh).
# Installed to /usr/local/lib/gauss/agent-runner.sh (root-owned), started by gauss-agent.service.
#
# Spool: $GAUSS_AGENT_DIR/spool/NAME.task (a text file, the prompt). One task at a time. A task moves to
# done/ or failed/ with its output. Nothing runs unless ALL hold (fail closed):
#   - the credential file exists ($CREDENTIALS_DIRECTORY/anthropic-key, from systemd LoadCredential)
#   - GAUSS_AGENT_CREDIT_CAP_USD is set above 0 and today's recorded spend is below it
# Cost: the command should print a final line COST_USD=<number>; without one, the task counts as
# GAUSS_AGENT_ASSUMED_TASK_USD (default 1). Spend is appended to $GAUSS_AGENT_DIR/spend.tsv.
# The key goes only into the command's environment; it is never printed or written.
# GAUSS_AGENT_ONCE=1 does one pass and exits (tests). GAUSS_AGENT_CMD default: claude -p (reads the task
# on stdin). UNTESTED ON A REAL LINUX HOST (25 Nov 2026).
set -uo pipefail
set +x
D="${GAUSS_AGENT_DIR:-/var/lib/gauss-agent}"
CAP="${GAUSS_AGENT_CREDIT_CAP_USD:-0}"; ASSUMED="${GAUSS_AGENT_ASSUMED_TASK_USD:-1}"
CMD="${GAUSS_AGENT_CMD:-claude -p}"; TMAX="${GAUSS_AGENT_TASK_SECONDS:-1800}"
KEYF="${CREDENTIALS_DIRECTORY:-/nonexistent}/anthropic-key"
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
mkdir -p "$D/spool" "$D/done" "$D/failed" 2>/dev/null
spent_today() { awk -F'\t' -v d="$(date +%F)" '$1==d{s+=$2}END{printf "%.4f", s+0}' "$D/spend.tsv" 2>/dev/null || echo 0; }
over_cap() { awk -v c="$CAP" -v s="$(spent_today)" 'BEGIN{exit !(c+0<=0 || s+0>=c+0)}'; }
pass() {
  if [ ! -r "$KEYF" ]; then log "OFF: no credential (create /etc/gauss-agent/anthropic.key, see README)"; return 1; fi
  if over_cap; then log "OFF: credit cap $CAP USD not set or already spent today ($(spent_today))"; return 1; fi
  local t out cost
  for t in "$D"/spool/*.task; do
    [ -e "$t" ] || continue
    over_cap && { log "cap reached: stopping"; return 1; }
    out="$D/done/$(basename "$t" .task).out"
    log "running $(basename "$t")"
    # shellcheck disable=SC2086
    if ANTHROPIC_API_KEY="$(cat "$KEYF")" timeout "$TMAX" $CMD <"$t" >"$out" 2>&1; then mv "$t" "$D/done/"
    else mv "$t" "$D/failed/"; mv "$out" "$D/failed/" 2>/dev/null; log "failed: $(basename "$t")"; fi
    cost=$(sed -n 's/^COST_USD=\([0-9.]*\)$/\1/p' "$out" "$D/failed/$(basename "$out")" 2>/dev/null | tail -1)
    printf '%s\t%s\n' "$(date +%F)" "${cost:-$ASSUMED}" >>"$D/spend.tsv"
  done
  return 0
}
if [ "${GAUSS_AGENT_ONCE:-0}" = 1 ]; then pass; exit 0; fi
while :; do pass || true; sleep 60; done
