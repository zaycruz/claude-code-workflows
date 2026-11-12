#!/usr/bin/env bash
# One red-blue-loop run, headless: the entry point for a person, a cron line or a launchd timer.
#
#   tools/red-blue-run.sh --checkout <dir> --base <ref> [--clone <git url>] [--args '<json>']
#                         [--workflow <name|path.js>] [--out <dir>] [--publish] [--bd-dir <dir>]
#
#   --checkout  a checkout of the target repo, used only by this tool.
#               Cloned from --clone when missing. HEAD is detached at --base.
#   --base      the ref to hunt on, e.g. origin/staging (fetched first) or a local throwaway branch.
#   --args      extra workflow args as JSON (base is filled in), e.g. '{"maxRounds":2,"checks":["npm test"]}'.
#   --workflow  the installed workflow name (default red-blue-loop) or a path to a .js script.
#   --out       where result.json, publish.json and the session log go (default <checkout>/../rbl-runs/<stamp>).
#   --publish   run the publisher with --apply (draft PRs + beads). Without it the publisher is a dry run.
#   --plugin-dir  a plugin the session loads (repeatable), for agents user settings may not enable.
#
# Why a checkout of its own: the workflow's worktrees are made from the session's checkout, and
# the preflight refuses to run unless HEAD is base. A shared checkout would be moved under people.
# The process ends with the run; nothing stays running.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CHECKOUT='' BASE='' CLONE='' EXTRA='{}' WF='red-blue-loop' OUT='' PUBLISH='' BD_DIR='' PLUGINS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --checkout) CHECKOUT="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --clone) CLONE="$2"; shift 2 ;;
    --args) EXTRA="$2"; shift 2 ;;
    --workflow) WF="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --publish) PUBLISH=1; shift ;;
    --bd-dir) BD_DIR="$2"; shift 2 ;;
    --plugin-dir) PLUGINS+=("$2"); shift 2 ;;
    *) echo "red-blue-run: unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$CHECKOUT" ] && [ -n "$BASE" ] || { sed -n '2,19p' "$0"; exit 2; }
PLUGIN_ARGS=()
for p in "${PLUGINS[@]+"${PLUGINS[@]}"}"; do
  [ -f "$p/.claude-plugin/plugin.json" ] || { echo "red-blue-run: $p is not a plugin (no .claude-plugin/plugin.json)" >&2; exit 2; }
  PLUGIN_ARGS+=(--plugin-dir "$p")
done

if [ ! -d "$CHECKOUT/.git" ] && [ ! -f "$CHECKOUT/.git" ]; then
  [ -n "$CLONE" ] || { echo "red-blue-run: $CHECKOUT is not a checkout; pass --clone <url>" >&2; exit 2; }
  git clone -q "$CLONE" "$CHECKOUT"
fi
cd "$CHECKOUT"
[ -z "$(git status --porcelain)" ] || { echo "red-blue-run: $CHECKOUT has local changes; refusing to move it" >&2; exit 2; }
case "$BASE" in origin/*) git fetch -q origin "${BASE#origin/}" ;; esac
git checkout -q --detach "$BASE"
ROOT="$(pwd -P)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-$(dirname "$ROOT")/rbl-runs/$STAMP}"
mkdir -p "$OUT"

ARGS="$(node -e 'const a=JSON.parse(process.argv[1]);a.base=process.argv[2];a.repo=process.argv[3];console.log(JSON.stringify(a))' "$EXTRA" "$BASE" "$ROOT")"
case "$WF" in
  *.js) WF_DIR="$(cd "$(dirname "$WF")" && pwd)"; RUN="the Workflow tool with scriptPath $WF_DIR/$(basename "$WF")"; PLUGIN_ARGS+=(--add-dir "$WF_DIR") ;;
  *) RUN="the Workflow tool with name $WF" ;;
esac
echo "red-blue-run: $ROOT at $(git rev-parse --short HEAD) ($BASE); output in $OUT"
# No worker can push while the workflow runs: a prompt rule does not hold a model (lesson of
# 2026-10-20), so the checkout's push URL is disabled (worktrees share it) and restored only for the publisher.
OLD_PUSHURL="$(git config --get remote.origin.pushurl || true)"
restore_push() { if [ -n "$OLD_PUSHURL" ]; then git -C "$ROOT" config remote.origin.pushurl "$OLD_PUSHURL"; else git -C "$ROOT" config --unset remote.origin.pushurl || true; fi; }
trap restore_push EXIT
git config remote.origin.pushurl "disabled-while-red-blue-loop-runs"

# The prompt goes on stdin: --allowedTools takes a list and would swallow a positional prompt.
printf '%s' "Run $RUN and args $ARGS. Wait for it to complete, then print its returned value as one JSON object and nothing else - no code fences, no commentary." |
  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 claude -p --output-format json "${PLUGIN_ARGS[@]}" \
    --allowedTools 'Workflow,Read,Grep,Glob,Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*)' \
    >"$OUT/session.json" 2>"$OUT/session.err" || true

node -e '
const fs = require("fs")
const [sess, out] = process.argv.slice(1)
let res
try {
  const r = JSON.parse(fs.readFileSync(sess, "utf8")).result
  res = JSON.parse(r.slice(r.indexOf("{"), r.lastIndexOf("}") + 1))
} catch (e) { res = { status: "session-failed", reason: String(e).slice(0, 300) } }
fs.writeFileSync(out, JSON.stringify(res, null, 2))
console.log(`red-blue-run: status ${res.status}; ${(res.findings || []).length} confirmed, ${(res.dropped || []).length} dropped`)
' "$OUT/session.json" "$OUT/result.json"

restore_push
PUB=(node "$HERE/tools/red-blue-publish.mjs" "$OUT/result.json")
[ -n "$PUBLISH" ] && PUB+=(--apply)
[ -n "$BD_DIR" ] && PUB+=(--bd-dir "$BD_DIR")
"${PUB[@]}" >"$OUT/publish.json" || echo "red-blue-run: the publisher refused some findings; see $OUT/publish.json"
echo "red-blue-run: done; result $OUT/result.json, publish $OUT/publish.json"
