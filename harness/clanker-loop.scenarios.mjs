// Scenario harness for clanker-loop.js: runs the workflow body against a scripted fake agent()
// and prints one PASS/FAIL line per assertion. Usage: node harness/clanker-loop.scenarios.mjs [clanker-loop.js]
import fs from 'fs'
import { runBody, loadWorkflowBody, piAnswer, checksAnswer, instance, PI, CHECKS } from '../lib/stubs.mjs'

const WF_PATH = process.argv[2] || 'clanker-loop.js'
const SRC = fs.readFileSync(WF_PATH, 'utf8')
const BODIES = new Map()
const bodyFor = (mutate = null) => {
  if (!BODIES.has(mutate)) BODIES.set(mutate, loadWorkflowBody(mutate ? mutate(SRC) : SRC))
  return BODIES.get(mutate)
}

let fails = 0
const pass = (name) => console.log(`PASS ${name}`)
const fail = (name, why) => { fails++; console.log(`FAIL ${name}: ${why}`) }
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`); return got }

const FALLBACK = 'example/fallback-model'
const DIR = '/tmp/wt-t1'
const TASK = { tasks: [{ id: 't1', prompt: 'add sub()' }] }
const REPORT = `Changed files:\nM src/math.js\nM src/math.test.js\n\nAdded sub(a, b) returning a - b and a test for it. Ran the suite, every test passed. Nothing committed; the diff is left in the worktree for review.`

// Scripted fake agent(): answers clanker (pi), checks-runner, and Claude reviewer calls; records every call.
// spec: { pi(prompt, n), checks(n), approve(n), review(n, prompt) -> partial reviewer answer }
function makeScripter(spec = {}) {
  const calls = []
  const counter = {}
  const bump = (k) => (counter[k] = (counter[k] || 0) + 1) - 1
  const agent = async (prompt, opts = {}) => {
    const firstLine = String(prompt).split('\n')[0]
    calls.push({ label: opts.label || '', agentType: opts.agentType || '', model: opts.model, firstLine, prompt: String(prompt) })
    if (opts.agentType === PI) {
      return spec.pi
        ? spec.pi(String(prompt), bump('pi'))
        : piAnswer(REPORT, firstLine.replace(/^pi-model: /, ''), `sandbox: ${DIR}`)
    }
    if (opts.agentType === CHECKS) {
      if (spec.probes && /:probes$/.test(opts.label || '')) return spec.probes(String(prompt), bump('probes'))
      return spec.checks
        ? spec.checks(bump('checks'), String(prompt))
        : checksAnswer({ dir: DIR, verdict: 'none', changed: [{ status: 'M', path: 'src/math.js' }], checks: [] }, 'no checks configured')
    }
    const n = bump('review')
    if (spec.review) return Object.assign(instance(opts.schema, false), spec.review(n, String(prompt)))
    const ok = spec.approve ? spec.approve(n) : true
    return Object.assign(instance(opts.schema, false), ok === true
      ? { verdict: 'pass', summary: 'looks right', findings: [], verification: [], probes: [] }
      : { verdict: 'block', summary: 'nope', findings: [{ severity: 'blocker', scope: 'change', issue: 'still wrong', fix: 'fix it' }], verification: [], probes: [] })
  }
  return { agent, calls }
}

// Runs the workflow body (optionally mutated) and returns {out, calls}; throws on any rejection.
async function run({ args, spec = {}, mutate = null } = {}) {
  const { agent, calls } = makeScripter(spec)
  const out = await runBody(bodyFor(mutate), { args, agent, log: () => {}, phase: () => {} })
  return { out, calls }
}

const piModelOf = (p) => String(p).split('\n')[0].replace(/^pi-model: /, '')
const piCalls = (calls) => calls.filter((c) => c.agentType === PI)
const reviewCalls = (calls) => calls.filter((c) => c.agentType !== PI && c.agentType !== CHECKS)
const piModel = (c) => c.firstLine.replace(/^pi-model: /, '')
const res = (r, id = 't1') => {
  const t = r.results.find((x) => x.id === id)
  if (!t) throw new Error(`no result for ${id}; got ${JSON.stringify(r.results)}`)
  return t
}

const scenarios = []

scenarios.push(['1 happy path', async () => {
  const { out, calls } = await run({ args: TASK })
  eq(res(out).status, 'passed', 'status')
  eq(res(out).verdict, 'pass', 'verdict')
  eq(res(out).rounds, 1, 'rounds')
  eq(res(out).dir, DIR, 'worktree dir')
  eq(piCalls(calls)[0] && piModel(piCalls(calls)[0]), 'example/open-model', 'first clanker model')
  eq(reviewCalls(calls)[0] && reviewCalls(calls)[0].model, 'sonnet', 'reviewer model')
  eq(calls.filter((c) => c.agentType === CHECKS).length, 1, 'checks runner calls')
  if (!piCalls(calls)[0].prompt.includes('the decisions that shaped your change')) throw new Error('the executor is not asked to name the decisions behind its change')
}])

scenarios.push(['2 risky routes to opus', async () => {
  for (const risky of [true, 'true']) {
    const { out, calls } = await run({ args: { tasks: [{ id: 't1', prompt: 'touch prod', risky }] } })
    eq(res(out).status, 'passed', `status (risky=${risky})`)
    eq(reviewCalls(calls)[0] && reviewCalls(calls)[0].model, 'opus', `reviewer model (risky=${risky})`)
  }
}])

const executorDownPi = (p) => piModelOf(p).startsWith('example/open')
  ? 'the executor endpoint refused this request, answer without a footer'
  : piAnswer(REPORT, piModelOf(p), `sandbox: ${DIR}`)

scenarios.push(['3 the executor down falls back to fallback', async () => {
  const { out, calls } = await run({ args: TASK, spec: { pi: executorDownPi } })
  eq(res(out).status, 'passed', 'status')
  if (!piCalls(calls).some((c) => c.firstLine === 'pi-model: example/open-model')) throw new Error('the executor was never tried first')
  if (!piCalls(calls).some((c) => piModel(c) === FALLBACK)) throw new Error(`no clanker call on ${FALLBACK}`)
  eq(res(out).executors[0], FALLBACK, 'executor recorded')
}])

scenarios.push(['4 failing checks never reach the reviewer', async () => {
  const failRep = { dir: DIR, verdict: 'fail', changed: [{ status: 'M', path: 'src/math.js' }], checks: [{ kind: 'test', cmd: 'npm test', ok: false, exit: 1, seconds: 1, failures: ['1 test failed'], tail: 'FAIL sub' }] }
  const passRep = { dir: DIR, verdict: 'pass', changed: [{ status: 'M', path: 'src/math.js' }], checks: [{ kind: 'test', cmd: 'npm test', ok: true, exit: 0, seconds: 1, failures: [], tail: 'ok' }] }
  const { out, calls } = await run({
    args: { tasks: [{ id: 't1', prompt: 'add sub()' }], checks: ['npm test'] },
    spec: { checks: (n) => checksAnswer(n === 0 ? failRep : passRep, n === 0 ? '1 of 1 checks failed' : 'all checks passed') },
  })
  const order = calls.map((c) => c.agentType === CHECKS ? 'C' : c.agentType === PI ? 'P' : 'R').join('')
  if (order.indexOf('R') !== -1 && order.indexOf('R') < order.lastIndexOf('C')) throw new Error(`a reviewer ran before the passing checks: ${order}`)
  eq(res(out).status, 'passed', 'status')
  eq(res(out).rounds, 2, 'rounds')
  eq(calls.filter((c) => c.agentType === CHECKS && !/^checks-base: /m.test(c.prompt)).length, 2, 'checks calls')
  eq(calls.filter((c) => c.agentType === CHECKS && /^checks-base: HEAD$/m.test(c.prompt)).length, 1, 'base checks calls (once, after the first failure)')
  eq(reviewCalls(calls).length, 1, 'reviewer calls')
}])

const rejectAll = () => false

scenarios.push(['5 reviewer blocks every round', async () => {
  // The loop escalates once to the fallback after MAX_ROUNDS blocked rounds; a still-blocked task lands on needs-coordinator.
  for (const [mr, rounds] of [[undefined, 4], [2, 3]]) {
    const { out, calls } = await run({ args: mr ? { ...TASK, maxRounds: mr } : TASK, spec: { approve: rejectAll } })
    const t = res(out)
    eq(t.status, 'needs-coordinator', `status (maxRounds=${mr ?? 3})`)
    eq(t.rounds, rounds, `rounds (maxRounds=${mr ?? 3})`)
    eq(reviewCalls(calls).length, rounds, `reviewer calls (maxRounds=${mr ?? 3})`)
    if (!piCalls(calls).some((c) => piModel(c) === FALLBACK && c.label.includes(':escalate'))) throw new Error(`no the fallback escalation call (maxRounds=${mr ?? 3})`)
    if (!Array.isArray(t.openFindings) || !t.openFindings.length) throw new Error('openFindings missing')
  }
}])

scenarios.push(['6 args rejected before any agent call', async () => {
  const t = TASK.tasks[0]
  for (const [bad, sub] of [
    [{ typo: 1 }, 'unknown arg(s) typo'],
    [{ tasks: [] }, 'pass {tasks'],
    [{ maxRounds: 9, tasks: [t] }, 'maxRounds must be an integer 1-5'],
    [{ model: 'bad model!', tasks: [t] }, 'model must be a model name'],
    [{ checks: ['a\nb'], tasks: [t] }, 'checks must be an array'],
    [{ checksTimeout: 1.5, tasks: [t] }, 'checksTimeout must be whole seconds'],
  ]) {
    const name = `6 reject ${JSON.stringify(bad)}`
    const { agent, calls } = makeScripter({})
    let err = null
    try { const out = await runBody(bodyFor(), { args: bad, agent, log: () => {}, phase: () => {} }); err = new Error(`no throw; returned ${JSON.stringify(out && Object.keys(out))}`) } catch (e) { err = e }
    if (!String(err.message).includes(sub)) { fail(name, `message ${JSON.stringify(err.message)} lacks ${JSON.stringify(sub)}`); continue }
    if (calls.length) { fail(name, `agent was called ${calls.length}x before rejecting`); continue }
    pass(name)
  }
  // positive control: a plain string task runs
  const { out, calls } = await run({ args: 'do x' })
  eq(res(out, 'task').status, 'passed', 'plain string task status')
  if (!piCalls(calls).length) throw new Error('no clanker call for a plain string task')
}])

// ---- probes: a reviewer's edge-case claim becomes a command the checks runner (no model) settles ----
const PROBE = "node -e \"require('./q').stress(3000)\""
const runRep = (verdict, cmds) => ({ dir: DIR, verdict, changed: [{ status: 'M', path: 'src/math.js' }], checks: cmds.map((cmd) => ({ kind: 'custom', cmd, ok: verdict === 'pass', exit: verdict === 'pass' ? 0 : 1, seconds: 1, failures: verdict === 'pass' ? [] : ['RangeError: Maximum call stack size exceeded'], tail: verdict === 'pass' ? 'ok' : 'RangeError: Maximum call stack size exceeded' })) })
const runLines = (p) => p.split('\n').filter((l) => l.startsWith('checks-run: ')).map((l) => l.slice(12))
const probeOf = (r) => (res(r).probes || [])
const probeCalls = (calls) => calls.filter((c) => c.agentType === CHECKS && /:probes$/.test(c.label))

scenarios.push(['7 a failing probe blocks a passing review and is re-run until fixed', async () => {
  // F1: reviewer passes but its probe fails -> must not ship. F2: the failed probe must be re-run later.
  const { out, calls } = await run({
    args: TASK,
    spec: {
      review: (n) => n === 0
        ? { verdict: 'pass', summary: 'looks right', findings: [], probes: [{ claim: 'deep backlog overflows the stack', cmd: PROBE }] }
        : { verdict: 'pass', summary: 'fixed', findings: [], probes: [] },
      probes: (p) => checksAnswer(runRep('fail', runLines(p)), '1 of 1 checks failed'),
      checks: (n, p) => {
        const cmds = runLines(p)
        return checksAnswer(runRep(cmds.length ? 'pass' : 'none', cmds), 'checks ok')
      },
    },
  })
  const rerun = calls.filter((c) => c.agentType === CHECKS && !/:probes$/.test(c.label) && runLines(c.prompt).includes(PROBE))
  if (!rerun.length) throw new Error('the failed probe was never re-run deterministically in a later round')
  eq(res(out).status, 'passed', 'status')
  eq(res(out).rounds, 2, 'rounds')
  const fixCall = piCalls(calls)[1]
  if (!fixCall || !fixCall.prompt.includes(PROBE)) throw new Error('the clanker was not handed the failing probe command')
  eq(probeOf(out).length, 1, 'probes recorded')
  eq(probeOf(out)[0].result, 'confirmed', 'probe result')
}])

scenarios.push(['8 a passing probe clears the suspicion and does not block', async () => {
  // F3
  const { out, calls } = await run({
    args: TASK,
    spec: {
      review: () => ({ verdict: 'pass_with_nits', summary: 'ok', findings: [{ severity: 'nit', issue: 'maybe overflows' }], probes: [{ claim: 'deep backlog overflows the stack', cmd: PROBE }] }),
      probes: (p) => checksAnswer(runRep('pass', runLines(p)), 'all checks passed'),
    },
  })
  eq(res(out).status, 'passed', 'status')
  eq(res(out).rounds, 1, 'rounds')
  eq(probeCalls(calls).length, 1, 'probe runs')
  eq(probeOf(out)[0].result, 'cleared', 'probe result')
}])

scenarios.push(['9 an unavailable probe runner never invents a block', async () => {
  // F4
  const { out } = await run({
    args: TASK,
    spec: {
      review: () => ({ verdict: 'pass', summary: 'ok', findings: [], probes: [{ claim: 'x', cmd: PROBE }] }),
      probes: () => 'the checks runner is not running',
    },
  })
  eq(res(out).status, 'passed', 'status')
  eq(probeOf(out)[0].result, 'unverified', 'probe result')
}])

scenarios.push(['10 multi-line probes are dropped and at most 5 run, each with a short timeout', async () => {
  // F5
  const many = Array.from({ length: 8 }, (_, i) => ({ claim: `c${i}`, cmd: `node -e "p(${i})"` }))
  const { calls } = await run({
    args: TASK,
    spec: {
      review: () => ({ verdict: 'pass', summary: 'ok', findings: [], probes: [{ claim: 'bad', cmd: 'echo a\nrm -rf b' }, ...many] }),
      probes: (p) => checksAnswer(runRep('pass', runLines(p)), 'all checks passed'),
    },
  })
  const p = probeCalls(calls)[0]
  if (!p) throw new Error('no probe run')
  const cmds = runLines(p.prompt)
  eq(cmds.length, 5, 'probe commands run')
  if (cmds.some((c) => c.includes('rm -rf'))) throw new Error('a multi-line probe was run')
  if (!/^checks-timeout: \d+$/m.test(p.prompt) || Number(p.prompt.match(/^checks-timeout: (\d+)$/m)[1]) > 120) throw new Error('probe run has no short timeout')
}])

scenarios.push(['11 the reviewer is told crashes and spec violations are blockers, never nits', async () => {
  const { calls } = await run({ args: TASK })
  const p = reviewCalls(calls)[0].prompt
  for (const w of ['crash', 'hang', 'spec', 'never a nit', 'probe']) if (!p.toLowerCase().includes(w)) throw new Error(`review prompt lacks ${JSON.stringify(w)}`)
}])

// ---- written before the code: a check already red on the base, and the executor's scope ----
// Ways it can fail:
//   B1 a check red at base and red now becomes a blocker, so the executor is sent to fix
//      something outside its task (seen in a real repo, 2026-10-21).
//   B2 a check green at base and red now is hidden: a regression must always block.
//   B3 the base run is unavailable or unreadable and failures are waved through: fail closed.
//   B4 a check skipped or missing at base, or a setup that failed only now, is waved through.
//   B5 the base run happens when nothing fails (cost on the happy path), or more than once per task.
//   B6 the base run checks the executor's directory in place instead of the commit it started from.
//   B7 a pre-existing failure is hidden from the reviewer: it is context the reviewer must see.
//   S1 the executor's prompt carries anything but fixed text, the task and the findings.
//   S2 the executor's prompt does not name what it must never do (push, gh, op, ssh, servers,
//      stash, kill), or does not say the task is its only instruction.
const BASE_RE = /^checks-base: HEAD$/m
const rep = (cmds, setup = []) => ({ dir: DIR, verdict: cmds.every((c) => c.ok) && setup.every((c) => c.ok) ? 'pass' : 'fail', changed: [{ status: 'M', path: 'src/math.js' }], setup: setup.map((c) => ({ kind: 'setup', exit: c.ok ? 0 : 1, seconds: 1, failures: c.ok ? [] : ['ERROR'], tail: c.ok ? 'ok' : 'ERROR', ...c })), checks: cmds.map((c) => ({ kind: 'check', exit: c.ok ? 0 : 1, seconds: 1, failures: c.ok ? [] : ['FAIL'], tail: c.ok ? 'ok' : 'FAIL x', ...c })) })
// checks(n, prompt): the base run answers `base`, every other run answers `now(k)` for its k-th call.
const baseSpec = (now, base) => {
  let k = 0
  return { checks: (_n, p) => BASE_RE.test(p) ? (base === null ? 'the runner crashed' : checksAnswer({ ...base, changed: [] }, 'base')) : checksAnswer(now(k++), 'now') }
}
const isBase = (c) => c.agentType === CHECKS && BASE_RE.test(c.prompt)

scenarios.push(['B1 a check red at base and red now does not block; the reviewer sees it as pre-existing', async () => {
  const red = rep([{ cmd: 'npm run lint', ok: false }, { cmd: 'npm test', ok: true }])
  const { out, calls } = await run({ args: TASK, spec: baseSpec(() => red, red) })
  eq(res(out).status, 'passed', 'status')
  eq(res(out).rounds, 1, 'rounds')
  eq(calls.filter(isBase).length, 1, 'base runs')
  const rv = reviewCalls(calls)[0]
  if (!rv || !/pre-existing/i.test(rv.prompt) || !rv.prompt.includes('npm run lint')) throw new Error('reviewer was not told the lint failure is pre-existing')
}])

scenarios.push(['B2 a check green at base and red now blocks, alongside a pre-existing one', async () => {
  const base = rep([{ cmd: 'npm run lint', ok: false }, { cmd: 'npm test', ok: true }])
  const now = (k) => k === 0 ? rep([{ cmd: 'npm run lint', ok: false }, { cmd: 'npm test', ok: false }]) : base
  const { out, calls } = await run({ args: TASK, spec: baseSpec(now, base) })
  eq(res(out).rounds, 2, 'rounds')
  const fix = piCalls(calls)[1]
  if (!fix || !fix.prompt.includes('`npm test` failed')) throw new Error('the regression did not go back to the clanker')
  if (fix.prompt.includes('`npm run lint` failed')) throw new Error('the pre-existing failure went back to the clanker')
  eq(calls.filter(isBase).length, 1, 'base runs (once per task)')
}])

scenarios.push(['B3 an unavailable or unreadable base run fails closed: every failure blocks', async () => {
  for (const base of [null, { dir: DIR, verdict: 'fail' }]) {
    const red = rep([{ cmd: 'npm run lint', ok: false }])
    const now = (k) => k === 0 ? red : rep([{ cmd: 'npm run lint', ok: true }])
    const { out, calls } = await run({ args: TASK, spec: baseSpec(now, base) })
    eq(res(out).rounds, 2, `rounds (base ${base === null ? 'unavailable' : 'unreadable'})`)
    if (!piCalls(calls)[1]?.prompt.includes('`npm run lint` failed')) throw new Error('the failure did not block')
  }
}])

scenarios.push(['B4 skipped or missing at base, or setup red only now, still blocks', async () => {
  const cases = [
    [rep([{ cmd: 'npm test', ok: false, skipped: 'setup failed' }], [{ cmd: 'npm ci', ok: false }]), rep([{ cmd: 'npm test', ok: false }])],
    [rep([{ cmd: 'npm run lint', ok: true }]), rep([{ cmd: 'npm test', ok: false }])],
    [rep([{ cmd: 'npm test', ok: true }], [{ cmd: 'npm ci', ok: true }]), rep([{ cmd: 'npm test', ok: false, skipped: 'setup failed' }], [{ cmd: 'npm ci', ok: false }])],
  ]
  for (const [i, [base, red]] of cases.entries()) {
    const now = (k) => k === 0 ? red : rep([{ cmd: 'npm test', ok: true }])
    const { out } = await run({ args: TASK, spec: baseSpec(now, base) })
    eq(res(out).rounds, 2, `rounds (case ${i + 1})`)
  }
}])

scenarios.push(['B5 B6 no base run when the checks pass; the base run asks for HEAD', async () => {
  const green = rep([{ cmd: 'npm test', ok: true }])
  const { calls } = await run({ args: TASK, spec: baseSpec(() => green, green) })
  eq(calls.filter(isBase).length, 0, 'base runs on a green gate')
  const red = rep([{ cmd: 'npm run lint', ok: false }])
  const r = await run({ args: TASK, spec: baseSpec(() => red, red) })
  const b = r.calls.find(isBase)
  if (!b || !b.prompt.includes(`checks-dir: ${DIR}`)) throw new Error('the base run did not name the task worktree with checks-base: HEAD')
}])

scenarios.push(['S1 S2 the executor prompt holds only fixed text, the task and findings, and names the forbidden acts', async () => {
  const { calls } = await run({ args: { tasks: [{ id: 't1', prompt: 'TASKTEXT-123' }] }, spec: { approve: (n) => n > 0 } })
  const [first, second] = piCalls(calls)
  for (const w of ['git push', 'gh', 'op', 'ssh', 'server', 'stash', 'kill']) if (!new RegExp(`\\b${w}\\b`).test(first.prompt)) throw new Error(`the scope does not name ${w}`)
  if (!/only instruction/i.test(first.prompt)) throw new Error('the scope does not say the task is the only instruction')
  if (!second.prompt.includes('TASKTEXT-123') || !second.prompt.includes('still wrong')) throw new Error('round 2 lost the task or findings')
}])

// ---- convergence scenarios ----
const PRE = { severity: 'blocker', scope: 'pre-existing', file: 'src/legacy.js:40', sites: ['src/legacy.js:40', 'src/legacy.js:88'], issue: 'unchecked null from parse()', fix: 'guard it' }
const BUG = { severity: 'blocker', scope: 'change', file: 'src/math.js:12', sites: ['src/math.js:12'], issue: 'sub() returns a + b', fix: 'return a - b' }
const rounds = (out) => res(out).history.filter((h) => h.reviewed).length

scenarios.push(['C1 pre-existing blocker never blocks', async () => {
  // The reviewer says block, but its only blocker sits in code the change did not touch.
  const { out, calls } = await run({ args: TASK, spec: { review: () => ({ verdict: 'block', summary: 'legacy bug', findings: [PRE], verification: [] }) } })
  const t = res(out)
  eq(t.status, 'passed', 'status')
  eq(t.verdict, 'pass_with_nits', 'effective verdict')
  eq(t.rounds, 1, 'rounds')
  eq(piCalls(calls).length, 1, 'clanker calls (no fix round)')
  eq(t.preExisting.length, 1, 'preExisting reported')
  eq(t.preExisting[0].issue, PRE.issue, 'preExisting carries the finding')
  if (piCalls(calls).some((c) => c.prompt.includes(PRE.issue))) throw new Error('a pre-existing finding reached the clanker')
}])

scenarios.push(['C2 a closed finding is never re-reported', async () => {
  // Round 1: one real blocker. Round 2: the reviewer resolves it with a reason, then re-reports the same
  // defect as a fresh blocker (same file and issue; once by key, once by priorId). Both must be suppressed.
  for (const how of ['key', 'priorId']) {
    const review = (n) => n === 0
      ? { verdict: 'block', summary: 'bug', findings: [BUG], verification: [] }
      : { verdict: 'block', summary: 're-report', findings: [how === 'key' ? { ...BUG, file: 'src/math.js:14' } : { ...BUG, file: 'src/other.js:1', issue: 'wrong sign', priorId: 'B1.1' }], verification: [{ id: 'B1.1', status: 'resolved', reason: 'the diff now returns a - b' }] }
    const { out, calls } = await run({ args: TASK, spec: { review } })
    const t = res(out)
    eq(t.status, 'passed', `status (${how})`)
    eq(t.rounds, 2, `rounds (${how})`)
    eq(t.closed.length, 1, `closed (${how})`)
    eq(t.closed[0].id, 'B1.1', `closed id (${how})`)
    eq(t.closed[0].reason, 'the diff now returns a - b', `closed reason (${how})`)
    eq(t.suppressed.length, 1, `suppressed (${how})`)
    eq(piCalls(calls).length, 2, `clanker calls (${how})`)
    const fix = piCalls(calls)[1].prompt
    if (!fix.includes('B1.1')) throw new Error(`the fix prompt lacks the finding id (${how})`)
    if (!fix.includes('src/math.js:12')) throw new Error(`the fix prompt lacks the sites (${how})`)
  }
}])

scenarios.push(['C3 re-review scope: open and closed findings, only what changed', async () => {
  const prompts = []
  const review = (n, p) => { prompts.push(p); return n === 0
    ? { verdict: 'block', summary: 'bug', findings: [BUG], verification: [] }
    : n === 1 ? { verdict: 'block', summary: 'still', findings: [], verification: [{ id: 'B1.1', status: 'not-resolved', reason: 'sign still wrong' }] }
    : { verdict: 'pass', summary: 'ok', findings: [], verification: [{ id: 'B1.1', status: 'resolved', reason: 'fixed' }] } }
  const changed = [{ status: 'M', path: 'src/math.js' }, { status: 'M', path: 'src/math.test.js' }]
  const checks = (n) => checksAnswer({ dir: DIR, verdict: 'none', changed: n < 2 ? changed : changed.concat([{ status: 'A', path: 'src/sign.js' }]), checks: [] }, 'no checks configured')
  const { out } = await run({ args: TASK, spec: { review, checks } })
  eq(res(out).status, 'passed', 'status')
  eq(res(out).rounds, 3, 'rounds')
  if (prompts[0].includes('RE-REVIEW')) throw new Error('round 1 was framed as a re-review')
  if (!prompts[1].includes('RE-REVIEW (round 2)')) throw new Error('round 2 is not framed as a re-review')
  if (!prompts[1].includes('OPEN FINDINGS') || !prompts[1].includes('"id":"B1.1"')) throw new Error('round 2 does not list the open finding by id')
  if (!prompts[1].includes('Do not re-review the rest of the change')) throw new Error('round 2 does not restrict the scope')
  if (!prompts[2].includes('New since the previous round: src/sign.js')) throw new Error(`round 3 does not name the file new since round 2: ${prompts[2].match(/New since[^\n]*/)}`)
  // The carried blocker keeps its id and is handed back unchanged.
  eq(res(out).history[1].carried, 1, 'round 2 carried the open blocker')
  eq(res(out).history[2].closed.join(','), 'B1.1', 'round 3 closed it')
}])

scenarios.push(['C4 an unverified open finding stays open', async () => {
  // Round 2's reviewer passes without verifying B1.1: fail closed, the blocker is carried; round 3 resolves it.
  const review = (n) => n === 0
    ? { verdict: 'block', summary: 'bug', findings: [BUG], verification: [] }
    : n === 1 ? { verdict: 'pass', summary: 'looks fine', findings: [], verification: [] }
    : { verdict: 'pass', summary: 'ok', findings: [], verification: [{ id: 'B1.1', status: 'resolved', reason: 'fixed' }] }
  const { out, calls } = await run({ args: TASK, spec: { review } })
  eq(res(out).status, 'passed', 'status')
  eq(res(out).rounds, 3, 'rounds')
  eq(res(out).history[1].verdict, 'block', 'round 2 effective verdict')
  eq(res(out).history[1].reviewerVerdict, 'pass', 'round 2 reviewer verdict kept for the record')
  eq(piCalls(calls).length, 3, 'clanker calls')
}])

scenarios.push(['C5 the cap asks for a rethink before the fallback', async () => {
  const { out, calls } = await run({ args: TASK, spec: { approve: rejectAll } })
  const t = res(out)
  eq(t.status, 'needs-coordinator', 'status')
  const esc = piCalls(calls).find((c) => c.label.includes(':escalate'))
  if (!esc) throw new Error('no escalation call')
  eq(piModel(esc), FALLBACK, 'escalation model')
  if (!esc.prompt.includes('RETHINK THE APPROACH')) throw new Error('the escalation prompt does not ask for a rethink')
  if (piCalls(calls).slice(0, -1).some((c) => c.prompt.includes('RETHINK THE APPROACH'))) throw new Error('a rethink was asked before the cap')
  if (typeof t.rethink !== 'string' || !t.rethink.includes('change the approach')) throw new Error('the result carries no rethink note')
  eq(t.history.filter((h) => h.rethinkRequested).length, 1, 'one rethink in the history')
}])

// the explainer step is opt-in, measured, and read by the reviewer.
const EXPLAINED = `Changed files:\nM src/math.js\n\nAdded sub(a, b).\n\nEXPLAINERS\n## src/math.js\nExports add and sub, pure functions over numbers.\nCalled from src/cli.js and the tests.\nInvariant: no function here touches I/O, so the tests stay deterministic.\n\nFiles changed: src/math.js\nCommands ran: npm test (passed)`
scenarios.push(['E1 explainer on: the clanker is asked, the reviewer is told, the result carries the cost', async () => {
  const { out, calls } = await run({ args: { ...TASK, explainer: true }, spec: { pi: (prompt) => piAnswer(EXPLAINED, piModelOf(prompt), `sandbox: ${DIR}`) } })
  const t = res(out)
  eq(t.status, 'passed', 'status')
  if (!piCalls(calls)[0].prompt.includes('EXPLAINER BEFORE CHANGE')) throw new Error('the executor prompt has no explainer step')
  if (!piCalls(calls)[0].prompt.endsWith('needs no explainer.')) throw new Error('the explainer step is not the last rule')
  if (!/EXPLAINERS section/.test(reviewCalls(calls)[0].prompt)) throw new Error('the reviewer is not told about the explainers')
  if (!t.explainerCost) throw new Error('no explainerCost on the result')
  eq(t.explainerCost.rounds.length, 1, 'one measured round')
  eq(t.explainerCost.rounds[0].present, true, 'explainers present')
  eq(t.explainerCost.rounds[0].modules, 1, 'one module')
  eq(t.explainerCost.rounds[0].lines, 4, 'explainer lines')
  eq(t.explainerCost.approxTokens, Math.ceil(t.explainerCost.rounds[0].chars / 4), 'tokens = chars / 4')
  eq(t.explainerCost.roundsWithout, 0, 'no round without explainers')
}])
scenarios.push(['E2 explainer off by default: no step, no reviewer note, no field', async () => {
  const { out, calls } = await run({ args: TASK })
  if (piCalls(calls)[0].prompt.includes('EXPLAINER')) throw new Error('the executor prompt mentions the explainer step without the flag')
  if (/EXPLAINERS section/.test(reviewCalls(calls)[0].prompt)) throw new Error('the reviewer is told about explainers without the flag')
  if ('explainerCost' in res(out)) throw new Error('explainerCost present without the flag')
}])
scenarios.push(['E3 explainer on but the clanker wrote none: measured as a round without', async () => {
  const { out } = await run({ args: { ...TASK, explainer: true } })
  eq(res(out).explainerCost.roundsWithout, 1, 'rounds without')
  eq(res(out).explainerCost.approxTokens, 0, 'tokens')
}])
scenarios.push(['E4 explainer must be a boolean', async () => {
  let threw = ''
  try { await run({ args: { ...TASK, explainer: 'yes' } }) } catch (e) { threw = e.message }
  if (!/explainer must be true or false/.test(threw)) throw new Error(`want a clear error, got ${JSON.stringify(threw)}`)
}])
// risk from the diff. The checks runner lists the changed paths; a risky path makes the review risky.
const changedTo = (...paths) => () => checksAnswer({ dir: DIR, verdict: 'none', changed: paths.map((p) => ({ status: 'M', path: p })), checks: [] }, 'no checks configured')
scenarios.push(['R1 a change under .github makes the task risky: Opus reviews, the result asks for owner approval', async () => {
  const { out, calls } = await run({ args: TASK, spec: { checks: changedTo('src/math.js', '.github/workflows/ci.yml') } })
  const t = res(out)
  eq(reviewCalls(calls)[0].model, 'opus', 'reviewer model')
  if (!/RISK: this change touches \.github\/workflows\/ci\.yml \(ci\)/.test(reviewCalls(calls)[0].prompt)) throw new Error('the reviewer is not told the risk')
  eq(t.risky, true, 'risky')
  eq(JSON.stringify(t.riskyPaths), JSON.stringify([{ path: '.github/workflows/ci.yml', rule: 'ci' }]), 'riskyPaths')
  if (!/^owner approval needed: .*\.github\/workflows\/ci\.yml/.test(t.ownerApproval || '')) throw new Error(`ownerApproval: ${t.ownerApproval}`)
  eq(t.history[0].risky, true, 'history risky')
}])
scenarios.push(['R2 a plain change stays on Sonnet with no approval note', async () => {
  const { out, calls } = await run({ args: TASK })
  const t = res(out)
  eq(reviewCalls(calls)[0].model, 'sonnet', 'reviewer model')
  if (/RISK:/.test(reviewCalls(calls)[0].prompt)) throw new Error('a plain change was called risky')
  eq(t.risky, false, 'risky')
  eq(t.riskyPaths.length, 0, 'riskyPaths')
  if ('ownerApproval' in t) throw new Error('ownerApproval on a plain change')
  eq(t.history[0].risky, false, 'history risky')
}])
scenarios.push(['R3 the caller\'s risky only adds: Opus reviews a plain diff, with no path to approve', async () => {
  const { out, calls } = await run({ args: { tasks: [{ id: 't1', prompt: 'touch prod', risky: true }] } })
  const t = res(out)
  eq(reviewCalls(calls)[0].model, 'opus', 'reviewer model')
  eq(t.risky, true, 'risky')
  eq(t.riskyPaths.length, 0, 'riskyPaths')
  if ('ownerApproval' in t) throw new Error('ownerApproval without a risky path')
}])
scenarios.push(['R4 a risky path that appears in round 2 switches that round to Opus and stays in the result', async () => {
  const { out, calls } = await run({ args: TASK, spec: { review: (n) => (n === 0 ? { verdict: 'block', summary: 'nope', findings: [{ severity: 'blocker', scope: 'change', issue: 'still wrong', fix: 'fix it' }], verification: [], probes: [] } : { verdict: 'pass', summary: 'fixed', findings: [], verification: [{ id: 'B1.1', status: 'resolved', reason: 'the diff fixes it' }], probes: [] }), checks: (n) => (n === 0 ? changedTo('src/math.js') : changedTo('src/math.js', 'db/migrations/0002_users.sql'))() } })
  const t = res(out)
  eq(t.status, 'passed', 'status')
  eq(t.rounds, 2, 'rounds')
  eq(reviewCalls(calls)[0].model, 'sonnet', 'round 1 reviewer')
  eq(reviewCalls(calls)[1].model, 'opus', 'round 2 reviewer')
  eq(t.risky, true, 'risky')
  eq(JSON.stringify(t.riskyPaths), JSON.stringify([{ path: 'db/migrations/0002_users.sql', rule: 'migrations' }]), 'riskyPaths')
  eq(t.history[0].risky, false, 'round 1 history')
  eq(t.history[1].risky, true, 'round 2 history')
}])

