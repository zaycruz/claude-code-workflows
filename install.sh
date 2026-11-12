#!/usr/bin/env bash
# Install the workflow scripts, the clanker agents and their guard hook into a Claude Code config.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
DEST="${CLAUDE_WORKFLOWS_DIR:-$CFG/workflows}"
GUARD="$CFG/clanker/worker-guard.mjs"
SAVED="$DEST/.workers.json"

usage() {
  echo "usage: install.sh [--check | --dry-run] [--workers claude|pi] [--executor MODEL] [--fallback MODEL] [--checks claude|runner]"
  echo "  (no mode)   run wf-smoke, back up what changes, install, verify"
  echo "  --check     compare the installed files with what this checkout would install; exit 1 on any diff"
  echo "  --dry-run   print the config and the files; write nothing"
  echo "  --workers   claude (default): workers are Claude subagents on --executor (sonnet), escalation on --fallback (opus)"
  echo "              pi: workers run through the pi-agent-for-claude plugin; --executor is required"
  echo "  --checks    claude (default): a Haiku agent runs the tests; runner: the checks-runner plugin"
  echo "  Choices are saved in $SAVED and reused by later runs without flags."
}

# Managed workflows: the top-level *.js files git tracks here, sorted by name.
MANAGED=()
while IFS= read -r f; do
  case "$f" in */*) ;; *) MANAGED+=("$f");; esac
done < <(git -C "$ROOT" ls-files -- '*.js' | sort)
[ ${#MANAGED[@]} -gt 0 ] || { echo "no tracked workflow *.js in $ROOT"; exit 1; }
AGENTS=(clanker-worker clanker-reader clanker-checks)

mode=install
FLAGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --check|--dry-run) mode="${1#--}"; shift ;;
    --workers|--executor|--fallback|--checks)
      [ $# -ge 2 ] || { echo "install: $1 needs a value" >&2; exit 2; }
      FLAGS+=("$1" "$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done
case "$GUARD" in *'"'*|*'\'*|*'$'*|*'`'*) echo "install: the config path $CFG holds a quote, \$, backtick or backslash; set CLAUDE_CONFIG_DIR to a plain path" >&2; exit 2 ;; esac

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
node "$ROOT/lib/workers-config.mjs" resolve "$SAVED" ${FLAGS[@]+"${FLAGS[@]}"} > "$STAGE/workers.json"

# What this checkout installs, rendered with the config: DEST files, agents/, clanker/.
mkdir -p "$STAGE/wf" "$STAGE/agents" "$STAGE/clanker"
for b in "${MANAGED[@]}"; do node "$ROOT/lib/workers-config.mjs" render "$STAGE/workers.json" "$ROOT/$b" > "$STAGE/wf/$b"; done
for a in "${AGENTS[@]}"; do sed "s|__GUARD__|$GUARD|g" "$ROOT/agents/$a.md" > "$STAGE/agents/$a.md"; done
cp "$ROOT/guard/worker-guard.mjs" "$STAGE/clanker/worker-guard.mjs"

# pairs of "staged installed label"
targets() {
  local b a
  for b in "${MANAGED[@]}"; do echo "$STAGE/wf/$b	$DEST/$b	$b"; done
  for a in "${AGENTS[@]}"; do echo "$STAGE/agents/$a.md	$CFG/agents/$a.md	agents/$a.md"; done
  echo "$STAGE/clanker/worker-guard.mjs	$GUARD	clanker/worker-guard.mjs"
}

check() {
  local rc=0 s d l
  while IFS=$'\t' read -r s d l; do
    if [ ! -f "$d" ]; then echo "missing $l"; rc=1
    elif cmp -s "$s" "$d"; then echo "same $l"
    else echo "differs $l"; rc=1
    fi
  done < <(targets)
  return $rc
}

is_managed() {
  local m
  for m in "${MANAGED[@]}"; do [ "$1" = "$m" ] && return 0; done
  return 1
}

stamp="$(date +%Y%m%d-%H%M%S)-$(git -C "$ROOT" describe --always --dirty 2>/dev/null || echo nogit)"
case "$mode" in
  check)
    echo "config: $(cat "$STAGE/workers.json")"
    check
    ;;
  dry-run)
    echo "config: $(cat "$STAGE/workers.json")"
    while IFS=$'\t' read -r _ d l; do echo "would install $l -> $d"; done < <(targets)
    ;;
  install)
    if ! (cd "$ROOT" && node wf-smoke.mjs "${MANAGED[@]}" >/dev/null); then
      echo "wf-smoke failed; not installing (run: node wf-smoke.mjs *.js)"
      exit 1
    fi
    mkdir -p "$DEST" "$CFG/agents" "$CFG/clanker"
    shopt -s nullglob
    existing=("$DEST"/*.js)
    shopt -u nullglob
    if [ ${#existing[@]} -gt 0 ]; then
      bak=$(mktemp -d "$DEST/.bak-$stamp-XXXX")
      cp -p "${existing[@]}" "$bak/"
      echo "backup: $bak"
      trap 'echo "install failed part-way; restore with: cp -p \"$bak\"/*.js \"$DEST\"/" >&2' ERR
    fi
    # An agent file that differs from ours (the user's edit, or an older install) is kept, outside
    # agents/ so Claude Code does not load the copy as a second agent.
    abak=""
    for a in "${AGENTS[@]}"; do
      d="$CFG/agents/$a.md"
      if [ -f "$d" ] && ! cmp -s "$STAGE/agents/$a.md" "$d"; then
        [ -n "$abak" ] || { mkdir -p "$CFG/clanker/backups"; abak=$(mktemp -d "$CFG/clanker/backups/agents-$stamp-XXXX"); }
        cp -p "$d" "$abak/"
      fi
    done
    [ -z "$abak" ] || echo "agent backup: $abak"
    while IFS=$'\t' read -r s d _; do
      cp "$s" "$d.tmp.$$" && mv -f "$d.tmp.$$" "$d"
    done < <(targets)
    cp "$STAGE/workers.json" "$SAVED.tmp.$$" && mv -f "$SAVED.tmp.$$" "$SAVED"
    echo "config: $(cat "$SAVED")"
    check
    shopt -s nullglob
    for f in "$DEST"/*.js; do
      is_managed "$(basename "$f")" || echo "not managed (left alone): $(basename "$f")"
    done
    shopt -u nullglob
    ;;
esac
