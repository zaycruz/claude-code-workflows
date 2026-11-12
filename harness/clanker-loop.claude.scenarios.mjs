// Scenario harness for clanker-loop.js on the claude backend (workers and checks as Claude subagents).
// Usage: node harness/clanker-loop.claude.scenarios.mjs [clanker-loop.js]
//
// How the claude backend can fail, written before the scenarios:
//   F1 the first worker call is not in a worktree, so it writes in the coordinator's checkout.
//   F2 a later round does not reuse the worker's directory, so round 1's work is lost.
//   F3 a relative, empty or missing workdir is taken as the task directory, so checks run in the
//      session's own directory (or nowhere) and pass on code the worker never touched.
//   F4 a worker that dies (agent() returns null) crashes the run or is reported as passed.
//   F5 a checks agent that dies is read as passing checks.
//   F6 the checks model's own verdict wins over the exit codes it reported (a failing command, verdict pass).
//   F7 the rethink after the round cap does not go to the fallback model (opus).
//   F8 the claude backend still calls the pi or checks-runner agent types (not installed for a Claude-only user).
//   F9 the reviewer is not told that a model ran the checks, and treats them as deterministic.
//   F10 git status cannot run in the checks agent (Claude Code's permissions refuse it) and the empty
//       changed list is read as "nothing changed", so a correct change is blocked every round (seen in
//       the real-model E2E, run 3).
//   F11 the checks prompt leads the agent to `cd <dir> && git ...`, which Claude Code refuses.
//   F12 a command that did not run (refused by permissions) is read as a failure of the change, so the
//       worker is sent back to fix what it cannot fix (run 3: a refused `npm install` made every round
//       CHECKS FAIL with 1/1 checks passing). The agent marks it with skipped, or only with exit -1.
//   F14 the checks run in the session's directory, not the task's: in a subagent, Claude Code resets
//       the shell to the session's directory between Bash calls, so a cd on its own does not hold, and
//       the checks pass on code the worker never touched (run 4: `npm test` ran 1 test in the main
//       checkout while the worktree had 2). Same for the base check's temp dir.
//   F13 the setup installs a package.json project that declares no dependencies, a command that can
//       only fail or be refused.
// Each scenario names the failures it covers; each negative control mutates the kit and must break one.
import fs from 'fs'
import { runBody, loadWorkflowBody, instance, CLAUDE_BACKEND, PI, CHECKS, WORKER, CHECKER } from '../lib/stubs.mjs'

const WF_PATH = process.argv[2] || 'clanker-loop.js'
const SRC = fs.readFileSync(WF_PATH, 'utf8')
const BODIES = new Map()
const bodyFor = (mutate = null) => {
  if (!BODIES.has(mutate)) BODIES.set(mutate, loadWorkflowBody(mutate ? mutate(SRC) : SRC, CLAUDE_BACKEND))
  return BODIES.get(mutate)
}

