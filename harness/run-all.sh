#!/usr/bin/env bash
# Asserts every engineering-review-loop controller scenario and the argument checks.
# Exits non-zero on any mismatch. Expectations mirror engineering/workflows/engineering-review-loop.md (Maintenance).
# Workflow under test: WF env var, default $HOME/.claude/workflows/engineering-review-loop.js.
set -uo pipefail
cd "$(dirname "$0")"
export WF="${WF:-${HOME}/.claude/workflows/engineering-review-loop.js}"
fail=0
node -e "const s=require('fs').readFileSync(process.argv[1],'utf8').replace('export const meta','const meta');new (Object.getPrototypeOf(async function(){}).constructor)('args',s)" "$WF" \
  && echo "PASS syntax" || { echo "FAIL syntax"; fail=1; }

# scenario | expected verdict | expected needsParent | expected unapplied | expected untracked | [args]
expect() {
  local s="$1" v="$2" np="$3" un="$4" ut="$5" args="${6:-}"
  local out; out=$(HARNESS_JSON=1 node engineering-review-loop.harness.mjs "$s" $args 2>&1 | tail -1)
  local got; got=$(node -e 'const r=JSON.parse(process.argv[1]);console.log([r.verdict,r.needsParent,r.unapplied,r.untracked].join(" "))' "$out" 2>/dev/null)
  if [ "$got" = "$v $np $un $ut" ]; then echo "PASS $s ($got)"; else echo "FAIL $s: expected '$v $np $un $ut' got '${got:-$out}'"; fail=1; fi
}
# A scenario's HARNESS_JSON line must contain this substring. Args are passed to the workflow; the
# optional probe is a prompt text whose engineer calls are reported as probeHits.
rawis() {
  local label="$1" s="$2" want="$3" args="${4:-}" probe="${5:-}"
  local out; out=$(HARNESS_PROBE="$probe" HARNESS_JSON=1 node engineering-review-loop.harness.mjs "$s" $args 2>&1 | tail -1)
  case "$out" in *"$want"*) echo "PASS $label";; *) echo "FAIL $label: wanted '$want' in $out"; fail=1;; esac
}
# An argument check must throw with ITS OWN message, not with any throw (a broken harness also throws).
expectargs() {
  local a="$1" want="$2"
  local out; out=$(node args.harness.mjs "$WF" "$a")
  case "$out" in THROW*) ;; *) echo "FAIL args $a: expected a throw, got: $out"; fail=1; return;; esac
  case "$out" in *"$want"*) echo "PASS args $a";; *) echo "FAIL args $a: wrong error: $out"; fail=1;; esac
}
expect green      green                  false 0 0
expect handoff    green                  false 0 0
expect dropped    green                  false 0 0
expect parallel3  green                  false 0 0
# The checks-runner fails in round 1 then passes: a functional peer claiming testsPassing true cannot
# outrun the runner (this is the case the retired liar/noclaim/bench1 scenarios covered).
expect testsfail  green                  false 0 0
# Round 1's own checks verdict, the blocker the controller raised for the failing suite, and the
# failing command output the engineer was given.
rawis "testsfail round-1 checks verdict"      testsfail '"checksVerdicts":["fail"'
rawis "testsfail controller-raised blocker"   testsfail 'B1.1:(no-file):The deterministic checks are failing'
rawis "testsfail failing text reaches pi"     testsfail '"probeHits":["r1:engineer-1"]' '' 'FAIL src/a.js'
rawis "testsfail engineer names its decisions" testsfail '"probeHits":["r1:engineer-1"]' '' 'the decisions that shaped your change'
expect absroot    green                  false 0 0
expect crossdrop  green                  false 0 0
expect moved      green                  false 0 0
expect collide    green                  false 1 0
# Retired (runner-answer path only): liar, noclaim and bench1 all tested a functional peer lying about
# test results, and while the checks runner answers, its report is the only test evidence, so there is
# nothing left for a peer claim to contradict (covered by testsfail).
# Retired: noclaim's "claimed passing without reporting a test command" cross-check only matters where
# a peer claim is read at all; bench1's kind 'other' refused as test evidence likewise only applies
# there. The unavailable path, where a peer claim IS the evidence, is covered by checksdown-liar below.
# checks-runner answers without its footer -> unavailable -> the functional peer's testsPassing decides.
expect checksdown green                  false 0 0 '{"repo":"/w/repo"}'
# The peer claims its tests passed but its checksRun holds no build or test command: the claim is
# dropped (testsPassing null), so the run can only be green-untested, never green.
expect checksdown-liar green-untested    true  0 0 '{"repo":"/w/repo"}'
rawis "checksdown-liar keeps no test proof" checksdown-liar '"tests":null' '{"repo":"/w/repo"}'
rawis "checksdown-liar fired the liar branch" checksdown-liar '"liarFired":true' '{"repo":"/w/repo"}'
# Every executor pi answer is refused; the fallback answers; the loop still reaches green.
expect executordown    green                  false 0 0
# checks-runner reports verdict none (no automated checks) -> behavior unproven.
expect untested   green-untested         true  0 0
expect consred    review-inconclusive    true  0 0
expect consfail   review-inconclusive    true  0 0
expect revfail    review-failed          true  0 0
expect r2fail     review-failed          true  0 0
expect deferred   blocked-needs-decision true  0 0
expect stuck      stagnated              true  0 0
expect rereport   stagnated              true  0 0
expect badpath    green                  true  0 0
expect refimp     green                  true  1 0
expect impfinal   green                  false 2 0
expect impcap     green                  false 7 0
expect implogfail green                  true  1 1
expect impnobeads green                  true  1 1
expect noref      green                  true  1 1
expect impnone    green                  true  1 1 '{"maxRounds":3,"tracker":"none"}'
# The implementer CLAIMS src/a.js while round-1 checks report changed []: the checks report alone
# decides, so this is a noop, not a reviewed change.
expect implclaim  implement-noop         true  0 0 '{"task":"add-a-flag"}'
# Unavailable runner + no repo arg: the consolidator's repoRoot names the edit root, so the run
# reaches green instead of no-root.
expect checksdownroot     green         false 0 0
# The consolidator's candidate root is confirmed by a root-verify checks run before any clanker edits.
expect rootverify-ok      green         false 0 0
rawis "rootverify-ok asks the runner"      rootverify-ok '"checksCalls":["r1:checks","r1:root-verify"'
rawis "rootverify-ok workdir is the root"  rootverify-ok '"workdirs":["/w/repo"]'
# The runner will not confirm the consolidator's '/home/dev' and reports the real toplevel:
# the run adopts '/w/repo' and continues there. (Before fix batch G this ended 'no-root'.)
expect rootverify-bad     green         false 0 0
rawis "rootverify-bad verified then adopted" rootverify-bad '"checksCalls":["r1:checks","r1:root-verify"'
rawis "rootverify-bad edits in the runner's root" rootverify-bad '"workdirs":["/w/repo"],"workdirsOutside":[]'
# The refused candidate must never reach a clanker as its pi-workdir.
raw=$(HARNESS_JSON=1 node engineering-review-loop.harness.mjs rootverify-bad | tail -1)
bad=$(node -e 'const r=JSON.parse(process.argv[1]);console.log(r.workdirs.concat(r.workdirsOutside).filter((d)=>d!=="/w/repo").join(","))' "$raw" 2>/dev/null)
if [ -z "$bad" ]; then echo "PASS rootverify-bad every pi-workdir is /w/repo"; else echo "FAIL rootverify-bad pi-workdir outside /w/repo ($bad): $raw"; fail=1; fi
# The verify run itself is unavailable: the verify report has no root, so nothing may be edited.
expect rootverify-none    no-root       true  0 0
rawis "rootverify-none edits nothing"   rootverify-none '"workdirs":[],"workdirsOutside":[]'
# A later checks report naming a different toplevel than the accepted consolidator root stops the run.
expect rootconflict       no-root       true  0 0
rawis "rootconflict is in integrity"       rootconflict 'rootConflict'
rawis "rootconflict edits in the accepted root"  rootconflict '"workdirs":["/w/repo"],"workdirsOutside":[]'
# The engineer list names every round an engineer ran: the conflict must stop the run before any
# round-2 clanker is pointed at the disputed tree.
rawis "rootconflict stops before round-2 edits"  rootconflict '"engRounds":["r1"]'
# Same run, but the consolidator names no root either: nothing may edit anything.
# (Boundary guard for the fix above; it also gives no-root before the fix, by construction.)
expect checksdownnoroot   no-root       true  0 0
# A checks answer with the footer but an unreadable report (no `changed` list) is missing evidence,
# not a failing build: no "deterministic checks are failing" blocker, so the run still reaches green.
expect badreport  green                  false 0 0
# Regression guards (they also pass on the pre-fix workflow, so they are not negative controls):
# checks-noreport, checks-badchecks and clanker-prose lock in behavior that already held before the
# root and readability fixes; the expectations that discriminate pre/post fix are the rootverify-*,
# checksdown* and rootconflict ones.
# A footered answer with no JSON in the body, and one whose `checks` is a string: both are missing
# evidence, so both read as unavailable checks, never as a failing build.
expect checks-noreport  green            false 0 0
rawis "checks-noreport is unavailable" checks-noreport '"checksVerdicts":["unavailable","unavailable"]'
expect checks-badchecks green            false 0 0
rawis "checks-badchecks is unavailable" checks-badchecks '"checksVerdicts":["unavailable","unavailable"]'
# A pi engineer that answers prose with no json block: the step is recorded with no files and its
# prose kept as the summary; the loop keeps going instead of throwing.
expect clanker-prose    green            false 0 0
rawis "clanker-prose is recorded unparsed" clanker-prose '0f:I could not put this in JSON'
# An engineer's addressed items carry a numeric id and otherFiles as a string: both are coerced, the
# round survives, and the unanswered blocker stagnates like any other unanswered one.
expect badaddressed stagnated            true  0 0
# args.task + an implementer that reports no files + round-1 checks saw no changed file.
expect implnoop      implement-noop      true  0 0 '{"task":"add-a-flag"}'
# Same, but the only change is under .github/: implement-noop plus an integrity warning.
expect protectedonly implement-noop      true  0 0 '{"task":"add-a-flag"}'
# The implementer's filesChanged is a string, not an array: the merge coerces it, the run must not throw.
expect strfiles   green                  false 0 0 '{"task":"add-a-flag"}'

