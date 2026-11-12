#!/usr/bin/env node
// Checks guard/worker-guard.mjs, the PreToolUse hook the clanker-* agents run under. No model.
//
//   node guard/guard.check.mjs
//
// How the guard can fail, written before the guard:
//   G1  git push gets through in another spelling: git -C dir push, git -c k=v push, git --no-pager
//       push, /usr/bin/git push, env X=1 git push, command git push, sh -c "git push", a push after
//       cd && or ;, in $(...) or backticks.
//   G2  other history writes get through: commit, merge, rebase, tag, am, cherry-pick, revert, reset,
//       update-ref, filter-branch, remote add/set-url/remove, config of remote./url./credential.,
//       worktree add/remove/prune.
//   G3  it blocks what a worker needs, so the worker cannot work: git status/diff/log/show/blame/
//       stash/checkout/switch/add/grep/rev-parse/ls-files/worktree list, git config --get, npm test,
//       an argument that merely contains the word push or commit.
//   G4  GitHub writes get through: gh pr create/merge/close/comment/edit/review, gh release, gh repo
//       create/delete/edit, gh issue create/close/comment/edit, gh api, gh secret, gh workflow run,
//       gh auth; while gh pr view/list/diff/checks and gh issue view/list stay allowed.
//   G5  secrets are read: op, security find-*-password, ~/.ssh, .aws/credentials, .netrc,
//       .git-credentials, .config/gh/hosts.yml, .docker/config.json, by Bash or by the Read tool.
//   G6  remote shells: ssh, scp, sftp, mosh.
//   G7  processes outside the task are killed: kill, pkill, killall.
//   G8  packages are published: npm/pnpm/yarn publish, cargo publish, docker push, twine upload, gem push.
//   G9  Write/Edit/NotebookEdit outside the work tree: an absolute path elsewhere, ../ out of cwd, ~ paths.
//       Inside cwd, inside a linked worktree of cwd's repo and under the temp dir are allowed.
//   G10 malformed hook input, or a crash, lets the call through (a hook that exits non-2 does not block).
//   G11 a block does not say why, so the worker retries the same call.
//   G12 an E2E run cannot tell a hook block from a model that declined: with CLANKER_GUARD_LOG set, each
//       decision must be appended to that file as one JSON line, and a log write error must not allow a call.
import { decide, main } from './worker-guard.mjs'
import os from 'node:os'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let fails = 0
const CWD = '/w/repo'
const LINKED = ['/w/wt/task-1']
const ctx = { linkedWorktrees: () => LINKED, home: '/home/dev', tmp: os.tmpdir() }
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: CWD })
const tool = (tool_name, tool_input) => ({ tool_name, tool_input, cwd: CWD })
const expect = (label, input, want) => {
  const d = decide(input, ctx)
  const got = d.block ? 'block' : 'allow'
  if (got !== want) { fails++; console.log(`FAIL ${label}: want ${want} got ${got}${d.reason ? ` (${d.reason})` : ''}`) }
  else if (d.block && !d.reason) { fails++; console.log(`FAIL ${label}: blocked without a reason (G11)`) }
  else console.log(`PASS ${label}: ${got}`)
}