// the reviewer reads the repository's REVIEW.md first, and it cannot lower a severity.
scenarios.push(['V1 the reviewer is told to read REVIEW.md in the worktree first, and that it cannot lower a severity', async () => {
  const { calls } = await run({ args: TASK })
  const p = reviewCalls(calls)[0].prompt
  if (!p.includes(`If ${DIR}/REVIEW.md exists, read it first (C-REV-10)`)) throw new Error('no REVIEW.md instruction with the worktree path')
  if (!/cannot lower a severity/.test(p)) throw new Error('REVIEW.md is allowed to lower a severity')
  if (!/three sites, or a class REVIEW\.md names/.test(p)) throw new Error('no fix-at-the-source instruction')
}])

for (const [name, fn] of scenarios) {
  try { await fn(); pass(name) } catch (e) { fail(name, e.message) }
}

// ---- negative controls: mutate the source, the paired scenario must now FAIL ----
// Each entry reruns the same scripted agent against the mutated body and re-asserts the
// scenario's key expectation; broke=true means the mutation was caught.
const controls = [
  {
    name: 'risky never routes to opus',
    target: 'model: reviewModel(task.risky || risk.length > 0)',
    mutate: (s) => s.replace('model: reviewModel(task.risky || risk.length > 0)', 'model: ROUTING.reviewer'),
    async broke() {
      const { calls } = await run({ args: { tasks: [{ id: 't1', prompt: 'touch prod', risky: true }] }, mutate: this.mutate })
      return reviewCalls(calls)[0].model !== 'opus'
    },
  },
  {
    name: 'maxRounds arg ignored',
    target: "const MAX_ROUNDS = intArg(A, 'maxRounds', 3, 1, 5)",
    mutate: (s) => s.replace("const MAX_ROUNDS = intArg(A, 'maxRounds', 3, 1, 5)", 'const MAX_ROUNDS = 3'),
    async broke() {
      const { out } = await run({ args: { ...TASK, maxRounds: 2 }, spec: { approve: rejectAll }, mutate: this.mutate })
      return res(out).rounds !== 3
    },
  },
  {
    name: 'the executor fallback broken',
    target: 'r = await agent(`${head(ROUTING.fallback)}',
    mutate: (s) => s.replace('r = await agent(`${head(ROUTING.fallback)}', 'r = await agent(`${head(ROUTING.executor)}'),
    async broke() {
      const { out, calls } = await run({ args: TASK, spec: { pi: executorDownPi }, mutate: this.mutate })
      const fallback = piCalls(calls).some((c) => piModel(c) === FALLBACK)
      return !fallback || res(out).status !== 'passed'
    },
  },
  {
    name: 'probe failures ignored',
    target: 'const probeBlockers = ',
    mutate: (s) => s.replace('const probeBlockers = ', 'const probeBlockers = () => []; const _unusedProbeBlockers = '),
    async broke() {
      const { out } = await run({
        args: TASK,
        mutate: this.mutate,
        spec: {
          review: () => ({ verdict: 'pass', summary: 'ok', findings: [], probes: [{ claim: 'x', cmd: PROBE }] }),
          probes: (p) => checksAnswer(runRep('fail', runLines(p)), '1 of 1 checks failed'),
        },
      })
      return res(out).rounds === 1
    },
  },
  {
    name: 'pre-existing findings block',
    target: "if (isPreExisting(f)) { pre.push({ ...f, round }); continue }",
    mutate: (s) => s.replace("if (isPreExisting(f)) { pre.push({ ...f, round }); continue }", "if (false) { pre.push({ ...f, round }); continue }"),
    async broke() {
      const { out } = await run({ args: TASK, spec: { review: () => ({ verdict: 'block', summary: 'legacy bug', findings: [PRE], verification: [] }) }, mutate: this.mutate })
      return res(out).status !== 'passed'
    },
  },
  {
    name: 'closed findings are re-reported',
    target: "if ((f.priorId && closedIds.has(f.priorId)) || closedKeys.has(k))",
    mutate: (s) => s.replace("if ((f.priorId && closedIds.has(f.priorId)) || closedKeys.has(k))", "if (false)"),
    async broke() {
      const review = (n) => n === 0
        ? { verdict: 'block', summary: 'bug', findings: [BUG], verification: [] }
        : { verdict: 'block', summary: 're-report', findings: [{ ...BUG, file: 'src/math.js:14' }], verification: [{ id: 'B1.1', status: 'resolved', reason: 'fixed' }] }
      const { out } = await run({ args: TASK, spec: { review }, mutate: this.mutate })
      return res(out).status !== 'passed' || res(out).rounds !== 2
    },
  },
  {
    name: 'unverified open findings are dropped',
    target: "for (const f of verificationMissing(state.open, verification)) carried.push(",
    mutate: (s) => s.replace("for (const f of verificationMissing(state.open, verification)) carried.push(", "for (const f of []) carried.push("),
    async broke() {
      const review = (n) => n === 0 ? { verdict: 'block', summary: 'bug', findings: [BUG], verification: [] } : { verdict: 'pass', summary: 'fine', findings: [], verification: [] }
      const { out } = await run({ args: TASK, spec: { review }, mutate: this.mutate })
      return res(out).rounds !== 3
    },
  },
  {
    name: 'the cap escalates without a rethink',
    target: "RETHINK(MAX_ROUNDS))",
    mutate: (s) => s.replace("RETHINK(MAX_ROUNDS))", "'')"),
    async broke() {
      const { calls } = await run({ args: TASK, spec: { approve: rejectAll }, mutate: this.mutate })
      const esc = piCalls(calls).find((c) => c.label.includes(':escalate'))
      return !esc || !esc.prompt.includes('RETHINK THE APPROACH')
    },
  },
]

