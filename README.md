# claude-code-workflows

Workflow scripts for Claude Code's Workflow tool. Each workflow splits the work up:
cheaper workers do the typing, a checks step runs the tests, and Claude reviews.
They run in a stock Claude Code install. No plugin is required.

## How a workflow runs

- **Claude coordinates.** The session that starts the workflow writes the tasks,
  picks the models and decides what to merge.
- **Workers ("clankers") write the code.** By default each worker is a Claude
  subagent on Sonnet in its own git worktree. When a worker hits the round cap, one
  rethink runs on Opus.
- **A checks step runs the tests.** By default a Haiku subagent runs the
  project's tests, linters and type checks. Pass/fail comes from the exit codes,
  not from the model's opinion. The reviewer is told that a model ran them.
- **Claude reviews.** Sonnet by default, Opus when a task is risky (production,
  CI gates, auth, secrets, schemas, migrations). Failing checks go straight back
  to the worker without a review.
- **Nothing is committed, pushed or merged.** You get uncommitted changes in a
  worktree and a report. What happens next is up to you.

## Workflows

| Workflow | What it does |
| --- | --- |
| `clanker-loop` | The default way to get code written. Each task runs in a worktree: worker, then checks, then review, for up to 3 rounds. |
| `engineering-review-loop` | An opt-in deep audit of the checked-out branch. It covers quality, correctness and performance, with peer and adversary reviewers. Workers fix the findings. |
| `red-blue-loop` | The red team proves each bug with a failing test. The blue team fixes each proven bug, with that test as its check. |
| `feature-pipeline` | Takes a feature brief through research, a spec, implementation and review. |
| `artifact-review-loop` | A review-and-rewrite loop for documents, plans and specs. |
| `council` | 2 to 4 read-only advisors argue a decision, and a Claude supervisor writes the decision memo. |
| `research` | Read-only research in two modes. `clarify`: what we know and what is unclear. `answer`: a sourced answer to a question. |
| `gather-context`, `parallel-research` | Aliases of `research` in its two modes. |

[`INVENTORY.md`](INVENTORY.md) lists each workflow's arguments and phases. It is
generated from the scripts.

## Requirements

- A Claude Code build that has the Workflow tool.
- Node.js 20 or later, and git.
- macOS or Linux. The installer is a bash script.

## Install

```sh
git clone https://github.com/zaycruz/claude-code-workflows
cd claude-code-workflows
./install.sh            # runs the smoke test, backs up what it replaces, installs, verifies
./install.sh --check    # compares the installed files with this checkout; exits 1 on any difference
./install.sh --dry-run  # shows the config and the files; writes nothing
```

The installer writes to these places. `$CLAUDE_CONFIG_DIR` defaults to `~/.claude`.

| What | Where |
| --- | --- |
| Workflow scripts | `$CLAUDE_WORKFLOWS_DIR`, default `$CLAUDE_CONFIG_DIR/workflows` |
| Agents `clanker-worker`, `clanker-reader`, `clanker-checks` | `$CLAUDE_CONFIG_DIR/agents/` |
| The guard hook those agents run under | `$CLAUDE_CONFIG_DIR/clanker/worker-guard.mjs` |
| Your backend choice | `$CLAUDE_WORKFLOWS_DIR/.workers.json`. Later runs without flags reuse it. |

Before it replaces workflow scripts, the installer copies them to a `.bak-*`
directory. If you changed one of the agent files, the installer copies your
version to `$CLAUDE_CONFIG_DIR/clanker/backups/` first. It never deletes files.
Scripts in the workflows directory that it does not manage are listed and left
alone.

## Backends

The default needs nothing but Claude:

```sh
./install.sh                                    # workers: Claude Sonnet, rethink: Opus, checks: Claude Haiku
./install.sh --executor opus --fallback opus    # other Claude models
```

**Open-model workers (optional).** If you run the `pi-agent-for-claude` plugin
and the `pi` CLI, workers can run on any model pi can reach:

```sh
./install.sh --workers pi --executor <provider/model> [--fallback <provider/model>]
```

On this backend, a worker call that fails on the executor model is retried once
on the fallback model. The fallback defaults to the executor. Coordination and
review stay on Claude. `./install.sh --workers claude` switches back.

**Deterministic checks (optional).** `--checks runner` sends the checks step to
a `checks-runner:checks` plugin agent instead of the Haiku agent. This repo does
not ship that plugin.

