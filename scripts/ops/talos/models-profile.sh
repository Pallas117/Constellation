#!/usr/bin/env bash
# The "models" profile for Talos: choose a local Ollama coding model from the machine's RAM and VRAM
# and keep Ollama on loopback. Run as your normal user, NOT as root. Usually via
# `bootstrap.sh --profile models`.
#
#   bash models-profile.sh [--apply] [--apply-models] [--dry-run]
#
#   (no option)      report only: facts, the chosen model, what it would change. No sudo, no download.
#   --apply          pin Ollama to 127.0.0.1:11434 with a systemd drop-in (sudo, printed first)
#   --apply-models   run the printed `ollama pull` (a DOWNLOAD: size printed first; needs Josh's OK)
#   --dry-run        print everything, change nothing (works on any OS)
#
# The rule (Apache-2.0 / MIT models only; verify the licence on the model card before pulling):
#   no NVIDIA proprietary driver (CPU only, or nouveau)  -> qwen2.5-coder:1.5b  (Apache-2.0, ~1 GB)
#   proprietary driver, VRAM >= 4 GB                     -> granite-code:3b      (Apache-2.0, ~2 GB)
#   proprietary driver, VRAM >= 6 GB and RAM >= 8 GB     -> qwen2.5-coder:7b     (Apache-2.0, ~4.7 GB)
#   never a 7B under 6 GB VRAM. Qwen2.5-Coder 3B is NOT Apache-2.0 (research licence): not chosen.
# Ollama must stay on loopback: this script never sets 0.0.0.0 and warns if it finds it.
# It also prints (never runs) the NVIDIA proprietary driver steps for Kali, with the Secure Boot caveat.
# Exit: 0 done / reported · 1 refused or bad usage · 7 a step failed
# UNTESTED ON A REAL LINUX HOST (25 Nov 2026): only run against stubs (talos-kit.test.sh).
set -euo pipefail
main() {
  local APPLY=0 AMODELS=0 DRY=0 ROOT="${TALOS_KIT_SYSROOT:-}" FAILED=0
  local KIT; KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=lib.sh
  . "$KIT/lib.sh"
  while [ $# -gt 0 ]; do
    case "$1" in
      --apply) APPLY=1 ;; --apply-models) AMODELS=1 ;; --dry-run) DRY=1 ;;
      -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die 1 "unknown option: $1 (try --help)" ;;
    esac; shift
  done
  refuse_root; require_linux_or_dry
  if [ "$DRY" = 1 ]; then APPLY=0; AMODELS=0; fi
  say "MODELS PROFILE: $([ "$APPLY$AMODELS" = 00 ] && echo 'nothing is changed or downloaded' || echo applying)"

  say "models 1/3 facts"
  local kb ram_gb vram_mb=0 gpu="" driver="none (nouveau or no GPU driver)"
  kb=$(awk '/^MemTotal:/{print $2}' "$ROOT/proc/meminfo" 2>/dev/null || true)
  ram_gb=$(awk -v k="${kb:-0}" 'BEGIN{printf "%d", k/1048576 + 0.5}')
  note "RAM: ${ram_gb} GB (rounded)"
  if command -v lspci >/dev/null 2>&1; then gpu=$(lspci 2>/dev/null | grep -i -E 'vga|3d' | sed 's/^[^ ]* //' | tr '\n' ';' || true); fi
  note "GPU: ${gpu:-unknown (lspci not found)}"
  if command -v nvidia-smi >/dev/null 2>&1; then
    vram_mb=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | sed -n 1p | tr -dc '0-9' || true)
    vram_mb=${vram_mb:-0}
    [ "$vram_mb" -gt 0 ] && driver="NVIDIA proprietary, ${vram_mb} MB VRAM"
  fi
  note "driver: $driver"

  say "models 2/3 choice"
  local model size lic
  model=qwen2.5-coder:1.5b; size="about 1 GB"; lic="Apache-2.0"
  if [ "$vram_mb" -ge 6000 ] && [ "$ram_gb" -ge 8 ]; then model=qwen2.5-coder:7b; size="about 4.7 GB"; lic="Apache-2.0"
  elif [ "$vram_mb" -ge 4000 ]; then model=granite-code:3b; size="about 2 GB"; lic="Apache-2.0"; fi
  note "CODER MODEL: $model (licence $lic; sizes and licences are from memory: check the model card, UNVERIFIED)"
  note "download size: $size"

  say "models 3/3 Ollama on loopback"
  local host="${OLLAMA_HOST:-}"
  if [ -n "$host" ]; then
    case "$host" in
      127.0.0.1*|localhost*|"[::1]"*|http://127.0.0.1*|http://localhost*) note "OLLAMA_HOST=$host (loopback: fine)" ;;
      *) warn "OLLAMA_HOST=$host is not loopback: Ollama would be reachable from the network. Fixed by the drop-in below with --apply" ;;
    esac
  else note "OLLAMA_HOST unset: Ollama's default is 127.0.0.1:11434"; fi
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -E '(0\.0\.0\.0|\*|\[::\]):11434' >/dev/null; then
    warn "port 11434 listens on all interfaces right now: the drop-in below and a restart fix it"
  fi
  local dropin="$ROOT/etc/systemd/system/ollama.service.d/50-gauss-loopback.conf"
  local conf='[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"'
  if [ -f "$dropin" ] && printf '%s\n' "$conf" | cmp -s - "$dropin"; then note "$dropin: already in place"
  elif command -v systemctl >/dev/null 2>&1 && ! systemctl cat ollama.service >/dev/null 2>&1; then
    note "no ollama.service: not installed as a service, nothing to pin (never run it with OLLAMA_HOST=0.0.0.0)"
  else
    local stage="$HOME/.local/state/talos-kit/stage-ollama.conf"
    if [ "$APPLY" = 1 ]; then mkdir -p "$(dirname "$stage")"; printf '%s\n' "$conf" >"$stage"; fi
    sudo_act install -D -m 0644 -o root -g root "$stage" "$dropin" || FAILED=1
    sudo_act systemctl daemon-reload || FAILED=1
    sudo_act systemctl restart ollama.service || FAILED=1
  fi

  say "download"
  if ! command -v ollama >/dev/null 2>&1; then
    note "ollama is not installed: install it from https://ollama.com/download (check the script before running it), then run this again"
  elif [ "$(ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -cx "$model")" != 0 ]; then note "$model: already pulled"
  elif [ "$AMODELS" = 1 ]; then printf '    run: ollama pull %s (%s)\n' "$model" "$size"; ollama pull "$model" || FAILED=1
  else note "to download ($size, needs Josh's OK): ollama pull $model   <- run only with --apply-models"; fi

  say "NVIDIA proprietary driver (printed, never run; Kali, GTX 1050 Mobile + Intel hybrid)"
  note "1. check Secure Boot: mokutil --sb-state. If enabled, the DKMS modules are unsigned and will not load:"
  note "   either enrol a Machine Owner Key at the next boot (sudo mokutil --import <key>, follow the blue screen)"
  note "   or turn Secure Boot off in the firmware. This is a security decision: Josh's call."
  note "2. sudo apt update && sudo apt install -y linux-headers-amd64 nvidia-driver nvidia-smi"
  note "3. reboot; then nvidia-smi should list the GPU and its VRAM. Re-run this profile: it re-picks the model."
  note "   Do not remove the Intel path: on hybrid laptops use PRIME offload for the GPU only where wanted."
  [ "$FAILED" = 0 ] || exit 7
}
main "$@"