const BLOCK = {
  G1: ['git push', 'git push origin main', 'git -C /w/repo push', 'git -c core.x=1 push', 'git --no-pager push', '/usr/bin/git push',
    'env GIT_TRACE=1 git push', 'command git push', 'sh -c "git push"', "bash -lc 'cd x && git push origin'", 'cd /w/repo && git push',
    'npm test; git push', 'echo $(git push)', 'echo `git push`', 'nohup git push &', 'git push --force-with-lease', 'GIT_DIR=x git push'],
  G2: ['git commit -m x', 'git commit --amend', 'git merge main', 'git rebase main', 'git tag v1', 'git am p.patch', 'git cherry-pick abc',
    'git revert abc', 'git reset --hard', 'git reset HEAD~1', 'git update-ref refs/heads/x abc', 'git filter-branch', 'git remote add o u',
    'git remote set-url origin u', 'git remote remove origin', 'git config remote.origin.pushurl x', 'git config url.x.insteadOf y',
    'git config credential.helper store', 'git worktree add ../x', 'git worktree remove x', 'git worktree prune'],
  G4: ['gh pr create --fill', 'gh pr merge 1', 'gh pr close 1', 'gh pr comment 1 -b x', 'gh pr edit 1', 'gh pr review 1 --approve',
    'gh release create v1', 'gh repo create x', 'gh repo delete x', 'gh repo edit', 'gh issue create', 'gh issue close 1',
    'gh issue comment 1', 'gh api repos/x/y', 'gh secret set X', 'gh workflow run ci', 'gh auth token'],
  G5: ['op read op://v/i/f', 'op run -- env', 'security find-generic-password -s x', 'cat ~/.ssh/id_ed25519', 'cat /home/dev/.aws/credentials',
    'cat ~/.netrc', 'cat ~/.git-credentials', 'cat ~/.config/gh/hosts.yml', 'cat ~/.docker/config.json'],
  G6: ['ssh host uptime', 'scp a host:b', 'sftp host', 'mosh host'],
  G7: ['kill 123', 'pkill node', 'killall node'],
  G8: ['npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'docker push img', 'twine upload dist/*', 'gem push x.gem'],
}
const ALLOW = {
  G3: ['git status', 'git diff', 'git diff --stat HEAD', 'git log --oneline -5', 'git show HEAD:src/a.js', 'git blame src/a.js', 'git stash',
    'git stash pop', 'git checkout -- src/a.js', 'git switch -c x', 'git add -A', 'git grep push', 'git rev-parse HEAD', 'git ls-files',
    'git worktree list', 'git config --get user.name', 'git remote -v', 'npm test', 'npx vitest run', 'node -e "console.log(1)"',
    'ls pushd', 'echo committed > notes.txt', 'grep -rn TODO src', 'cat src/push.js', 'gh pr view 1', 'gh pr list', 'gh pr diff 1',
    'gh pr checks 1', 'gh issue view 1', 'gh issue list', 'gh repo view', 'gh run view 1', 'cat src/ssh.js', 'node scripts/kill-switch.js'],
}
for (const [g, cmds] of Object.entries(BLOCK)) for (const c of cmds) expect(`${g} ${c}`, bash(c), 'block')
for (const [g, cmds] of Object.entries(ALLOW)) for (const c of cmds) expect(`${g} ${c}`, bash(c), 'allow')

// G5 through the Read tool; G9 file writes.
expect('G5 Read ~/.ssh key', tool('Read', { file_path: '/home/dev/.ssh/id_ed25519' }), 'block')
expect('G5 Read .aws/credentials', tool('Read', { file_path: '/home/dev/.aws/credentials' }), 'block')
expect('G5 Read a source file', tool('Read', { file_path: '/w/repo/src/a.js' }), 'allow')
for (const t of ['Write', 'Edit']) {
  expect(`G9 ${t} inside cwd`, tool(t, { file_path: '/w/repo/src/a.js' }), 'allow')
  expect(`G9 ${t} inside a linked worktree`, tool(t, { file_path: '/w/wt/task-1/src/a.js' }), 'allow')
  expect(`G9 ${t} under tmp`, tool(t, { file_path: `${os.tmpdir()}/x.txt` }), 'allow')
  expect(`G9 ${t} relative inside cwd`, tool(t, { file_path: 'src/a.js' }), 'allow')
  expect(`G9 ${t} outside`, tool(t, { file_path: '/etc/hosts' }), 'block')
  expect(`G9 ${t} home dotfile`, tool(t, { file_path: '/home/dev/.zshrc' }), 'block')
  expect(`G9 ${t} ../ out of cwd`, tool(t, { file_path: '/w/repo/../other/a.js' }), 'block')
  expect(`G9 ${t} sibling with cwd as prefix`, tool(t, { file_path: '/w/repo-evil/a.js' }), 'block')
  expect(`G9 ${t} no path`, tool(t, {}), 'block')
}
expect('G9 NotebookEdit outside', tool('NotebookEdit', { notebook_path: '/etc/x.ipynb' }), 'block')

// G10: malformed input through the real process, as the hook runs it. Exit 2 blocks; anything else does not.
const GUARD = fileURLToPath(new URL('./worker-guard.mjs', import.meta.url))
for (const [label, stdin] of [['empty stdin', ''], ['not json', '{oops'], ['no tool_input', '{"tool_name":"Bash"}'], ['command not a string', '{"tool_name":"Bash","tool_input":{"command":7}}']]) {
  const r = spawnSync(process.execPath, [GUARD], { input: stdin, encoding: 'utf8' })
  if (r.status !== 2) { fails++; console.log(`FAIL G10 ${label}: exit ${r.status} (must be 2)`) }
  else console.log(`PASS G10 ${label}: exit 2`)
}
const okRun = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(bash('git status')), encoding: 'utf8' })
if (okRun.status !== 0) { fails++; console.log(`FAIL G10 allowed call exits ${okRun.status} (must be 0): ${okRun.stderr}`) } else console.log('PASS G10 allowed call exits 0')
const blockRun = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(bash('git push')), encoding: 'utf8' })
if (blockRun.status !== 2 || !/push/.test(blockRun.stderr)) { fails++; console.log(`FAIL G11 blocked call: exit ${blockRun.status}, stderr ${JSON.stringify(blockRun.stderr)}`) } else console.log('PASS G11 blocked call exits 2 with a reason')

const LOG = `${os.tmpdir()}/guard-check-${process.pid}.jsonl`
const logged = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(bash('git push')), encoding: 'utf8', env: { ...process.env, CLANKER_GUARD_LOG: LOG } })
const lines = (() => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] } })()
fs.rmSync(LOG, { force: true })
if (logged.status !== 2 || lines.length !== 1 || lines[0].block !== true || lines[0].tool !== 'Bash' || !/push/.test(lines[0].reason)) { fails++; console.log(`FAIL G12 decision log: exit ${logged.status}, ${JSON.stringify(lines)}`) } else console.log('PASS G12 a block is logged as one JSON line')
const badLog = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(bash('git push')), encoding: 'utf8', env: { ...process.env, CLANKER_GUARD_LOG: '/nonexistent-dir/x.jsonl' } })
if (badLog.status !== 2) { fails++; console.log(`FAIL G12 an unwritable log changed the decision: exit ${badLog.status}`) } else console.log('PASS G12 an unwritable log still blocks')

void main
console.log(fails ? `${fails} FAIL` : 'ALL PASS')
process.exit(fails ? 1 : 0)
