# red-blue-loop

The owner, 2026-10-26: "why don't we have a red team, blue team round the clock finding bugs and
patching them? We have end to end testing, we have formal verification. How are we still
having bugs leave?"

The red team finds bugs and proves each one with a failing test. The blue team fixes each
proven bug, and the red test is the check that the fix must pass. Nothing is committed,
pushed or merged by the workflow. A separate deterministic script (`tools/red-blue-publish.mjs`)
turns the result into draft PRs and beads. That script never merges either.

## Shape

```
preflight (checks runner: HEAD == base)
round r = 1..maxRounds:
  Find     one read-only clanker per lens -> suspicions (JSON)
  Dedup    plain code: drop keys already seen (this run, or `known` from earlier runs); cap at maxFindings
  Prove    per suspicion: a clanker in its own worktree writes a failing test, and only tests
  Check    checks runner (no model) runs the red command twice: both runs must fail
  Verify   3 Claude skeptics try to refute (is the test right? is the behaviour really wrong?)
  stop when the round confirms nothing new
Fix        clanker-loop (nested workflow) per confirmed finding: copy the red test byte for byte,
           smallest fix; checks = cmp against the red copy + the red command + the repo checks
return     findings (confirmed with red worktree, fix worktree), dropped (with reasons), next
```

Why the side effects are outside the workflow: the workflow policy (`wf-smoke.mjs`) allows no
Claude writer, and a clanker must not commit or push. PRs and beads are side effects that need
credentials and must be repeatable, so a plain script does them from the returned JSON, and it
can run with `--dry-run`.

Why the red command is built by the workflow: a clanker's text is untrusted. The prover returns
only test file paths. The workflow checks each path and builds the command from the `redCmd`
template (default `npx vitest run {files}`), so a clanker cannot put its own command on a
`checks-run:` line.

Why worktrees come from the session's checkout: `agent({isolation: 'worktree'})` makes the
worktree from the repository the session runs in. So the workflow runs from inside a checkout of
the target repo at `base`; the preflight proves HEAD is `base` before any model runs.
`tools/red-blue-run.sh` makes that checkout and runs a headless session there, which is also the
scheduled ("round the clock") entry point.

## Failure modes (written before the code)

Each line: the failure, then the guard. `S<n>` is the scenario in
`harness/red-blue-loop.scenarios.mjs` that shows the guard, `P` is a property of the bounded
check, `T` is a TLA+ property in `verify/RedBlueLoop.tla`.

1. A bug is reported with no proof. Guard: `confirmed` needs a checks-runner verdict `fail` on
   the red command. Checks `unavailable`, `none` or `pass` is not proof; the finding is dropped
   as `unproven` and logged. (S3, S4, P1, T ConfirmedIsProven)
2. The red test is flaky: it failed once by chance. Guard: the red command runs twice in one
   checks call; both must fail. (S5, P1)
3. The red test fails for the wrong reason (syntax error, missing import, environment). Guard:
   the skeptics read the failure output and the test; the prompt makes "fails for an unrelated
   reason" a refutation. (S6)
3b. The red command ran no test at all (a file name the runner does not pick up; vitest exits 1
   with "No test files found"). Guard: output that says no test ran is `unproven`, and the prover
   is told to follow the runner config. (S17)
4. The red team fixes the code, or changes production code to make a bug appear. Guard: every
   changed file must be one of the declared test files and match the test-path pattern; else
   dropped as `touched-code`. (S7, P2) The publisher checks again: a tracked file changed outside
   the test is refused; untracked files the red run wrote (a test's own report, such as
   `reports/e2e/x.json`) are listed as `unstaged` and never staged. (publisher E2E)
5. The prover changed nothing, or returned no test files. Guard: dropped as `no-test`. (S8)
6. The prover put its own command into the checks run. Guard: the prover returns paths only;
   each path must match `^[A-Za-z0-9_][A-Za-z0-9_./@+-]*$` with no `..`; the workflow builds the
   command. (S9)
