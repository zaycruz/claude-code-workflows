#!/usr/bin/env bash
# E2E for tools/red-blue-publish.mjs on real git: a bare origin with a `staging` base, one red
# worktree holding an untracked red test, one fix worktree holding the test plus a fix, and a
# second red worktree that also touched production code. gh and bd are logging fakes on PATH.
# Checks: the dry run changes nothing; --apply pushes only redteam/* and fix/* branches, opens
# draft PRs, files the bead, never merges, never moves staging; the dirty red worktree is refused.
# Usage: bash harness/red-blue-publish.e2e.sh [report.json]
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPORT="${1:+$(cd "$(dirname "$1")" && pwd)/$(basename "$1")}"  # absolute: the script cds away
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fails=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
g() { git -c user.email=e2e@local -c user.name=e2e "$@"; }

mkdir -p "$T/bin"
cat > "$T/bin/gh" <<'SH'
#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_LOG"
n=$(grep -c '^gh pr create' "$FAKE_LOG")
echo "https://github.com/acme/app/pull/$n"
SH
cat > "$T/bin/bd" <<'SH'
#!/usr/bin/env bash
echo "bd $*" >> "$FAKE_LOG"
echo '{"id":"app-r1"}'
SH
chmod +x "$T/bin/gh" "$T/bin/bd"
export FAKE_LOG="$T/fake.log" PATH="$T/bin:$PATH"
: > "$FAKE_LOG"

g init -q --bare "$T/origin.git"
g clone -q "$T/origin.git" "$T/repo" 2>/dev/null
cd "$T/repo"
mkdir -p src e2e
printf 'export const a = (x) => x\n' > src/a.js
g add . && g commit -qm base && g branch -M staging && g push -q -u origin staging
BASE_SHA=$(git rev-parse staging)
g worktree add -q --detach "$T/red" staging
g worktree add -q --detach "$T/blue" staging
g worktree add -q --detach "$T/dirty" staging
mkdir -p "$T/red/e2e" "$T/dirty/e2e"
printf "test('a', () => { expect(a(1)).toBe(2) })\n" > "$T/red/e2e/a.test.mjs"
mkdir -p "$T/red/reports" && printf '{"run":1}\n' > "$T/red/reports/a.json"  # the red run's own artifact, untracked
mkdir -p "$T/blue/e2e" && cp "$T/red/e2e/a.test.mjs" "$T/blue/e2e/a.test.mjs" && printf 'export const a = (x) => x + 1\n' > "$T/blue/src/a.js"
printf "test('b', () => {})\n" > "$T/dirty/e2e/b.test.mjs" && printf 'export const a = (x) => 0\n' > "$T/dirty/src/a.js"

cat > "$T/result.json" <<JSON
{ "status": "done", "base": "origin/staging", "dropped": [{ "title": "not real", "status": "refuted", "reason": "the test is wrong" }],
  "findings": [
    { "id": "f1", "title": "a() is off by one", "severity": "P1", "lens": "errors", "file": "src/a.js", "line": 1,
      "scenario": "a(1)", "expected": "2", "actual": "1", "status": "confirmed", "redDir": "$T/red", "files": ["e2e/a.test.mjs"],
      "redCmd": "npx vitest run e2e/a.test.mjs", "checks": { "verdict": "fail", "head": "CHECKS FAIL - 0/2 passed" },
      "votes": [{ "refuted": false, "reason": "holds" }, { "refuted": false, "reason": "holds" }, { "refuted": true, "reason": "unsure" }],
      "fix": { "status": "passed", "dir": "$T/blue", "rounds": 1, "checks": "CHECKS PASS - 2/2 passed", "nits": [], "preExisting": [{ "severity": "blocker", "scope": "pre-existing", "file": "src/b.js", "issue": "b() never returns" }] },
      "branch": "redteam/a-is-off-by-one", "fixBranch": "fix/a-is-off-by-one" },
    { "id": "f2", "title": "b touched code", "severity": "P2", "lens": "errors", "file": "src/a.js", "line": 1,
      "scenario": "b", "expected": "x", "actual": "y", "status": "confirmed", "redDir": "$T/dirty", "files": ["e2e/b.test.mjs"],
      "redCmd": "npx vitest run e2e/b.test.mjs", "checks": { "verdict": "fail", "head": "x" }, "votes": [],
      "branch": "redteam/b-touched-code", "fixBranch": "fix/b-touched-code" },
    { "id": "f3", "title": "a() returns the input unchanged", "severity": "P2", "lens": "custom", "file": "src/a.js", "line": 1,
      "scenario": "a(1)", "expected": "2", "actual": "1", "status": "confirmed", "redDir": "$T/red", "files": ["e2e/a.test.mjs"],
      "redCmd": "npx vitest run e2e/a.test.mjs", "checks": { "verdict": "fail", "head": "x" }, "votes": [],
      "branch": "redteam/a-returns-the-input-unchanged", "fixBranch": "fix/a-returns-the-input-unchanged" }
  ] }