// gate controls: a gate that ignores the base, one that excuses every failure, a scope that is dropped.
{
  const red2 = rep([{ cmd: 'npm run lint', ok: false }])
  const regressed = (k) => k === 0 ? rep([{ cmd: 'npm run lint', ok: false }, { cmd: 'npm test', ok: false }]) : rep([{ cmd: 'npm run lint', ok: false }, { cmd: 'npm test', ok: true }])
  const greenTest = rep([{ cmd: 'npm run lint', ok: false }, { cmd: 'npm test', ok: true }])
  controls.push(
    { name: 'base ignored (B1)', target: 'const preExisting = (base, x) =>', mutate: (t) => t.replace('const preExisting = (base, x) =>', 'const preExisting = () => false; const _p = (base, x) =>'),
      async broke() { const { out } = await run({ args: TASK, mutate: this.mutate, spec: baseSpec(() => red2, red2) }); return res(out).status !== 'passed' } },
    { name: 'every failure excused (B2)', target: 'const preExisting = (base, x) =>', mutate: (t) => t.replace('const preExisting = (base, x) =>', 'const preExisting = () => true; const _p = (base, x) =>'),
      async broke() { const { out } = await run({ args: TASK, mutate: this.mutate, spec: baseSpec(regressed, greenTest) }); return res(out).rounds !== 2 } },
    { name: 'scope dropped (S2)', target: "  'SCOPE: the TASK above", mutate: (t) => t.replace(/  'SCOPE: [^\n]*\n  'Never: [^\n]*\n/, ''),
      async broke() { const { calls } = await run({ args: TASK, mutate: this.mutate }); return !/only instruction/.test(piCalls(calls)[0].prompt) } },
  )
}