let fails = 0
const pass = (name) => console.log(`PASS ${name}`)
const fail = (name, why) => { fails++; console.log(`FAIL ${name}: ${why}`) }
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`); return got }
const ok = (cond, what) => { if (!cond) throw new Error(what) }

const DIR = '/tmp/wt-t1'
const TASK = { tasks: [{ id: 't1', prompt: 'add sub()' }] }
const REPORT = 'Changed files:\nM src/math.js\n\nAdded sub(a, b) and a test. Nothing committed.'
const BASE_DIR = '/tmp/base-t1'
const entry = (okv, ranIn = DIR) => ({ kind: 'test', cmd: 'npm test', ranIn, ok: okv, exit: okv ? 0 : 1, seconds: 1, failures: okv ? [] : ['FAIL sub'], tail: okv ? 'ok' : 'FAIL sub' })
const report = (okv, extra = {}) => ({ dir: DIR, head: 'abc1234', changed: [{ status: 'M', path: 'src/math.js' }], setup: [], checks: [entry(okv)], verdict: okv ? 'pass' : 'fail', ...extra })
// The base check runs in a temp dir it reports as workDir.
const baseReport = (okv, extra = {}) => ({ ...report(okv), changed: [], workDir: BASE_DIR, checks: [entry(okv, BASE_DIR)], ...extra })

// Fake agent(): worker, checks and reviewer calls; records every call.
// spec: { worker(prompt, n), checks(prompt, n), approve(n) }
function makeScripter(spec = {}) {
  const calls = []
  const counter = {}
  const bump = (k) => (counter[k] = (counter[k] || 0) + 1) - 1
  const agent = async (prompt, opts = {}) => {
    const p = String(prompt)
    calls.push({ label: opts.label || '', agentType: opts.agentType || '', model: opts.model, isolation: opts.isolation, prompt: p })
    if (opts.agentType === WORKER) return spec.worker ? spec.worker(p, bump('worker')) : { report: REPORT, workdir: DIR }
    if (opts.agentType === CHECKER) return spec.checks ? spec.checks(p, bump('checks')) : report(true)
    if (opts.agentType === PI || opts.agentType === CHECKS) return null
    const n = bump('review')
    const good = spec.approve ? spec.approve(n) : true
    return Object.assign(instance(opts.schema, false), good
      // A later review verifies every open finding id its prompt names, as the loop requires.
      ? { verdict: 'pass', summary: 'looks right', findings: [], verification: [...new Set(p.match(/\bB\d+\.\d+\b/g) || [])].map((id) => ({ id, status: 'resolved', reason: 'fixed' })), probes: [] }
      : { verdict: 'block', summary: 'nope', findings: [{ severity: 'blocker', scope: 'change', issue: 'still wrong', fix: 'fix it' }], verification: [], probes: [] })
  }
  return { agent, calls }
}

async function run({ args = TASK, spec = {}, mutate = null } = {}) {
  const { agent, calls } = makeScripter(spec)
  const out = await runBody(bodyFor(mutate), { args, agent, log: () => {}, phase: () => {} })
  return { out, calls }
}
const workers = (calls) => calls.filter((c) => c.agentType === WORKER)
const checkers = (calls) => calls.filter((c) => c.agentType === CHECKER)
const reviewers = (calls) => calls.filter((c) => ![WORKER, CHECKER, PI, CHECKS].includes(c.agentType))
const res = (out, id = 't1') => out.results.find((x) => x.id === id)
const rejectAll = () => false

const scenarios = []
scenarios.push(['K1 worktree first, then the same dir (F1, F2, F8)', async () => {
  const { out, calls } = await run({ spec: { approve: (n) => n > 0 } })
  const w = workers(calls)
  ok(w.length >= 2, `want 2 worker rounds, got ${w.length}`)
  eq(w[0].isolation, 'worktree', 'first worker isolation')
  ok(w[1].isolation === undefined && w[1].prompt.startsWith(`Work only inside ${DIR}:`), `round 2 not confined to ${DIR}: ${w[1].prompt.split('\n')[0]}`)
  ok(checkers(calls).every((c) => c.prompt.includes(DIR)), 'a checks call ran outside the worker dir')
  ok(!calls.some((c) => c.agentType === PI || c.agentType === CHECKS), 'a pi or checks-runner call on the claude backend')
  eq(res(out).status, 'passed', 'status')
}])
scenarios.push(['K2 worker dies (F4)', async () => {
  const { out, calls } = await run({ spec: { worker: () => null } })
  eq(res(out).status, 'exec-failed', 'status')
  eq(checkers(calls).length, 0, 'checks calls with no worker dir')
}])
scenarios.push(['K2b worker with an empty report and a real dir (F4)', async () => {
  const { out } = await run({ spec: { worker: () => ({ report: '  ', workdir: DIR }) } })
  eq(res(out).status, 'exec-failed', 'status')
}])
for (const bad of ['', 'relative/dir', '.']) {
  scenarios.push([`K3 workdir ${JSON.stringify(bad)} is not a dir (F3)`, async () => {
    const { out, calls } = await run({ spec: { worker: () => ({ report: REPORT, workdir: bad }) } })
    ok(res(out).status !== 'passed', `status ${res(out).status}`)
    ok(checkers(calls).every((c) => !c.prompt.includes(`Directory: ${bad}.`) && !c.prompt.includes('your current directory')), 'checks ran on a bad dir')
  }])
}
scenarios.push(['K4 checks agent dies: unavailable, never a pass (F5)', async () => {
  const { out, calls } = await run({ spec: { checks: () => null } })
  const rv = reviewers(calls)
  ok(rv.length >= 1, 'no reviewer')
  ok(rv[0].prompt.includes('checks agent unavailable'), 'reviewer not told the checks were unavailable')
  ok(!/CHECKS PASS/.test(rv[0].prompt), 'reviewer told the checks passed')
  ok(res(out).status !== undefined, 'no status')
}])
scenarios.push(['K5 exit codes beat the model verdict (F6)', async () => {
  // Round 1: a failing command reported with verdict pass. The base check passes, so the failure is
  // the change's, and the worker must go again before any review.
  const { calls } = await run({ spec: { checks: (p, n) => /Check commit /.test(p) ? baseReport(true) : n === 0 ? report(false, { verdict: 'pass' }) : report(true) } })
  const order = calls.filter((c) => c.agentType === WORKER || reviewers([c]).length).map((c) => c.agentType === WORKER ? 'W' : 'R')
  eq(order.slice(0, 2).join(''), 'WW', 'worker rounds before the first review')
}])
scenarios.push(['K6 rethink on the fallback model (F7)', async () => {
  const { calls } = await run({ args: { ...TASK, maxRounds: 1 }, spec: { approve: rejectAll } })
  const esc = workers(calls).find((c) => c.label.includes(':escalate'))
  ok(esc, 'no escalation call')
  eq(esc.model, CLAUDE_BACKEND.fallback, 'escalation model')
  eq(workers(calls)[0].model, CLAUDE_BACKEND.executor, 'first worker model')
}])
scenarios.push(['K7 reviewer told a model ran the checks (F9)', async () => {
  const { calls } = await run()
  ok(reviewers(calls)[0].prompt.includes('run by haiku, not deterministic'), 'no model-run notice in the review prompt')
  eq(checkers(calls)[0].model, 'haiku', 'checks model')
}])
scenarios.push(['K8 git status refused: changed is unknown, not empty (F10)', async () => {
  const { out, calls } = await run({ spec: { checks: () => report(true, { changed: [], changedError: 'This command requires approval' }) } })
  eq(res(out).status, 'passed', 'status')
  ok(!JSON.stringify(out).includes('no uncommitted changes'), 'a no-changes blocker on an unknown changed list')
  ok(reviewers(calls)[0].prompt.includes('changed files: unknown'), 'reviewer not told the changed files are unknown')
}])
scenarios.push(['K8b an empty changed list with no error still blocks (F10)', async () => {
  const { out } = await run({ args: { ...TASK, maxRounds: 1 }, spec: { checks: () => report(true, { changed: [] }) } })
  ok(res(out).status !== 'passed', `status ${res(out).status}`)
  ok(JSON.stringify(out).includes('no uncommitted changes'), 'no no-changes blocker')
}])
scenarios.push(['K9 checks prompt: every command carries its cd, git uses -C (F11, F14)', async () => {
  const { calls } = await run()
  const p = checkers(calls)[0].prompt
  ok(p.includes(`\`cd ${DIR} && pwd && <command>\``), 'commands do not carry their own cd and pwd')
  ok(!/as a command of its own/.test(p), 'still asks for a separate cd')
  ok(p.includes(`git -C ${DIR} status --porcelain`), 'git status not run with -C')
  ok(p.includes('changedError') && p.includes('ranIn'), 'no changedError or ranIn instruction')
}])
scenarios.push(['K13 checks that ran in another dir are unavailable, not a pass (F14)', async () => {
  const { calls } = await run({ spec: { checks: (p) => /Check commit /.test(p) ? baseReport(true) : report(true, { checks: [entry(true, '/Volumes/session/repo')] }) } })
  const rp = reviewers(calls)[0].prompt
  ok(rp.includes('CHECKS UNAVAILABLE') && rp.includes('ran in /Volumes/session/repo'), 'reviewer not told the checks ran elsewhere')
}])
scenarios.push(['K13b checks with no ranIn are unavailable (F14)', async () => {
  const { ranIn, ...bare } = entry(true)
  const { calls } = await run({ spec: { checks: () => report(true, { checks: [bare] }) } })
  ok(reviewers(calls)[0].prompt.includes('CHECKS UNAVAILABLE'), 'a check with no ranIn read as a pass')
}])
scenarios.push(['K13c a red base that ran in its temp dir counts as pre-existing (F14)', async () => {
  const { calls } = await run({ spec: { checks: (p) => /Check commit /.test(p) ? baseReport(false) : report(false) } })
  const order = calls.filter((c) => c.agentType === WORKER || reviewers([c]).length).map((c) => c.agentType === WORKER ? 'W' : 'R')
  eq(order.slice(0, 2).join(''), 'WR', 'a pre-existing failure goes to review')
}])
scenarios.push(['K13d a base that ran in the worktree, not a temp dir, is not trusted (F14)', async () => {
  const { calls } = await run({ spec: { checks: (p, n) => /Check commit /.test(p) ? baseReport(false, { workDir: DIR, checks: [entry(false, DIR)] }) : n < 2 ? report(false) : report(true) } })
  const order = calls.filter((c) => c.agentType === WORKER || reviewers([c]).length).map((c) => c.agentType === WORKER ? 'W' : 'R')
  eq(order.slice(0, 2).join(''), 'WW', 'a base run in the worktree excused the failure')
}])
const notRunSetup = (extra = {}) => ({ kind: 'setup', cmd: 'npm install', ok: false, exit: -1, seconds: 0, failures: ['refused: requires approval'], tail: '', ...extra })
scenarios.push(['K10 setup refused, checks pass: pass (F12)', async () => {
  const { out } = await run({ spec: { checks: (p) => /Check commit /.test(p) ? baseReport(true) : report(true, { setup: [notRunSetup({ skipped: 'refused: requires approval' })] }) } })
  eq(res(out).status, 'passed', 'status')
}])
scenarios.push(['K10b setup refused, marked only by exit -1: pass (F12)', async () => {
  const { out, calls } = await run({ spec: { checks: (p) => /Check commit /.test(p) ? baseReport(true) : report(true, { setup: [notRunSetup()] }) } })
  eq(res(out).status, 'passed', 'status')
  ok(reviewers(calls)[0].prompt.includes('CHECKS PASS'), 'the checks that ran and passed were not reported as a pass')
}])
scenarios.push(['K10c a check refused: reviewed as unavailable, not sent back (F12)', async () => {
  const refused = { ...entry(false), exit: -1, skipped: 'refused: requires approval' }
  const { calls } = await run({ spec: { checks: () => report(false, { checks: [refused] }) } })
  const order = calls.filter((c) => c.agentType === WORKER || reviewers([c]).length).map((c) => c.agentType === WORKER ? 'W' : 'R')
  eq(order.slice(0, 2).join(''), 'WR', 'first review after round 1')
  ok(reviewers(calls)[0].prompt.includes('CHECKS UNAVAILABLE'), 'reviewer not told the checks were unavailable')
}])
scenarios.push(['K10d a check that timed out (exit -1) is still a failure (F12)', async () => {
  const timedOut = { ...entry(false), exit: -1, timedOut: true }
  const { calls } = await run({ spec: { checks: (p, n) => /Check commit /.test(p) ? baseReport(true) : n === 0 ? report(false, { checks: [timedOut] }) : report(true) } })
  const order = calls.filter((c) => c.agentType === WORKER || reviewers([c]).length).map((c) => c.agentType === WORKER ? 'W' : 'R')
  eq(order.slice(0, 2).join(''), 'WW', 'worker rounds before the first review')
}])
scenarios.push(['K11 setup installs only declared dependencies (F13)', async () => {
  const { calls } = await run()
  ok(/declares dependencies or devDependencies/.test(checkers(calls)[0].prompt), 'install not limited to declared dependencies')
  ok(/did not run .*exit -1.*skipped/.test(checkers(calls)[0].prompt), 'no rule for a command that did not run')
}])

