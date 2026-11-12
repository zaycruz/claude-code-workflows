#!/usr/bin/env bash
# End-to-end check of install.sh against a throwaway config dir. No model.
#
#   bash harness/install.e2e.sh
#
# How the installer can fail, written before the backend flags:
#   I1  a plain install does not give the claude defaults: the installed kit line is not
#       claude/sonnet/opus/claude, or the agents are missing, or their hook still says __GUARD__,
#       or names a guard that is not there.
#   I2  the installed guard does not block: a worker's `git push` through the installed hook exits 0.
#   I3  --workers pi without --executor installs a pi config with no model.
#   I4  a model name with a quote, space or backslash reaches the JS line (code injection).
#   I5  an unknown --workers or --checks value is accepted.
#   I6  a pi install is lost: --check fails right after it, or a plain re-install resets it to claude.
#   I7  --check compares the repo text, not the rendered text, so a correct install reads as differs;
#       or a tampered file reads as same.
#   I8  switching back with --workers claude keeps the pi model names.
#   I9  an agent file of the same name that the user wrote is overwritten without a backup.
#   I10 it writes outside CLAUDE_CONFIG_DIR / CLAUDE_WORKFLOWS_DIR.
#   I11 one install makes more than one backup of the workflows dir.
set -euo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export CLAUDE_CONFIG_DIR="$T/cfg" CLAUDE_WORKFLOWS_DIR="$T/cfg/workflows"
fails=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }
line() { grep -m1 '^const WORKERS = ' "$CLAUDE_WORKFLOWS_DIR/clanker-loop.js"; }
want_line() { echo "const WORKERS = { backend: '$1', executor: '$2', fallback: '$3', checks: '$4' } // install.sh --workers rewrites this line"; }
q() { "$@" >"$T/out" 2>&1; }

# I1, I2
q ./install.sh || { cat "$T/out"; fail 'I1 plain install exits 0'; }
[ "$(line)" = "$(want_line claude sonnet opus claude)" ] && pass 'I1 default line is claude' || fail "I1 default line: $(line)"
G="$CLAUDE_CONFIG_DIR/clanker/worker-guard.mjs"
for a in clanker-worker clanker-reader clanker-checks; do
  f="$CLAUDE_CONFIG_DIR/agents/$a.md"
  if [ -f "$f" ] && ! grep -q __GUARD__ "$f" && grep -qF "node \"$G\"" "$f" && [ -f "$G" ]; then pass "I1 $a installed with the guard path"; else fail "I1 $a"; fi
done
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"},"cwd":"/tmp"}' | node "$G" 2>/dev/null && fail 'I2 installed guard let git push through' || pass 'I2 installed guard blocks git push'
echo '{"tool_name":"Bash","tool_input":{"command":"git status"},"cwd":"/tmp"}' | node "$G" && pass 'I2 installed guard allows git status' || fail 'I2 installed guard blocks git status'

# I3, I4, I5: refused, and nothing changed
before=$(line)
for bad in "--workers pi" "--workers pi --executor a'b" "--workers pi --executor a\\b" "--executor x;y" "--workers gpt" "--checks maybe" "--fallback"; do
  # shellcheck disable=SC2086
  if q ./install.sh $bad; then fail "I3-I5 accepted: $bad"; else pass "I3-I5 refused: $bad"; fi
done
q ./install.sh --workers pi --executor 'a b' && fail 'I4 accepted a model with a space' || pass 'I4 refused a model with a space'
[ "$(line)" = "$before" ] && pass 'I3-I5 a refused install changed nothing' || fail 'I3-I5 a refused install changed the line'

# I6, I7
q ./install.sh --workers pi --executor example/open-model --checks runner || { cat "$T/out"; fail 'I6 pi install exits 0'; }
[ "$(line)" = "$(want_line pi example/open-model example/open-model runner)" ] && pass 'I6 pi line (fallback defaults to the executor)' || fail "I6 pi line: $(line)"
q ./install.sh --check && pass 'I7 --check passes after a pi install' || { cat "$T/out"; fail 'I7 --check after a pi install'; }
q ./install.sh || fail 'I6 plain re-install'
[ "$(line)" = "$(want_line pi example/open-model example/open-model runner)" ] && pass 'I6 plain re-install keeps pi' || fail "I6 re-install reset the line: $(line)"
q ./install.sh --workers pi --executor example/open-model --fallback example/fallback-model || fail 'I6 install with --fallback'
[ "$(line)" = "$(want_line pi example/open-model example/fallback-model claude)" ] && pass 'I6 --fallback, checks back to claude when not given' || fail "I6 fallback line: $(line)"
echo tampered >> "$CLAUDE_WORKFLOWS_DIR/council.js"
q ./install.sh --check && fail 'I7 tampered workflow reads as same' || { grep -q '^differs council.js' "$T/out" && pass 'I7 tampered workflow reads as differs' || fail 'I7 no differs line'; }
echo tampered >> "$CLAUDE_CONFIG_DIR/agents/clanker-worker.md"
q ./install.sh --check && fail 'I7 tampered agent reads as same' || { grep -q 'differs agents/clanker-worker.md' "$T/out" && pass 'I7 tampered agent reads as differs' || fail 'I7 no agent differs line'; }

# I8
q ./install.sh --workers claude || fail 'I8 install --workers claude'
[ "$(line)" = "$(want_line claude sonnet opus claude)" ] && pass 'I8 --workers claude resets the models' || fail "I8 line: $(line)"

# I9: the tampered agent above is the user's edit; the install must have kept a copy (outside
# agents/, so Claude Code does not load the copy as a second agent).
ls "$CLAUDE_CONFIG_DIR"/clanker/backups/*/clanker-worker.md >/dev/null 2>&1 && grep -q tampered "$CLAUDE_CONFIG_DIR"/clanker/backups/*/clanker-worker.md && pass 'I9 changed agent backed up' || fail 'I9 no backup of the changed agent'

# I10: every file written is under the config dir.
stray=$(find "$T" -type f ! -path "$T/cfg/*" ! -path "$T/out" | head -5)
[ -z "$stray" ] && pass 'I10 nothing outside the config dir' || fail "I10 wrote $stray"

# I11
n0=$(ls -d "$CLAUDE_WORKFLOWS_DIR"/.bak-* | wc -l | tr -d ' ')
q ./install.sh || fail 'I11 install'
n1=$(ls -d "$CLAUDE_WORKFLOWS_DIR"/.bak-* | wc -l | tr -d ' ')
[ "$n1" = $((n0 + 1)) ] && pass 'I11 one backup per install' || fail "I11 backups $n0 -> $n1"

[ "$fails" = 0 ] && echo "INSTALL E2E ALL PASS" || { echo "$fails FAIL"; exit 1; }
