#!/usr/bin/env node
// Turns a red-blue-loop result into draft PRs and beads. Deterministic: no model runs here.
// Dry run by default (prints every command); --apply runs them. It never merges, and it refuses
// to push anything but redteam/* and fix/* branches, or to push to the base branch.
//
//   node tools/red-blue-publish.mjs <result.json> [--base staging] [--apply] [--bd-dir <dir>] [--no-fix]
//
// Per confirmed finding, in its red worktree: re-check that only the declared test files changed,
// branch redteam/<slug>, commit the test, push, open a DRAFT PR "redteam: <title>" to base, and
// (with --bd-dir) file a bead. Per passed fix, in its fix worktree: branch fix/<slug>, commit,
// push, open a DRAFT PR "fix: <title>" that links the red PR and the bead.
// Prints a JSON summary on stdout; exits 1 when any finding could not be published.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined)
const file = argv.find((a, i) => !a.startsWith('--') && !['--base', '--bd-dir'].includes(argv[i - 1]))
if (!file) { console.error('usage: red-blue-publish.mjs <result.json> [--base <branch>] [--apply] [--bd-dir <dir>] [--no-fix]'); process.exit(2) }
const APPLY = flag('--apply')
const BD_DIR = opt('--bd-dir')
const result = JSON.parse(fs.readFileSync(file, 'utf8'))
if (result.status !== 'done') { console.error(`red-blue-publish: the run did not finish (status ${result.status}: ${result.reason || ''})`); process.exit(1) }
const BASE = opt('--base') || String(result.base || '').replace(/^origin\//, '')
if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(BASE) || BASE.includes('..')) { console.error(`red-blue-publish: bad base ${JSON.stringify(BASE)}`); process.exit(2) }

const sh = (cwd, cmd) => spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8' })
const git = (cwd, ...a) => { const r = sh(cwd, ['git', ...a]); return r.status === 0 ? r.stdout : null }

// The one place a command is run. Merges are not a mode of this script: any merge, any push that
// is not `push -u origin <redteam|fix branch>`, and any push to base is refused before it runs.
function guard(cmd) {
  const [t, a, b] = cmd
  if (t === 'gh' && a === 'pr' && b !== 'create') throw new Error(`refused: gh pr ${b}`)
  if (t === 'gh' && a === 'pr' && !cmd.includes('--draft')) throw new Error('refused: a PR that is not a draft')
  if (t === 'git' && ['merge', 'rebase', 'reset', 'cherry-pick'].includes(a)) throw new Error(`refused: git ${a}`)
  if (t === 'git' && a === 'push') {
    const br = cmd[cmd.length - 1]
    if (cmd.length !== 5 || b !== '-u' || cmd[3] !== 'origin' || !/^(redteam|fix)\/[a-z0-9-]+$/.test(br) || br === BASE) throw new Error(`refused: ${cmd.join(' ')}`)
  }
  if (!['git', 'gh', 'bd'].includes(t)) throw new Error(`refused: ${t}`)
}
const log = []
function step(cwd, cmd) {
  guard(cmd)
  log.push({ cwd, cmd: cmd.map((c) => (c.length > 120 ? c.slice(0, 117) + '...' : c)).join(' ') })
  if (!APPLY) return { ok: true, out: '' }
  const r = sh(cwd, cmd)
  if (r.status !== 0) throw new Error(`${cmd.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`)
  return { ok: true, out: r.stdout.trim() }
}

// A worktree whose changes are exactly what we expect; returns the changed paths.
function changedPaths(dir) {
  if (!dir || !fs.existsSync(dir)) throw new Error(`worktree missing: ${dir}`)
  if (git(dir, 'rev-parse', '--is-inside-work-tree')?.trim() !== 'true') throw new Error(`not a git worktree: ${dir}`)
  const cur = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')?.trim()
  if (cur === BASE) throw new Error(`worktree ${dir} is on the base branch ${BASE}`)
  return statusLines(dir).map((l) => l.slice(3).replace(/^.* -> /, ''))
}
const statusLines = (dir) => (git(dir, '-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-uall') || '').split('\n').filter(Boolean)
// Untracked files the red run wrote (a test's report artifact, e.g. reports/e2e/x.json) are not
// staged: only the declared test files go on the red branch. A change to a tracked file is refused.
const trackedChanges = (dir) => statusLines(dir).filter((l) => !l.startsWith('??')).map((l) => l.slice(3).replace(/^.* -> /, ''))