// REVIEW.md
controls.push({ name: 'REVIEW.md instruction dropped (V1)', target: '/REVIEW.md exists, read it first (C-REV-10)', mutate: (t) => t.replace(/\n  `If \$\{dir\}\/REVIEW\.md exists[^\n]*\n/, '\n'),
  async broke() { const { calls } = await run({ args: TASK, mutate: this.mutate }); return !reviewCalls(calls)[0].prompt.includes('REVIEW.md') } })
// risk from the diff
controls.push({ name: 'risk from the diff ignored (R1)', target: 'const risk = riskFromPaths(changedFiles)', mutate: (t) => t.replace('const risk = riskFromPaths(changedFiles)', 'const risk = []'),
  async broke() { const { out, calls } = await run({ args: TASK, mutate: this.mutate, spec: { checks: changedTo('.github/workflows/ci.yml') } }); return reviewCalls(calls)[0].model !== 'opus' || res(out).risky !== true } })
// explainer
controls.push({ name: 'explainer flag ignored (E1)', target: "const EXPLAINER_ON = A.explainer === true", mutate: (t) => t.replace("const EXPLAINER_ON = A.explainer === true", 'const EXPLAINER_ON = false'),
  async broke() { const { calls } = await run({ args: { ...TASK, explainer: true }, mutate: this.mutate }); return !piCalls(calls)[0].prompt.includes('EXPLAINER BEFORE CHANGE') } })

for (const c of controls) {
  const name = `negative-control ${c.name}`
  if (!SRC.includes(c.target)) { fail(name, `mutation target missing: ${JSON.stringify(c.target)}`); continue }
  try {
    if (await c.broke()) pass(name)
    else fail(name, 'scenario still passed with the mutation applied')
  } catch (e) {
    fail(name, `mutated run threw instead of failing the scenario's assertion: ${e && e.message}`)
  }
}

console.log(fails ? `${fails} FAIL` : 'ALL PASS')
process.exit(fails ? 1 : 0)