## Safety model, and its limits

The rules are enforced by code. A rule written only in a prompt does not hold a model.
Each clanker agent runs under `worker-guard.mjs`, a `PreToolUse` hook in the agent's
own frontmatter, so the hook applies to that agent and not to your session. The
hook blocks the following:

- Git commands that write history or reach a remote: `push`, `commit`, `merge`,
  `rebase`, `reset`, `tag`, `fetch`, `pull` and similar. Also remote and
  credential config, adding or removing worktrees, and deleting branches.
- `gh` commands that write. Only `pr`/`issue`/`repo`/`run` view, list, diff and
  checks are allowed.
- Reading credentials: `~/.ssh`, `.aws/credentials`, `.netrc`, `.git-credentials`,
  gh and docker config, `op`, and the keychain.
- `ssh`, `scp`, `sftp`, `kill`, `pkill`, `killall`. Publishing packages or images.
- `Write`, `Edit` and `NotebookEdit` outside the agent's directory, its repo's
  linked worktrees and the temp dir. Symlinks that lead out of these places are
  also blocked.
- Malformed hook input, and any error in the guard itself. In both cases the call
  is blocked: the guard fails closed.

The guard has these limits:

- **It reads commands; it is not a sandbox.** A Bash command can write files
  outside the work tree, for example `python -c "open('/etc/x','w')"` or
  `echo x > ~/file`. A determined model can hide a blocked command from the
  parser. For a hard boundary, also turn on Claude Code's sandbox.
- **Some workflows edit your checkout on purpose.** `engineering-review-loop`
  fixes findings in the checked-out working tree. `clanker-loop` and
  `red-blue-loop` work in separate worktrees.
- **The agents must stay user agents.** Claude Code ignores frontmatter hooks
  in plugin agents. It also skips them in project agents (`.claude/agents/`)
  until the folder's trust dialog has been accepted, and a headless `claude -p`
  run never accepts it. The installer therefore writes the agents to
  `$CLAUDE_CONFIG_DIR/agents/`, where the hook always runs. Copied anywhere
  else, the agents run without their guard.
- **The checks agent works under your session's permissions.** It runs each
  command as `cd <worktree> && pwd && <command>`, and runs
  `git -C <worktree> status` and `rev-parse`. The `pwd` line shows where each
  command ran. Checks that ran anywhere else count as unavailable, never as a
  pass. With Claude Code's default worktree location,
  inside the repo, nothing extra is needed. If a `WorktreeCreate` hook puts
  worktrees somewhere else, allow that directory for the session, for example
  with `--add-dir` in a headless run. In a headless run, the allowed tools must
  also cover those commands. A command that is refused does not count as a
  failure of the change. The checks show as unavailable, and the reviewer is
  told so.
- Workflow and agent prompts tell models to treat repository text as data, not
  instructions. This reduces the risk of prompt injection, but cannot remove it.

## Layout

```
*.js            the workflow scripts
agents/         the three clanker agent definitions (install.sh fills in the guard path)
guard/          worker-guard.mjs and its check
lib/            the shared clanker kit, kit syncer, backend config, inventory generator, test stubs
harness/        scenario harnesses, negative controls, installer E2E
verify/         a TLA+ model of red-blue-loop's event order
tools/          red-blue-loop's publisher (draft PRs and issues from a finished run)
docs/           design notes
```

## Editing

- Each workflow holds a verbatim copy of the shared kit, between
  `// ---- clanker kit v3` and `// ---- end clanker kit ----`. Edit
  `lib/clanker-kit.js`, then run `node lib/sync-kit.mjs` to update every copy.
- The `WORKERS` line at the top of the kit is the backend config. `install.sh`
  rewrites it in the installed copies. Leave it at the Claude defaults in the
  source.
- If you change a workflow's `meta` or its `ALLOWED` arguments, regenerate the
  inventory: `node lib/gen-inventory.mjs > INVENTORY.md`.

## Tests

The command below runs the same check list as CI. No check calls a model.

```sh
bash ci.sh    # the last line is: ci: ALL PASS
```

`wf-smoke.mjs` runs every workflow on stubs under both backends. The
`harness/*.scenarios.mjs` files script failure cases, and each comes with
negative controls: mutations of the code that must break a scenario. The guard
and the installer each have their own check.

## License

MIT. See [`LICENSE`](LICENSE).