const prio = (s) => ({ P0: '0', P1: '1', P2: '2' })[s] || '2'
const redBody = (f) => [
  `Red team finding (${f.severity}, lens ${f.lens}). The test is red on purpose: do not merge this PR; the fix PR carries the test.`,
  '',
  `- Where: \`${f.file}${f.line ? ':' + f.line : ''}\``,
  `- Scenario: ${f.scenario}`,
  `- Expected: ${f.expected}`,
  `- Actual: ${f.actual}`,
  `- Proof: \`${f.redCmd}\` failed twice in a row under the deterministic checks runner (${f.checks?.head || 'fail'}).`,
  `- Skeptics: ${f.votes.filter((v) => !v.refuted).length} of ${f.votes.length} could not refute it.`,
  '',
  'Opened by red-blue-loop (claude-workflows). Synthetic data only.',
].join('\n')
const fixBody = (f, redPr, bead) => [
  `Fixes the red team finding ${redPr || '(red PR not opened)'}${bead ? `, bead ${bead}` : ''}: ${f.title}.`,
  '',
  `Before: \`${f.redCmd}\` fails (${f.actual}). After: it passes (${f.expected}).`,
  '',
  '## Formal verification',
  `- Property: ${f.expected} (the red test's assertion), for the scenario: ${f.scenario}`,
  `- Tool: the red E2E test, run by the deterministic checks runner; the checks restored the exact red test file before every run, so the test was not weakened.`,
  `- Bounds: the red test's scenario.`,
  `- Result: failed twice before the fix; passed after it (clanker-loop ${f.fix.status}, ${f.fix.rounds} round(s), checks: ${f.fix.checks || 'pass'}).`,
  '',
  f.fix.nits?.length ? `Reviewer nits: ${f.fix.nits.map((n) => n.issue).join('; ')}` : '',
  f.fix.preExisting?.length ? `Pre-existing defects the reviewer saw outside this change (not fixed here; candidates for the next red-team run): ${f.fix.preExisting.map((n) => `${n.file ? n.file + ': ' : ''}${n.issue}`).join('; ')}` : '',
  'Opened by red-blue-loop (claude-workflows). Draft: the owner reviews and merges.',
].filter((l) => l !== null).join('\n')

const summary = []
let failed = 0
// Two lenses can word one bug differently, so the workflow's title keys keep both. Two findings
// whose red tests add the same path would open conflicting PRs and two beads for what is most
// likely one bug: the first (most severe) is published, a later one is left for a person.
const testOwner = new Map()
const rank = (f) => ['P0', 'P1', 'P2'].indexOf(f.severity) >>> 0
for (const f of [...(result.findings || [])].sort((a, b) => rank(a) - rank(b))) {
  const row = { title: f.title, severity: f.severity, redBranch: f.branch, redPr: null, bead: null, fixBranch: null, fixPr: null, error: null }
  try {
    if (f.status !== 'confirmed') throw new Error(`not confirmed (${f.status})`)
    const twin = (f.files || []).map((x) => testOwner.get(x)).find(Boolean)
    if (twin) throw new Error(`same red test path as "${twin}"; most likely the same bug, so it is not published. Compare the two by hand`)
    for (const x of f.files || []) testOwner.set(x, f.title)
    if (!/^redteam\/[a-z0-9-]+$/.test(f.branch) || !/^fix\/[a-z0-9-]+$/.test(f.fixBranch)) throw new Error('bad branch names')
    const paths = changedPaths(f.redDir)
    const extra = trackedChanges(f.redDir).filter((p) => !f.files.includes(p))
    if (extra.length || !f.files.every((x) => paths.includes(x))) throw new Error(`the red worktree ${extra.length ? 'changed tracked files outside the red test: ' + extra.join(', ') : 'does not hold the red test'}`)
    row.unstaged = paths.filter((p) => !f.files.includes(p))
    step(f.redDir, ['git', 'switch', '-c', f.branch])
    step(f.redDir, ['git', 'add', '--', ...f.files])
    step(f.redDir, ['git', 'commit', '-m', `test(redteam): ${f.title}`])
    step(f.redDir, ['git', 'push', '-u', 'origin', f.branch])
    row.redPr = step(f.redDir, ['gh', 'pr', 'create', '--draft', '--base', BASE, '--head', f.branch, '--title', `redteam: ${f.title}`, '--body', redBody(f)]).out || '(dry run)'
    if (BD_DIR) {
      const out = step(BD_DIR, ['bd', 'create', `redteam: ${f.title}`, '-t', 'bug', '-p', prio(f.severity), '-l', 'redteam', '--external-ref', row.redPr, '-d', `${f.scenario}\nExpected: ${f.expected}\nActual: ${f.actual}\nWhere: ${f.file}${f.line ? ':' + f.line : ''}\nRed PR: ${row.redPr}`, '--json']).out
      try { row.bead = out ? JSON.parse(out).id : '(dry run)' } catch { row.bead = '(unparsed)' }
    }
    if (!flag('--no-fix') && /^passed/.test(f.fix?.status || '') && f.fix.dir) {
      const fp = changedPaths(f.fix.dir)
      if (!f.files.every((x) => fp.includes(x) || git(f.fix.dir, 'ls-files', '--error-unmatch', x) !== null)) throw new Error('the fix worktree does not hold the red test')
      row.fixBranch = f.fixBranch
      step(f.fix.dir, ['git', 'switch', '-c', f.fixBranch])
      step(f.fix.dir, ['git', 'add', '-A'])
      step(f.fix.dir, ['git', 'commit', '-m', `fix: ${f.title}`])
      step(f.fix.dir, ['git', 'push', '-u', 'origin', f.fixBranch])
      row.fixPr = step(f.fix.dir, ['gh', 'pr', 'create', '--draft', '--base', BASE, '--head', f.fixBranch, '--title', `fix: ${f.title}`, '--body', fixBody(f, row.redPr, row.bead)]).out || '(dry run)'
    }
  } catch (e) {
    failed++
    row.error = String(e.message || e)
  }
  summary.push(row)
}
console.log(JSON.stringify({ apply: APPLY, base: BASE, published: summary, dropped: (result.dropped || []).map((d) => ({ title: d.title, status: d.status, reason: d.reason })), commands: log }, null, 2))
process.exit(failed ? 1 : 0)
