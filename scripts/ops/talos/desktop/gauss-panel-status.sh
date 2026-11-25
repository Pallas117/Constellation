#!/bin/bash
# Xfce panel "genmon" plugin output: one line for the panel, details in the tooltip.
# Local facts only. The merge train line comes from a small file the Mac pushes (never fetched
# from the tailnet here): ~/.local/state/talos-kit/mac-status.txt, first line, shown while newer
# than 30 minutes, otherwise "train: no data".
S="$HOME/.local/state/talos-kit"
argo=$(timeout 3 "$HOME/.local/bin/argo" status 2>/dev/null | sed -n 1p | cut -c1-60); [ -n "$argo" ] || argo="not running"
bat="no battery"
for d in /sys/class/power_supply/BAT*; do
  [ -r "$d/capacity" ] && bat="$(cat "$d/capacity")% $(cat "$d/status" 2>/dev/null)" && break
done
mem=$(awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}END{if(t)printf "%.1f/%.1f GB free", a/1048576, t/1048576}' /proc/meminfo 2>/dev/null)
agents=$(systemctl is-active --quiet gauss-agent.service 2>/dev/null && echo on || echo off)
q=$(ls /var/lib/gauss-agent/spool/*.task 2>/dev/null | wc -l | tr -d ' ')
model=$(timeout 3 ollama ps 2>/dev/null | awk 'NR==2{print $1}'); [ -n "$model" ] || model="none loaded"
train="train: no data"; f="$S/mac-status.txt"
if [ -r "$f" ] && [ -n "$(find "$f" -mmin -30 2>/dev/null)" ]; then train="train: $(sed -n 1p "$f" | tr -d '<>&' | cut -c1-60)"; fi
printf '<txt>%s | %s | agents %s</txt>\n' "$train" "$bat" "$agents"
printf '<tool>Argo: %s\nBattery: %s\nMemory: %s\nAgents: %s (%s queued)\nModel: %s\n%s</tool>\n' "$argo" "$bat" "$mem" "$agents" "$q" "$model" "$train"