# A refused improvement keeps its raw path (never "null").
raw=$(HARNESS_JSON=1 node engineering-review-loop.harness.mjs refimp | tail -1)
case "$raw" in *'"unappliedFiles":["/etc/hosts"]'*) echo "PASS refimp keeps raw path";; *) echo "FAIL refimp raw path: $raw"; fail=1;; esac

# With the checks runner unavailable it is the functional peer's testsPassing that sets the verdict.
raw=$(HARNESS_JSON=1 node engineering-review-loop.harness.mjs checksdown '{"repo":"/w/repo"}' | tail -1)
case "$raw" in *'"tests":true'*) echo "PASS checksdown takes test evidence from the functional peer";; *) echo "FAIL checksdown peer evidence: $raw"; fail=1;; esac

# protected-only changes are reported as protectedPathsChanged, not as an empty tree.
raw=$(HARNESS_JSON=1 node engineering-review-loop.harness.mjs protectedonly '{"task":"add-a-flag"}' | tail -1)
case "$raw" in *'"protectedPathsChanged":[".github/workflows/ci.yml"]'*) echo "PASS protectedonly reports protectedPathsChanged";; *) echo "FAIL protectedonly integrity: $raw"; fail=1;; esac

# The implement-noop integrity entry names exactly the files the implementer claimed.
raw=$(HARNESS_JSON=1 node engineering-review-loop.harness.mjs implclaim '{"task":"add-a-flag"}' | tail -1)
case "$raw" in *'"claimedButUnchanged":["src/a.js"]'*) echo "PASS implclaim reports claimedButUnchanged";; *) echo "FAIL implclaim integrity: $raw"; fail=1;; esac