for (const [name, fn] of scenarios) {
  try { await fn(); pass(name) } catch (e) { fail(name, e.message) }
}

// ---- negative controls: mutate the kit, the paired scenario must now FAIL ----
const control = (name, from, to, scenario) => ({ name, from, to, scenario })
const controls = [
  control('worktree dropped (K1)', '    if (isolation) opts.isolation = isolation\n    const r = await agent(`${workerHead', '    const r = await agent(`${workerHead', 'K1'),
  control('relative workdir accepted (K3)', "dir: !ro && wd.startsWith('/') ? wd : ''", "dir: !ro ? wd : ''", 'K3 workdir "relative/dir"'),
  control('dead worker read as ok (K2)', 'return { ok: !!text, text, used: model', 'return { ok: true, text, used: model', 'K2b'),
  control('model verdict trusted (K5)', '  const verdict = strayRuns.length', '  const verdict = rep.verdict, unusedVerdict = strayRuns.length', 'K5'),
  control('dead checks read as pass (K4)', "    return { verdict: 'unavailable', head: 'checks agent unavailable', report: null, dir: '', changed: undefined }\n  }\n  if (!Array.isArray(rep.setup))", "    return { verdict: 'pass', head: 'CHECKS PASS', report: null, dir, changed: 0 }\n  }\n  if (!Array.isArray(rep.setup))", 'K4'),
  control('claude backend falls through to pi (K1)', "  if (WORKERS.backend === 'claude') {\n    const ro", "  if (false) {\n    const ro", 'K1'),
  control('unknown changed read as none (K8)', 'changed: unknown ? undefined : rep.changed.length }', 'changed: rep.changed.length }', 'K8 '),
  control('a command not run read as failed (K10b)', 'const notRun = (x) => !x.ok && !x.timedOut && (', 'const notRun = (x) => false && (', 'K10b'),
  control('ranIn not verified (K13)', '  const strayRuns = ', '  const strayRuns = [] || ', 'K13 '),
  control('model-run notice dropped (K7)', ' (run by haiku, not deterministic)`', '`', 'K7'),
]
for (const c of controls) {
  if (!SRC.includes(c.from)) { fail(`negative-control ${c.name}`, 'mutation target not found in the source'); continue }
  const sc = scenarios.find(([n]) => n.startsWith(c.scenario))
  // Rerun the paired scenario with the mutated body in place of the real one.
  const orig = bodyFor()
  BODIES.set(null, loadWorkflowBody(SRC.replace(c.from, c.to), CLAUDE_BACKEND))
  let broke = false
  try { await sc[1]() } catch { broke = true } finally { BODIES.set(null, orig) }
  broke ? pass(`negative-control ${c.name}: caught`) : fail(`negative-control ${c.name}`, 'mutation survived')
}

console.log(fails ? `${fails} FAIL` : 'ALL PASS')
process.exit(fails ? 1 : 0)
