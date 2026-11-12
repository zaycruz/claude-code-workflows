#!/usr/bin/env bash
# Runs every harness/<workflow>.scenarios.mjs against the workflow of the same name in the repo root.
# Each scenario file prints PASS/FAIL lines and exits non-zero on any FAIL.
set -uo pipefail
cd "$(dirname "$0")"
fail=0
for t in *.scenarios.mjs; do
  [ -e "$t" ] || continue
  # <workflow>.scenarios.mjs, or <workflow>.<variant>.scenarios.mjs (e.g. clanker-loop.claude)
  base="${t%.scenarios.mjs}"
  wf="../${base%%.*}.js"
  echo "-- $t"
  node "$t" "$wf" || fail=1
done
[ "$fail" = 0 ] && echo "SCENARIOS ALL PASS" || echo "SCENARIO FAILURES ABOVE"
exit "$fail"