# With no checks runner and no repo arg, the engineer must still be given the consolidator's root.
raw=$(HARNESS_JSON=1 node engineering-review-loop.harness.mjs checksdownroot | tail -1)
case "$raw" in *'"workdirs":["/w/repo"]'*) echo "PASS checksdownroot gives the engineer pi-workdir: /w/repo";; *) echo "FAIL checksdownroot pi-workdir: $raw"; fail=1;; esac

# An unreadable checks report must land on verdict unavailable, exactly like a missing footer.
raw=$(HARNESS_JSON=1 node engineering-review-loop.harness.mjs badreport | tail -1)
case "$raw" in *'"checksVerdicts":["unavailable","unavailable"]'*) echo "PASS badreport counts as unavailable checks";; *) echo "FAIL badreport verdict: $raw"; fail=1;; esac

# The named behaviors, not just the verdicts: which blockers were handed to an engineer, in how many
# rounds, and which files that engineer was given.
# A finding the consolidator dropped without a reason is re-opened and still gets fixed.
rawis "dropped re-opens the dropped finding" dropped 'B1.1:src/a.js:sql injection:unaccounted-by-consolidator'
rawis "dropped edits src/a.js in one round"    dropped '"rounds":2,"unapplied":0,"untracked":0,"refused":0'
rawis "dropped engineer owns src/a.js"         dropped '"engineers":["r1:engineer-1{src/a.js}"]'
# Same for a BLOCKER that only the cross-examination surfaced: it goes to the round-1 engineer's set.
rawis "crossdrop re-opens the cross finding"  crossdrop 'B1.1:src/b.js:race found in cross:unaccounted-by-consolidator'
rawis "crossdrop engineer owns src/b.js only" crossdrop '"engineers":["r1:engineer-1{src/b.js}"]'
# An improvement re-reported at a moved line is one item, applied in the round that carried it: the run
# needs all three rounds and both engineers keep their own file sets.
rawis "moved runs three rounds"              moved '"rounds":3'
rawis "moved keeps the file sets apart"      moved '"engineers":["r1:engineer-1{src/a.js}","r1:engineer-2{src/m.js}","r2:engineer-1{src/a.js}","r2:engineer-2{src/m.js}"]'
rawis "moved leaves nothing unapplied"       moved '"unapplied":0,"untracked":0'
# An absolute path under the git root is normalised to a repository-relative one, not refused, and the
# engineer edits inside the root.
rawis "absroot normalises the absolute path" absroot '"rounds":2,"unapplied":0,"untracked":0,"refused":0,'
rawis "absroot edits inside the root"        absroot '"workdirs":["/w/repo"],"workdirsOutside":[]'
rawis "absroot engineer owns src/a.js"       absroot '"engineers":["r1:engineer-1{src/a.js}"]'
rawis "absroot blocker is at the relative path" absroot 'B1.1:src/a.js:null deref'

