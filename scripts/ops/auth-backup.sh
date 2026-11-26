#!/usr/bin/env bash
# Sign-in database backup, restore test and recovery check (FMEA FM-29; threat model TM-20).
#
#   auth-backup.sh backup  [--db PATH] [--dir DIR] [--keep N]   consistent copy while the backend runs, checked
#   auth-backup.sh verify  [--dir DIR | FILE]                   restore test on a temporary copy (never the live file)
#   auth-backup.sh restore FILE [--db PATH]                     put a checked backup in place; the old file is kept
#
# - The copy is SQLite's online backup (`.backup`), so it is consistent while the backend writes.
# - Each copy is checked (integrity_check and the sign-in tables) before it counts. A copy that
#   fails is deleted (it is our own temporary file), and the run fails so the caller can alert.
# - Copies are readable only by this user (directory 0700, files 0600). They hold emails and password hashes: they
#   stay on this disk (FileVault encrypts it) unless a person copies them elsewhere, encrypted.
# - The newest N copies are kept (default 14); older ones are removed, ours only (auth-*.db in the backup folder).
# - verify also reports how many admins and operators have fewer than two passkeys (counts only, no names), so
#   nobody is one lost phone away from being locked out (TM-20). That table exists once passkeys ship (GAU-235).
# - restore never deletes: the current file moves aside as <db>.before-restore-<time>. Stop the backend first.
#
# Prints one line per run; exit 0 ok, 1 failed, 2 usage. Needs sqlite3 (macOS and most Linux have it).
set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
db="${AUTH_DB_PATH:-$repo/.auth.db}"
if [ "$(uname)" = Darwin ]; then
  dir="${GAUSS_AUTH_BACKUP_DIR:-$HOME/Library/Application Support/Gauss/backups/auth}"
else
  dir="${GAUSS_AUTH_BACKUP_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/gauss/backups/auth}"
fi
keep=14
SQLITE="${SQLITE3:-sqlite3}"

usage() { sed -n '4,6p' "$0" | sed 's/^# //' >&2; exit 2; }
fail() { echo "auth-backup: FAILED: $*"; exit 1; }
q() { "$SQLITE" -batch -noheader "$1" "$2"; } # q <db> <sql>

# check <file>: prints "users=N admins=N operators=N fewpasskeys=N|-" or fails.
check() {
  local f=$1 ok tables role_col
  [ -s "$f" ] || { echo "empty or missing"; return 1; }
  ok=$(q "$f" "PRAGMA integrity_check;" 2>&1 | sed -n 1p) || { echo "unreadable: $ok"; return 1; }
  [ "$ok" = ok ] || { echo "integrity_check: $ok"; return 1; }
  tables=$(q "$f" "SELECT group_concat(name, ' ') FROM sqlite_master WHERE type='table' AND name IN ('user','session','account');")
  for t in user session account; do
    case " $tables " in *" $t "*) ;; *) echo "missing table $t"; return 1 ;; esac
  done
  role_col=$(q "$f" "SELECT count(*) FROM pragma_table_info('user') WHERE name='role';")
  local users admins=0 operators=0 few="-"
  users=$(q "$f" "SELECT count(*) FROM user;")
  if [ "$role_col" = 1 ]; then
    admins=$(q "$f" "SELECT count(*) FROM user WHERE lower(role)='admin';")
    operators=$(q "$f" "SELECT count(*) FROM user WHERE lower(role)='operator';")
  fi
  if [ "$(q "$f" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='passkey';")" = 1 ] && [ "$role_col" = 1 ]; then
    few=$(q "$f" "SELECT count(*) FROM user u WHERE lower(u.role) IN ('admin','operator') AND (SELECT count(*) FROM passkey p WHERE p.userId = u.id) < 2;")
  fi
  echo "users=$users admins=$admins operators=$operators fewpasskeys=$few"
}

newest() { ls -1t "$dir"/auth-*.db 2>/dev/null | sed -n 1p; }

