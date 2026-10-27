# JUnit XML for bash test files (GAU-163): one <testcase> per check, named exactly as
# the check, so `npm run verify` matches requirement and FMEA evidence by test name for
# bash tests as it does for node's (scripts/verify/vcrm.ts parseJunit). Bash 3.2 safe.
#   . scripts/ops/junit.sh
#   junit_case <name> <exit-code> [failure detail]   # exit code 0 = pass
#   junit_write <suite name> <file>                  # writes the report atomically
JUNIT_CASES=""; JUNIT_TESTS=0; JUNIT_FAILURES=0

# XML text and attribute values: drop control characters XML 1.0 forbids, then escape
# & first so the entities added after it are not escaped twice. Byte-wise (C locale) so
# UTF-8 names (✓, →) pass through untouched.
junit_esc() {
  printf '%s' "$1" | LC_ALL=C tr -d '\000-\010\013\014\016-\037' \
    | LC_ALL=C sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

junit_case() { # junit_case <name> <exit-code> [failure detail]
  local name; name=$(junit_esc "$1")
  JUNIT_TESTS=$((JUNIT_TESTS + 1))
  if [ "$2" = 0 ]; then
    JUNIT_CASES+="    <testcase name=\"$name\" classname=\"bash\"/>"$'\n'
  else
    JUNIT_FAILURES=$((JUNIT_FAILURES + 1))
    JUNIT_CASES+="    <testcase name=\"$name\" classname=\"bash\"><failure message=\"exit $(junit_esc "$2")\">$(junit_esc "${3:-}")</failure></testcase>"$'\n'
  fi
}

junit_write() { # junit_write <suite name> <file>: temp file then rename, so no reader sees half a report
  local tmp="$2.tmp.$$"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n'
    printf '  <testsuite name="%s" tests="%d" failures="%d">\n' "$(junit_esc "$1")" "$JUNIT_TESTS" "$JUNIT_FAILURES"
    printf '%s' "$JUNIT_CASES"
    printf '  </testsuite>\n</testsuites>\n'
  } >"$tmp" && mv -f "$tmp" "$2"
}