JSON

PUB="node $HERE/tools/red-blue-publish.mjs"
# 1. dry run: prints, changes nothing
$PUB "$T/result.json" --bd-dir "$T/repo" > "$T/dry.json"; dry=$?
check 'dry run exits 1 (findings refused)' '[ "$dry" = 1 ]'
check 'dry run ran no gh or bd' '[ ! -s "$FAKE_LOG" ]'
check 'dry run made no branch' '! git -C "$T/red" rev-parse -q --verify refs/heads/redteam/a-is-off-by-one >/dev/null'
check 'dry run lists the push' 'grep -q "git push -u origin redteam/a-is-off-by-one" "$T/dry.json"'

# 2. apply
$PUB "$T/result.json" --apply --bd-dir "$T/repo" > "$T/apply.json"; app=$?
check 'apply exits 1 (dirty red worktree refused)' '[ "$app" = 1 ]'
check 'red branch pushed with only the test' '[ "$(git --git-dir="$T/origin.git" diff --name-only staging redteam/a-is-off-by-one)" = "e2e/a.test.mjs" ]'
check 'untracked run artifact left out of the red branch and listed' 'grep -q "reports/a.json" "$T/apply.json" && ! git --git-dir="$T/origin.git" cat-file -e redteam/a-is-off-by-one:reports/a.json 2>/dev/null'
check 'fix branch pushed with test and fix' '[ "$(git --git-dir="$T/origin.git" diff --name-only staging fix/a-is-off-by-one | sort | tr "\n" " ")" = "e2e/a.test.mjs src/a.js " ]'
check 'staging did not move' '[ "$(git --git-dir="$T/origin.git" rev-parse staging)" = "$BASE_SHA" ]'
check 'two draft PRs to staging' '[ "$(grep -c "^gh pr create --draft --base staging" "$FAKE_LOG")" = 2 ]'
check 'red PR titled redteam:' 'grep -q -- "--title redteam: a() is off by one" "$FAKE_LOG"'
check 'fix PR links the red PR and the bead' 'grep -q "Fixes the red team finding https://github.com/acme/app/pull/1, bead app-r1" "$FAKE_LOG"'
check 'fix PR carries the formal verification block' 'grep -q "## Formal verification" "$FAKE_LOG"'
check 'fix PR lists pre-existing defects from the reviewer' 'grep -q "Pre-existing defects the reviewer saw outside this change.*src/b.js: b() never returns" "$FAKE_LOG"'
check 'bead filed as P1 bug' 'grep -q "^bd create redteam: a() is off by one -t bug -p 1" "$FAKE_LOG"'
check 'never merges' '! grep -qiE "^gh pr (merge|ready)|^git merge" "$FAKE_LOG"'
check 'dirty red worktree refused, nothing pushed' 'grep -q "changed tracked files outside the red test: src/a.js" "$T/apply.json" && ! git --git-dir="$T/origin.git" rev-parse -q --verify refs/heads/redteam/b-touched-code >/dev/null'
check 'a second finding with the same red test path is not published' 'grep -q "same red test path as" "$T/apply.json" && ! git --git-dir="$T/origin.git" rev-parse -q --verify refs/heads/redteam/a-returns-the-input-unchanged >/dev/null && [ "$(grep -c "^bd create" "$FAKE_LOG")" = 1 ]'
check 'summary lists the PRs' 'node -e "const s=require(process.argv[1]);process.exit(s.published[0].redPr.endsWith(\"/pull/1\")&&s.published[0].fixPr.endsWith(\"/pull/2\")&&s.published[0].bead===\"app-r1\"?0:1)" "$T/apply.json"'

# 3. the guard refuses a merge or a push to base even if asked by a crafted result
sed -e 's#"branch": "redteam/a-is-off-by-one"#"branch": "staging"#' "$T/result.json" > "$T/evil.json"
$PUB "$T/evil.json" --apply > "$T/evil.out"
check 'a finding whose branch is staging is refused' 'grep -q "bad branch names" "$T/evil.out"'
node -e "
process.argv[1]='x'; const src=require('fs').readFileSync('$HERE/tools/red-blue-publish.mjs','utf8');
const m=src.match(/function guard\(cmd\) \{[\s\S]*?\n\}/)[0]; const BASE='staging'; const guard=new Function('BASE', m+'; return guard')(BASE);
const bad=[['gh','pr','merge','1'],['git','merge','x'],['git','push','-u','origin','staging'],['git','push','origin','redteam/x'],['git','push','-u','origin','main'],['gh','pr','create','--title','x'],['rm','-rf','/']];
const leaked=bad.filter(c=>{try{guard(c);return true}catch{return false}});
process.exit(leaked.length?1:0)"
check 'guard refuses merge, non-draft PR, push to base or other branches, other tools' '[ $? = 0 ]'

echo "$fails FAIL"
[ -n "$REPORT" ] && node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({ test: 'red-blue-publish e2e', fails: $fails }))" "$REPORT"
exit $((fails > 0))