# Convergence: pre-existing never blocks; a closed finding is never re-opened; the cap asks for a rethink.
expect preexisting    green  false 0 0
rawis "preexisting is reported, not opened"   preexisting '"preExisting":1'
rawis "preexisting runs no engineer"          preexisting '"engineers":[]'
rawis "preexisting is green in one round"     preexisting '"rounds":1'
expect closedrereport green  false 0 0
rawis "closedrereport suppresses the re-report" closedrereport '"suppressed":1,"closed":["B1.1"]'
rawis "closedrereport is green in two rounds"   closedrereport '"rounds":2'
rawis "closedrereport engineers once"           closedrereport '"engineers":["r1:engineer-1{src/a.js}"]'
expect rejectedrereport green false 0 0
rawis "rejectedrereport closes the rejected ref" rejectedrereport '"closed":["quality.A1","B1.1"]'
rawis "rejectedrereport suppresses the re-report" rejectedrereport '"suppressed":1'
rawis "stuck asks for a rethink"                 stuck '"rethink":true'
rawis "green asks for no rethink"                green '"rethink":false'
# Negative controls: with the guard removed from a copy of the workflow, the paired scenario must change.
MUT=$(mktemp)
sed "s|if (isPreExisting(f)) { notePreExisting(f, round); continue }|if (false) { notePreExisting(f, round); continue }|" "$WF" > "$MUT"
grep -q "if (false) { notePreExisting" "$MUT" || { echo "FAIL negative-control pre-existing: mutation target missing"; fail=1; }
out=$(WF="$MUT" HARNESS_JSON=1 node engineering-review-loop.harness.mjs preexisting 2>&1 | tail -1)
case "$out" in *'"verdict":"green"'*) echo "FAIL negative-control pre-existing: still green with the guard removed"; fail=1;; *) echo "PASS negative-control pre-existing blocks without the guard";; esac
sed "s|if (isClosed(f)) { suppress(f, 'finding'); continue }|if (false) { suppress(f, 'finding'); continue }|" "$WF" > "$MUT"
grep -q "if (false) { suppress(f, 'finding')" "$MUT" || { echo "FAIL negative-control closed: mutation target missing"; fail=1; }
out=$(WF="$MUT" HARNESS_JSON=1 node engineering-review-loop.harness.mjs closedrereport 2>&1 | tail -1)
case "$out" in *'"rounds":2'*) echo "FAIL negative-control closed: still two rounds with the guard removed"; fail=1;; *) echo "PASS negative-control closed re-report re-opens without the guard";; esac
rm -f "$MUT"

# Each case must fail with the message of ITS OWN argument check: headRef, baseRef, repo, maxRounds,
# tracker, unknown key. `expectargs` fails if the throw came from anywhere else.
expectargs '{"headRef":"feature"}'    'headRef must be HEAD'
expectargs '{"baseRef":"main..x"}'    'baseRef must be a plain git ref'
expectargs '{"repo":"relative/path"}' 'repo must be an absolute path'
expectargs '{"maxRounds":9}'          'maxRounds must be an integer 1-8'
expectargs '{"tracker":"jira"}'       'tracker must be auto, beads, github, or none'
expectargs '{"typo":1}'               'unknown arg(s) typo'
# Positive control: with no bad argument the harness must run the loop, not throw. Without this, a
# harness that throws on every call would pass all six checks above.
case "$(node args.harness.mjs "$WF" '{}')" in OK*) echo "PASS args {} runs the loop";; *) echo "FAIL args {}: $(node args.harness.mjs "$WF" '{}')"; fail=1;; esac
[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES ABOVE"
exit "$fail"