7. The same bug is found by two lenses, or again in the next round, or was already published by
   an earlier run. Guard: a normalised key (file + title words) is checked against `seen`, which
   starts with `known`. Refuted and dropped keys stay in `seen`, so they do not come back every
   round. (S10, P3, T NoRework) Title keys miss one bug worded two ways (the first E2E run
   confirmed the seeded CSRF bug twice, once per lens). The publisher refuses a later finding
   whose red test adds the same path as an earlier one and names the twin; a person compares them.
   It is not merged in the workflow: provers often pick the same test file name for different bugs.
8. The loop never ends. Guard: `maxRounds` (1-5), and a round that confirms nothing new stops
   the loop. (S11, P4, T Terminates)
9. Something merges. Guard: no stage merges, every clanker prompt forbids commit, push and
   merge, and the publisher has no merge path and refuses to push to `base`. (S12, P5, T NoMerge,
   publisher E2E)
10. The blue team weakens or deletes the red test. Guard: the fix's first check copies the exact
    red test from the red worktree over whatever is in the fix worktree, then the red command
    runs; so the fix can only pass by fixing the code. The clanker is told the same. (S13)
11. The fix passes the red test and breaks something else. Guard: the fix's checks also run
    `checks`. Without `checks` the fix is checked against its red test only, and the run logs
    that. Pass the typecheck and the suite. (S13)
12. The blue team works on a finding that was not confirmed. Guard: only confirmed findings go
    to clanker-loop. (S12, P6, T FixOnlyConfirmed)
13. Repository text tells a model what to do (prompt injection). Guard: suspicions, reports and
    test files reach a model only inside `fence()` with the untrusted-data rule.
14. The executor model is down. Guard: on the pi backend the kit's `clank()` retries once on the
    fallback model, which is never the first choice; on the claude backend `agent()` retries API errors.
    (S14)
15. The checkout is not at `base`, or the repo is the wrong one. Guard: the preflight checks
    runner must pass `test "$(git rev-parse HEAD)" = "$(git rev-parse <base>)"`; otherwise the
    run stops before any model call and returns `aborted`. (S2)
16. A skeptic dies or returns nothing. Guard: a missing vote counts as a refutation. (S6)
17. `maxFindings` drops work silently. Guard: capped suspicions are returned as `capped` and
    logged. (S15)
18. Bad args. Guard: rejected before any agent call. (S1)
19. clanker-loop is missing or throws. Guard: the fix stage returns `fix-unavailable`; the red
    findings are still returned. (S16)
20. PII in a PR, a bead or a test. Guard: the prover prompt asks for synthetic data only; the
    publisher builds titles and bodies from the structured fields, not from free text it did not
    check. This is a prompt rule, not a proof: the PR reviewer still has to look.
21. A seeded bug lands on staging. Guard: seeds go on a throwaway branch; the publisher refuses
    to push to `base` and only pushes `redteam/*` and `fix/*` branches.

22. The blue fix is blocked, or clanker-loop's result gains fields. Guard: only a status that
    starts with `passed` counts as fixed; the open findings, and on newer clanker-loop versions
    `rethink` and `preExisting`, are carried into the finding. The publisher lists pre-existing
    defects in the fix PR as leads for the next run. (S18, publisher E2E)

## Usage

From inside a checkout of the target repo at `base`:

```
Workflow red-blue-loop {base: "origin/staging", maxRounds: 2, maxFindings: 6,
  redCmd: "npx vitest run {files}", checks: ["npm run typecheck", "npm test"],
  targets: ["src/db-labels.ts", "PR #65"], seeds: ["qe-d9lo: macros placeholder regex ..."],
  known: ["redteam: scx tenant leak in db-labels"], fix: true}
```

Headless and on a schedule: `tools/red-blue-run.sh` (see its header). It fetches, checks out
`base` detached in its own worktree, runs the workflow in a headless Claude session, writes the
result JSON, and runs the publisher (dry run unless `--publish`).
