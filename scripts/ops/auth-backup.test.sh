#!/usr/bin/env bash
# Tests for scripts/ops/auth-backup.sh on a throwaway sign-in database (no real data, no network).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
S="$here/auth-backup.sh"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
pass=0; failed=0
ok() { pass=$((pass + 1)); }
bad() { failed=$((failed + 1)); echo "not ok: $*"; }
# GAUSS_OPS_JUNIT=<file>: one JUnit case per section, named as the section (the verify gate matches FMEA evidence by name).
JUNIT="${GAUSS_OPS_JUNIT:-}"; [ -z "$JUNIT" ] || . "$here/junit.sh"
cur=""; cur_failed=0
section() { # section <name>: closes the previous section's case, opens the next
  if [ -n "$cur" ] && [ -n "$JUNIT" ]; then junit_case "$cur" "$([ "$failed" -eq "$cur_failed" ] && echo 0 || echo 1)"; fi
  cur=$1; cur_failed=$failed
}
expect() { # expect <name> <pattern> <output>
  if grep -Eq -- "$2" <<<"$3"; then ok; else bad "$1: wanted /$2/ in: $3"; fi
}

db="$t/live/.auth.db"; dir="$t/backups"
mkdir -p "$t/live"
sqlite3 "$db" "
  CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, role TEXT);
  CREATE TABLE session (id TEXT PRIMARY KEY, userId TEXT, token TEXT);
  CREATE TABLE account (id TEXT PRIMARY KEY, userId TEXT, password TEXT);
  INSERT INTO user VALUES ('u1','a@example.test','admin'),('u2','o@example.test','operator'),('u3','v@example.test','user');
"

# 1. Backup: a checked copy, private, with a manifest line.
section "auth backup: a checked, private copy with a counts-only manifest"
out=$("$S" backup --db "$db" --dir "$dir" 2>&1); rc=$?
[ $rc -eq 0 ] && ok || bad "backup exit $rc: $out"
expect "backup line" '^auth-backup: ok auth-[0-9TZ]+\.db users=3 admins=1 operators=1 fewpasskeys=-' "$out"
f=$(ls "$dir"/auth-*.db | sed -n 1p)
[ "$(stat -f %Lp "$f" 2>/dev/null || stat -c %a "$f")" = 600 ] && ok || bad "copy is not 0600"
[ "$(stat -f %Lp "$dir" 2>/dev/null || stat -c %a "$dir")" = 700 ] && ok || bad "folder is not 0700"
expect "manifest" '"users":"3","admins":"1","operators":"1","fewpasskeys":"-"' "$(cat "$dir/manifest.jsonl")"
grep -q 'example.test' "$dir/manifest.jsonl" && bad "manifest must hold counts only, no emails" || ok
ls "$dir"/*.part >/dev/null 2>&1 && bad "a .part file was left" || ok

# 2. Restore test on a temporary copy; passkeys counted once the table exists.
section "auth backup: restore test on a temporary copy warns when admins have fewer than two passkeys"
out=$("$S" verify --dir "$dir" 2>&1); rc=$?
[ $rc -eq 0 ] && ok || bad "verify exit $rc: $out"
expect "verify line" '^auth-backup: restore test ok auth-.*users=3 admins=1 operators=1 fewpasskeys=-, 0 h old\)$' "$out"
sqlite3 "$db" "CREATE TABLE passkey (id TEXT PRIMARY KEY, userId TEXT); INSERT INTO passkey VALUES ('p1','u1'),('p2','u1'),('p3','u2');"
sleep 1; "$S" backup --db "$db" --dir "$dir" >/dev/null
out=$("$S" verify --dir "$dir" 2>&1)
expect "passkey warning" 'fewpasskeys=1.*WARN: 1 admin/operator account\(s\) have fewer than two passkeys' "$out"

# 3. Keep only the newest N.
section "auth backup: keeps only the newest N copies"
for i in 1 2 3; do sleep 1; "$S" backup --db "$db" --dir "$dir" --keep 3 >/dev/null; done
[ "$(ls "$dir"/auth-*.db | wc -l | tr -d ' ')" = 3 ] && ok || bad "keep 3: $(ls "$dir")"

# 4. A corrupt or wrong file never counts as a backup; a missing database fails.
section "auth backup: a corrupt or wrong file never counts and a missing database fails"
printf 'not a database' > "$t/corrupt.db"
out=$("$S" verify "$t/corrupt.db" 2>&1); rc=$?
[ $rc -eq 1 ] && ok || bad "verify of a corrupt file should fail (exit $rc)"
expect "corrupt" 'FAILED: restore test of corrupt.db' "$out"
sqlite3 "$t/other.db" "CREATE TABLE user (id TEXT);"
out=$("$S" backup --db "$t/other.db" --dir "$t/b2" 2>&1); rc=$?
[ $rc -eq 1 ] && ok || bad "backup of a database without the sign-in tables should fail"
expect "missing tables" 'missing table session' "$out"
ls "$t/b2"/auth-*.db >/dev/null 2>&1 && bad "a failed copy must not be kept" || ok
out=$("$S" backup --db "$t/nope.db" --dir "$dir" 2>&1); rc=$?
[ $rc -eq 1 ] && ok || bad "missing database should fail"

# 5. No admin: a warning, not a failure.
section "auth backup: no admin account is a warning, not a failure"
sqlite3 "$t/noadmin.db" "CREATE TABLE user (id TEXT, role TEXT); CREATE TABLE session (id TEXT); CREATE TABLE account (id TEXT); INSERT INTO user VALUES ('x','user');"
out=$("$S" verify "$t/noadmin.db" 2>&1); rc=$?
[ $rc -eq 0 ] && ok || bad "no admin should warn, not fail"
expect "no admin" 'WARN: no admin account' "$out"

# 6. Restore keeps the old file aside and never deletes it.
section "auth backup: restore keeps the old database aside and refuses a bad file"
newest=$(ls -1t "$dir"/auth-*.db | sed -n 1p)
sqlite3 "$db" "INSERT INTO user VALUES ('u4','late@example.test','user');"
out=$("$S" restore "$newest" --db "$db" 2>&1); rc=$?
[ $rc -eq 0 ] && ok || bad "restore exit $rc: $out"
aside=$(ls "$t/live"/.auth.db.before-restore-* 2>/dev/null | sed -n 1p)
[ -n "$aside" ] && [ "$(sqlite3 "$aside" 'SELECT count(*) FROM user;')" = 4 ] && ok || bad "old database not kept aside"
[ "$(sqlite3 "$db" 'SELECT count(*) FROM user;')" = 3 ] && ok || bad "restored database has the backup's rows"
out=$("$S" restore "$t/corrupt.db" --db "$db" 2>&1); rc=$?
[ $rc -eq 1 ] && ok || bad "restoring a corrupt file must be refused"
[ "$(sqlite3 "$db" 'SELECT count(*) FROM user;')" = 3 ] && ok || bad "a refused restore must leave the database alone"

# 7. Usage.
section "auth backup: usage errors exit 2"
"$S" >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "no command: exit 2"
"$S" backup --keep 0 >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "--keep 0: exit 2"

section ""
[ -z "$JUNIT" ] || junit_write auth-backup "$JUNIT"
echo "auth-backup tests: $pass passed, $failed failed"
[ $failed -eq 0 ]
