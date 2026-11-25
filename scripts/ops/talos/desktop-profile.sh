#!/usr/bin/env bash
# The "desktop" profile for Talos: a Lightbound look for Xfce, a panel status line and the LightDM
# greeter. Run it as your normal user, NOT as root. Usually via `bootstrap.sh --profile desktop`.
#
#   bash desktop-profile.sh [--apply] [--dry-run]
#
#   (no option)  report only: prints what it would change, changes nothing, never calls sudo
#   --apply      make the changes. User-level files, except the LightDM greeter (sudo, printed first)
#   --dry-run    print everything, change nothing (works on any OS)
#
# Steps (each checks first, so re-running is safe):
#   1. colours: GTK colour tokens, Xfce terminal palette, wallpaper (all in your home)
#   2. panel status: installs ~/.local/bin/gauss-panel-status (genmon). Add the "Generic Monitor"
#      plugin to the Xfce panel by hand and point it at that command (printed; panels are not scripted)
#   3. greeter: /etc/lightdm/lightdm-gtk-greeter.conf.d/50-gauss.conf and the wallpaper (sudo)
#
# Colours: the repo's website tokens (website/public/assets/site.css): ground #050505, warm
# #F3F0E8, accent #CCFF00, muted #87938E. If that file is missing, neutral navy/gold PLACEHOLDERS
# (#081C4D / #B0906F) are used and the report says so.
# Exit: 0 done / reported · 1 refused or bad usage
# UNTESTED ON A REAL LINUX HOST (25 Nov 2026): only run against stubs (talos-kit.test.sh).
set -euo pipefail
main() {
  local APPLY=0 DRY=0 ROOT="${TALOS_KIT_SYSROOT:-}"
  local KIT; KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=lib.sh
  . "$KIT/lib.sh"
  while [ $# -gt 0 ]; do
    case "$1" in
      --apply) APPLY=1 ;; --dry-run) DRY=1 ;;
      -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die 1 "unknown option: $1 (try --help)" ;;
    esac; shift
  done
  refuse_root; require_linux_or_dry
  [ "$DRY" = 0 ] || APPLY=0
  say "DESKTOP PROFILE: $([ "$APPLY" = 1 ] && echo applying || echo 'nothing is changed; add --apply')"
  local css="$KIT/../../../website/public/assets/site.css" bg="#050505" fg="#F3F0E8" ac="#CCFF00" mu="#87938E"
  if [ ! -r "$css" ]; then
    bg="#081C4D"; fg="#F3F0E8"; ac="#B0906F"; mu="#A9ABA6"
    warn "site.css not found: using neutral navy/gold PLACEHOLDER colours"
  fi
  say "desktop 1/3 colours"
  put_user_file "$HOME/.config/gtk-3.0/gtk.css" "/* Lightbound tokens (written by talos-kit desktop-profile.sh) */
@define-color lb_ground $bg;
@define-color lb_text $fg;
@define-color lb_accent $ac;
@define-color lb_muted $mu;
@define-color theme_selected_bg_color @lb_accent;
@define-color theme_selected_fg_color @lb_ground;"
  put_user_file "$HOME/.config/xfce4/terminal/terminalrc" "[Configuration]
ColorForeground=$fg
ColorBackground=$bg
ColorCursor=$ac
FontName=JetBrains Mono 11"
  act xfconf-query -c xsettings -p /Net/ThemeName -n -t string -s Adwaita-dark
  local wp="$HOME/.local/share/backgrounds/lightbound.jpg" src="$KIT/../../../website/public/assets/media/blackhole-poster.jpg"
  if [ -r "$src" ]; then
    if [ -f "$wp" ] && cmp -s "$src" "$wp"; then note "$wp: already in place"
    else act mkdir -p "$(dirname "$wp")"; act cp "$src" "$wp"; fi
  else warn "wallpaper source missing: $src"; fi
  note "fonts: JetBrains Mono / IBM Plex (OFL) are NOT downloaded here; install the official releases yourself if you want them"
  say "desktop 2/3 panel status line"
  local bin="$HOME/.local/bin/gauss-panel-status"
  if [ -f "$bin" ] && cmp -s "$KIT/desktop/gauss-panel-status.sh" "$bin"; then note "$bin: already in place"
  else act install -D -m 0755 "$KIT/desktop/gauss-panel-status.sh" "$bin"; fi
  note "by hand: panel > Add New Items > Generic Monitor; Command $bin; Period 30 s"
  note "merge train line: the Mac writes one line to ~/.local/state/talos-kit/mac-status.txt (Talos never reaches the tailnet for it)"
  say "desktop 3/3 LightDM greeter (sudo)"
  local gdst="$ROOT/etc/lightdm/lightdm-gtk-greeter.conf.d/50-gauss.conf" gwp="$ROOT/usr/share/backgrounds/lightbound.jpg"
  local gconf="[greeter]
background=/usr/share/backgrounds/lightbound.jpg
theme-name=Adwaita-dark
font-name=Sans 11
user-background=false"
  if [ -f "$gdst" ] && printf '%s\n' "$gconf" | cmp -s - "$gdst"; then note "$gdst: already in place"
  else
    local stage="$HOME/.local/state/talos-kit/stage-greeter.conf"
    if [ "$APPLY" = 1 ]; then mkdir -p "$(dirname "$stage")"; printf '%s\n' "$gconf" >"$stage"; fi
    sudo_act install -D -m 0644 -o root -g root "$stage" "$gdst"
    if [ -r "$src" ]; then sudo_act install -D -m 0644 -o root -g root "$src" "$gwp"; fi
  fi
  note "undo: sudo rm /etc/lightdm/lightdm-gtk-greeter.conf.d/50-gauss.conf"
}
main "$@"
