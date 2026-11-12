#!/usr/bin/env bash
# The single list of checks. Run this locally and from CI.
set -euo pipefail
cd "$(dirname "$0")"

echo "== workflow compile"
for f in ./*.js; do
  node -e "const s=require('fs').readFileSync(process.argv[1],'utf8').replace(/^export const meta\s*=/m,'const meta =');new (Object.getPrototypeOf(async function(){}).constructor)('args','agent','parallel','pipeline','log','phase','budget','workflow',s)" "$f" || { echo "compile failed: $f"; exit 1; }
done

echo "== syntax"
for f in lib/*.js lib/*.mjs guard/*.mjs wf-smoke.mjs harness/*.mjs verify/*.mjs tools/*.mjs; do node --check "$f" || exit 1; done

echo "== smoke"
node wf-smoke.mjs *.js

echo "== inventory"
node lib/gen-inventory.mjs --check INVENTORY.md

echo "== kit in sync"
node lib/sync-kit.mjs | tee /dev/stderr | tail -1 | grep -qx 'no changes' || { echo "a workflow's kit copy differed from lib/clanker-kit.js; sync-kit rewrote it"; exit 1; }

echo "== no private model names (the pi backend takes models from install.sh flags)"
# Built from parts so this line does not match itself.
pat="za""p/|qw""en|lu""na|openai""-codex"
if git grep -nIiE "$pat" -- . ':!INVENTORY.md'; then echo "a private model name is in the repo"; exit 1; fi

echo "== worker guard (the hook every clanker agent runs under)"
node guard/guard.check.mjs | tail -1

echo "== REVIEW.md (ERL reviewers read it first; clanker-loop checked by scenario V1)"
node harness/review-md.check.mjs engineering-review-loop.js

echo "== perf checklist (ERL performance dimension and the perf-checklist skill agree)"
node harness/perf-checklist.check.mjs engineering-review-loop.js

echo "== harness"
WF="$PWD/engineering-review-loop.js" bash harness/run-all.sh

echo "== scenarios"
bash harness/run-scenarios.sh

echo "== formal verification (clanker-loop gate and executor prompt)"
node harness/clanker-loop.fv.mjs clanker-loop.js >/dev/null

echo "== convergence properties (bounded, generated reviewers; mutants must fail)"
node harness/convergence.props.mjs clanker-loop.js 200 --mutants

echo "== red-blue publisher e2e"
bash harness/red-blue-publish.e2e.sh

echo "== install e2e (throwaway config dir)"
bash harness/install.e2e.sh | tail -1

echo "ci: ALL PASS"