cmd=${1:-}; [ -n "$cmd" ] || usage; shift
file=""
while [ $# -gt 0 ]; do
  case $1 in
    --db) db=${2:?}; shift 2 ;;
    --dir) dir=${2:?}; shift 2 ;;
    --keep) keep=${2:?}; [[ "$keep" =~ ^[1-9][0-9]*$ ]] || usage; shift 2 ;;
    -*) usage ;;
    *) file=$1; shift ;;
  esac
done
command -v "$SQLITE" >/dev/null 2>&1 || fail "no sqlite3"

case $cmd in
  backup)
    [ -s "$db" ] || fail "no sign-in database at $db"
    mkdir -p "$dir" && chmod 700 "$dir"
    out="$dir/auth-$(date -u +%Y%m%dT%H%M%SZ).db"
    tmp="$out.part"
    rm -f "$tmp"
    q "$db" ".backup '$tmp'" >/dev/null || { rm -f "$tmp"; fail "sqlite3 .backup of $db"; }
    if ! summary=$(check "$tmp"); then rm -f "$tmp"; fail "the copy didn't check out: $summary"; fi
    chmod 600 "$tmp" && mv "$tmp" "$out"
    # Keep the newest $keep copies (ours only).
    ls -1t "$dir"/auth-*.db 2>/dev/null | tail -n +"$((keep + 1))" | while IFS= read -r old; do rm -f -- "$old"; done
    printf '{"at":"%s","file":"%s","bytes":%s,%s}\n' "$(date -u +%FT%TZ)" "$(basename "$out")" "$(wc -c < "$out" | tr -d ' ')" \
      "$(echo "$summary" | sed -n 1p | sed -E 's/([a-z]+)=([0-9-]+)/"\1":"\2"/g; s/ /,/g')" >> "$dir/manifest.jsonl"
    echo "auth-backup: ok $(basename "$out") $(echo "$summary" | sed -n 1p) (kept $(ls -1 "$dir"/auth-*.db | wc -l | tr -d ' '))"
    ;;
  verify)
    src=${file:-$(newest)}
    [ -n "$src" ] && [ -f "$src" ] || fail "no backup to test in $dir"
    work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
    cp "$src" "$work/restore-test.db"
    if ! summary=$(check "$work/restore-test.db"); then fail "restore test of $(basename "$src"): $summary"; fi
    line=$(echo "$summary" | sed -n 1p)
    age_h=$(( ( $(date +%s) - $(stat -f %m "$src" 2>/dev/null || stat -c %Y "$src") ) / 3600 ))
    note=""
    case $line in *fewpasskeys=-*) ;; *fewpasskeys=0*) ;; *) note="; WARN: $(sed -E 's/.*fewpasskeys=([0-9]+).*/\1/' <<<"$line") admin/operator account(s) have fewer than two passkeys" ;; esac
    case $line in *admins=0*) note="$note; WARN: no admin account, so a restore leaves nobody able to manage roles (npm run auth:set-role)" ;; esac
    (( age_h > 36 )) && note="$note; WARN: newest backup is ${age_h} h old"
    echo "auth-backup: restore test ok $(basename "$src") ($line, ${age_h} h old)$note"
    ;;
  restore)
    [ -n "$file" ] && [ -f "$file" ] || usage
    if ! summary=$(check "$file"); then fail "won't restore $(basename "$file"): $summary"; fi
    if [ -e "$db" ]; then
      aside="$db.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
      mv "$db" "$aside"
      for ext in -wal -shm; do [ -e "$db$ext" ] && mv "$db$ext" "$aside$ext"; done
      echo "auth-backup: kept the old database as $aside"
    fi
    cp "$file" "$db" && chmod 600 "$db"
    echo "auth-backup: restored $(basename "$file") to $db ($(echo "$summary" | sed -n 1p)). Start the backend, check /health and sign in."
    ;;
  *) usage ;;
esac
