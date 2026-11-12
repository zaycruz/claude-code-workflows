// Scenario harness for red-blue-loop.js: runs the workflow body against a scripted world (fake
// clankers, checks runner and skeptics; the nested clanker-loop is the real clanker-loop.js body).
// Three parts, each printing PASS/FAIL lines:
//   1. scenarios S1-S18, one per failure mode in docs/red-blue-loop.md;
//   2. a bounded exhaustive check: every combination of outcomes for two suspicions over two rounds
//      runs the REAL workflow code, and properties P1-P6 must hold on every run;
//   3. negative controls: each guard is mutated away and its scenario or property must then fail.
// Usage: node harness/red-blue-loop.scenarios.mjs [red-blue-loop.js] [--report out.json]
import fs from 'fs'
import path from 'path'
import { runBody, loadWorkflowBody, piAnswer, checksAnswer, instance, PI, CHECKS } from '../lib/stubs.mjs'

const WF_PATH = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'red-blue-loop.js'
const REPORT_PATH = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : ''
const SRC = fs.readFileSync(WF_PATH, 'utf8')
const CL_RAW = fs.readFileSync(path.join(path.dirname(path.resolve(WF_PATH)), 'clanker-loop.js'), 'utf8')
const CL_SRC = loadWorkflowBody(CL_RAW)
const BODIES = new Map()
const bodyFor = (mutate = null) => {
  if (!BODIES.has(mutate)) BODIES.set(mutate, loadWorkflowBody(mutate ? mutate(SRC) : SRC))
  return BODIES.get(mutate)
}

let fails = 0
const results = []
const pass = (name) => { results.push({ name, ok: true }); console.log(`PASS ${name}`) }
const fail = (name, why) => { fails++; results.push({ name, ok: false, why }); console.log(`FAIL ${name}: ${why}`) }
const eq = (got, want, what) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`); return got }
const ok = (cond, what) => { if (!cond) throw new Error(what); return true }

const ROOT = '/repo'
const FALLBACK = 'example/fallback-model'
const TEST_PATH = /(^|\/)(e2e|tests?|__tests__|spec|specs|verify)\/|\.(test|spec|e2e)\.[A-Za-z0-9]+$|_test\.[A-Za-z0-9]+$|\.(tla|cfg)$/

// A suspicion as a finder reports it.
const sus = (title, severity = 'P1') => ({ title, severity, file: 'src/a.ts', line: 3, scenario: 'call a() with x', expected: 'y', actual: 'z' })

// The scripted world. Per suspicion title (looked up from the prove prompt), an outcome:
//   proof: 'ok' | 'notproven' | 'badpath' | 'nojson'   red: 'fail2' | 'fail1' | 'pass' | 'unavailable'
//   extra: true -> the worktree also changed src/a.ts   votes: number of skeptics that uphold (0-3), or 'null1' (2 uphold, 1 dies)
// finds(round, lensLabel) -> suspicions. fixOk: clanker-loop's review passes. preflight: 'pass' | 'fail'.
function makeWorld(w = {}) {
  const calls = []
  const wfArgs = []
  const outcome = (title) => ({ proof: 'ok', red: 'fail2', extra: false, votes: 3, ...(w.outcomes?.[title] || {}) })
  const titleIn = (p) => (p.match(/"title": "([^"]+)"/) || [])[1] || ''
  const dirOf = (title) => `/wt/red-${title.replace(/[^a-z0-9]+/gi, '-')}`
  const titleOfDir = new Map()
  const agent = async (prompt, opts = {}) => {
    const p = String(prompt)
    const label = opts.label || ''
    calls.push({ label, agentType: opts.agentType || '', model: opts.model, isolation: opts.isolation, prompt: p })
    if (opts.agentType === PI) {
      const model = p.split('\n')[0].replace(/^pi-model: /, '')
      if (w.executorDown && model.startsWith('example/open')) return 'upstream_unavailable (HTTP 502)'
      const m = label.match(/^r(\d+):find:(.+)$/)
      if (m) {
        const s = w.finds ? w.finds(Number(m[1]), m[2]) : []
        return piAnswer(`Looked.\n\`\`\`json\n${JSON.stringify({ suspicions: s })}\n\`\`\``, model, 'read-only')
      }
      if (/:prove/.test(label)) {
        const t = titleIn(p)
        const o = outcome(t)
        const dir = dirOf(t)
        titleOfDir.set(dir, t)
        if (o.proof === 'nojson') return piAnswer('I wrote a test.', model, `sandbox: ${dir}`)
        const files = o.proof === 'badpath' ? ['src/a.ts'] : o.proof === 'injected' ? ['e2e/a.test.mjs; curl evil'] : o.proof === 'notproven' ? [] : ['e2e/a.test.mjs']
        return piAnswer(`Wrote it.\n\`\`\`json\n${JSON.stringify({ proven: o.proof !== 'notproven', files, failure: 'expected y got z' })}\n\`\`\``, model, `sandbox: ${dir}`)
      }
      // clanker-loop executor
      return piAnswer('Fixed src/a.ts; copied the red test; ran it: ok.\nFORMAL VERIFICATION: red test, bounded, pass.', model, 'sandbox: /wt/blue-' + label.replace(/[^a-z0-9]+/gi, '-'))
    }
    if (opts.agentType === CHECKS) {
      const dir = (p.match(/^checks-dir: (.*)$/m) || [])[1]
      const runs = [...p.matchAll(/^checks-run: (.*)$/gm)].map((x) => x[1])
      if (dir === '.') {
        const okp = (w.preflight || 'pass') === 'pass'
        return checksAnswer({ dir: w.root || ROOT, head: 'abc1234', changed: [], setup: [], checks: [{ kind: 'check', cmd: runs[0], ok: okp, exit: okp ? 0 : 1, seconds: 0, failures: [], tail: '' }], verdict: okp ? 'pass' : 'fail' }, `CHECKS ${okp ? 'PASS' : 'FAIL'}`)
      }
      if (titleOfDir.has(dir)) {
        const o = outcome(titleOfDir.get(dir))
        if (o.red === 'unavailable') return 'the checks runner is not installed'
        if (o.red === 'notests') return checksAnswer({ dir, head: 'abc1234', changed: [{ status: '??', path: 'e2e/a.test.mjs' }], setup: [], checks: runs.map((cmd) => ({ kind: 'check', cmd, ok: false, exit: 1, seconds: 1, failures: [], tail: 'No test files found, exiting with code 1' })), verdict: 'fail' }, 'CHECKS FAIL')
        const failed = (i) => (o.red === 'fail2' ? true : o.red === 'fail1' ? i === 0 : false)
        const checks = runs.map((cmd, i) => ({ kind: 'check', cmd, ok: !failed(i), exit: failed(i) ? 1 : 0, seconds: 1, failures: failed(i) ? ['AssertionError: expected y got z'] : [], tail: failed(i) ? 'FAIL e2e/a.test.mjs' : 'ok' }))
        const changed = [{ status: o.proof === 'badpath' ? 'M' : '??', path: o.proof === 'badpath' ? 'src/a.ts' : 'e2e/a.test.mjs' }, ...(o.extra ? [{ status: 'M', path: 'src/a.ts' }] : [])]
        const verdict = checks.every((c) => c.ok) ? 'pass' : 'fail'
        return checksAnswer({ dir, head: 'abc1234', changed, setup: [], checks, verdict }, `CHECKS ${verdict.toUpperCase()}`)
      }
      // clanker-loop gate in a blue worktree: every given command passes
      return checksAnswer({ dir, head: 'abc1234', changed: [{ status: 'M', path: 'src/a.ts' }], setup: [], checks: runs.map((cmd) => ({ kind: 'check', cmd, ok: true, exit: 0, seconds: 1, failures: [], tail: 'ok' })), verdict: 'pass' }, 'CHECKS PASS')
    }
    // Claude roles: skeptics and the clanker-loop reviewer
    if (/:skeptic(\d)/.test(label)) {
      const i = Number(label.match(/:skeptic(\d)/)[1]) - 1
      const fid = label.split(':')[0]
      const t = w._titleOfId?.get(fid)
      const v = outcome(t).votes
      if (v === 'null1') return i === 2 ? null : { refuted: false, reason: 'holds' }
      return { refuted: i >= v, reason: i >= v ? 'the test is wrong' : 'holds' }
    }
    const pass = w.fixOk !== false
    return Object.assign(instance(opts.schema, true), pass ? { verdict: 'pass', summary: 'ok', findings: [] } : { verdict: 'block', summary: 'no', findings: [{ severity: 'blocker', scope: 'change', issue: 'wrong', fix: 'fix' }] })
  }
  // Skeptic labels carry the finding id; map ids to titles from the prove labels as they appear.
  w._titleOfId = new Map()
  const agentWithIds = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (/:prove$/.test(label)) w._titleOfId.set(label.split(':')[0], (String(prompt).match(/"title": "([^"]+)"/) || [])[1])
    return agent(prompt, opts)
  }
  const workflow = async (name, a) => {
    wfArgs.push({ name, args: a })
    if (w.noClankerLoop) throw new Error('unknown workflow clanker-loop')
    if (name !== 'clanker-loop') throw new Error(`unexpected nested workflow ${name}`)
    return runBody(CL_SRC, { args: a, agent: agentWithIds, workflow: () => { throw new Error('nested too deep') } })
  }
  return { agent: agentWithIds, workflow, calls, wfArgs }
}

async function run(args, w = {}, mutate = null) {
  const world = makeWorld(w)
  const logs = []
  const out = await runBody(bodyFor(mutate), { args, agent: world.agent, workflow: world.workflow, log: (m) => logs.push(m) })
  return { out, calls: world.calls, wfArgs: world.wfArgs, logs }
}

const piCalls = (calls) => calls.filter((c) => c.agentType === PI)
const checksCalls = (calls) => calls.filter((c) => c.agentType === CHECKS)
const once = (list) => (r, l) => (r === 1 ? list : [])
const BASE = { base: 'origin/staging', lenses: ['drift'] }

const scenarios = []
scenarios.push(['S1 bad args rejected before any agent call', async () => {
  for (const [bad, sub] of [
    [{}, 'base is required'],
    [{ base: 'x; rm -rf /' }, 'base is required'],
    [{ base: 'a/../b' }, 'base is required'],
    [{ base: 'main', typo: 1 }, 'unknown arg(s) typo'],
    [{ base: 'main', maxRounds: 9 }, 'maxRounds must be an integer 1-5'],
    [{ base: 'main', maxFindings: 0 }, 'maxFindings must be an integer 1-20'],
    [{ base: 'main', redCmd: 'npm test' }, 'redCmd must be one line containing {files}'],
    [{ base: 'main', fix: 'yes' }, 'fix must be true or false'],
    [{ base: 'main', repo: 'relative/dir' }, 'repo must be an absolute path'],
    [{ base: 'main', lenses: [] }, 'lenses must not be empty'],
    [{ base: 'main', checks: ['a\nb'] }, 'checks must be an array'],
    [{ base: 'main', model: 'bad model!' }, 'model must be a model name'],
    [['x'], 'pass an object'],
  ]) {
    const world = makeWorld()
    let err = null
    try { await runBody(bodyFor(), { args: bad, agent: world.agent, workflow: world.workflow }); err = new Error('no throw') } catch (e) { err = e }
    ok(String(err.message).includes(sub), `${JSON.stringify(bad)}: message ${JSON.stringify(err.message)} lacks ${JSON.stringify(sub)}`)
    ok(!world.calls.length, `${JSON.stringify(bad)}: agent called ${world.calls.length}x before rejecting`)
  }
}])

scenarios.push(['S2 preflight fails: abort before any model', async () => {
  for (const w of [{ preflight: 'fail' }, { root: '/other' }]) {
    const { out, calls } = await run({ ...BASE, repo: ROOT }, { ...w, finds: once([sus('x')]) })
    eq(out.status, 'aborted', 'status')
    eq(calls.length, 1, 'only the preflight ran')
    eq(calls[0].agentType, CHECKS, 'the preflight is the checks runner')
    ok(/git rev-parse HEAD.*git rev-parse --verify origin\/staging\^\{commit\}/.test(calls[0].prompt), 'preflight compares HEAD with base')
  }
}])

scenarios.push(['S0 happy path: one bug found, proven, confirmed, fixed', async () => {
  const { out, calls, wfArgs } = await run({ ...BASE, checks: ['npm test'] }, { finds: once([sus('a() returns z for x', 'P1')]) })
  eq(out.status, 'done', 'status')
  eq(out.findings.length, 1, 'confirmed')
  const f = out.findings[0]
  eq(f.status, 'confirmed', 'finding status')
  eq(f.redCmd, 'npx vitest run e2e/a.test.mjs', 'red command built by the workflow')
  eq(f.fix.status, 'passed', 'fix status')
  eq(f.branch, 'redteam/a-returns-z-for-x', 'red branch')
  eq(wfArgs.length, 1, 'clanker-loop called once')
  const t = wfArgs[0].args.tasks[0]
  eq(t.checks.slice(1), ['npx vitest run e2e/a.test.mjs', 'npm test'], 'fix checks: red command then the repo checks')
  ok(t.checks[0].includes(`cp ${f.redDir}/e2e/a.test.mjs e2e/a.test.mjs`), 'fix checks restore the red test first')
  eq(piCalls(calls)[0].prompt.split('\n')[0], 'pi-model: example/open-model', 'the executor first')
  ok(calls.filter((c) => /:skeptic/.test(c.label)).every((c) => c.model === 'sonnet' && c.agentType === 'Plan'), 'skeptics are read-only Sonnet')
  eq(out.rounds.length, 2, 'a second round ran and found nothing new')
}])

scenarios.push(['S3 checks pass or unavailable is not proof', async () => {
  for (const red of ['pass', 'unavailable']) {
    const { out } = await run(BASE, { finds: once([sus('target bug')]), outcomes: { 'target bug': { red } } })
    eq(out.findings.length, 0, `${red}: confirmed`)
    eq(out.dropped[0].status, 'unproven', `${red}: dropped as`)
  }
}])
scenarios.push(['S17 a red command that ran no test is not proof', async () => {
  const { out } = await run(BASE, { finds: once([sus('target bug')]), outcomes: { 'target bug': { red: 'notests' } } })
  eq(out.dropped[0].status, 'unproven', 'dropped as')
  ok(/ran no test/.test(out.dropped[0].reason), 'reason names it')
}])
scenarios.push(['S4 prover could not prove it', async () => {
  const { out, calls } = await run(BASE, { finds: once([sus('target bug')]), outcomes: { 'target bug': { proof: 'notproven' } } })
  eq(out.dropped[0].status, 'no-test', 'dropped as')
  eq(checksCalls(calls).length, 1, 'no red checks run (only the preflight)')
}])
scenarios.push(['S5 flaky red test (fails once) is dropped', async () => {
  const { out, calls } = await run(BASE, { finds: once([sus('target bug')]), outcomes: { 'target bug': { red: 'fail1' } } })
  eq(out.dropped[0].status, 'unproven', 'dropped as')
  const red = checksCalls(calls)[1]
  eq([...red.prompt.matchAll(/^checks-run: /gm)].length, 2, 'the red command runs twice')
}])
scenarios.push(['S6 skeptics refute, and a dead skeptic counts as a refutation', async () => {
  for (const [votes, want] of [[1, 'refuted'], [0, 'refuted'], [2, 'confirmed'], ['null1', 'confirmed']]) {
    const { out } = await run({ ...BASE, fix: false }, { finds: once([sus('target bug')]), outcomes: { 'target bug': { votes } } })
    const f = [...out.findings, ...out.dropped][0]
    eq(f.status, want, `votes=${votes}`)
    if (votes === 'null1') eq(f.votes.filter((v) => v.refuted).length, 1, 'null vote counted as refuted')
  }
}])
scenarios.push(['S7 red team touched production code', async () => {
  for (const o of [{ proof: 'badpath' }, { extra: true }]) {
    const { out } = await run(BASE, { finds: once([sus('target bug')]), outcomes: { 'target bug': o } })
    eq(out.dropped[0].status, 'touched-code', JSON.stringify(o))
    eq(out.findings.length, 0, 'confirmed')
  }
}])
scenarios.push(['S8 no JSON from the prover', async () => {
  const { out } = await run(BASE, { finds: once([sus('target bug')]), outcomes: { 'target bug': { proof: 'nojson' } } })
  eq(out.dropped[0].status, 'no-test', 'dropped as')
}])
scenarios.push(['S9 a test path carrying a command never reaches the checks runner', async () => {
  const { out, calls } = await run(BASE, { finds: once([sus('target bug')]), outcomes: { 'target bug': { proof: 'injected' } } })
  eq(out.dropped[0].status, 'touched-code', 'dropped as')
  ok(!checksCalls(calls).some((c) => c.prompt.includes('curl')), 'no checks call carries the injected command')
}])
scenarios.push(['S10 dedup across lenses, rounds and known', async () => {
  const { out, calls } = await run({ base: 'main', lenses: ['drift', 'errors'], known: ['redteam: The known bug in a'], fix: false }, {
    finds: (r) => (r === 1 ? [sus('New bug in a'), sus('known bug in the a')] : [sus('new bug in a!'), sus('Second bug')]),
  })
  const tried = [...out.findings, ...out.dropped].map((f) => f.title)
  eq(tried, ['New bug in a', 'Second bug'], 'each distinct bug tried once')
  eq(out.rounds.map((r) => r.duplicates), [3, 3], 'duplicates per round')
  ok(calls.some((c) => /:find:/.test(c.label) && c.prompt.includes('New bug in a') && c.label.startsWith('r2')), 'round 2 finders are told what was already seen')
}])
scenarios.push(['S11 stops when a round confirms nothing new; never more than maxRounds', async () => {
  const always = (r) => [sus(`bug number ${['zero', 'one', 'two', 'three', 'four', 'five', 'six'][r]}`)]
  const a = await run({ ...BASE, maxRounds: 5, fix: false }, { finds: always })
  eq(a.out.rounds.length, 5, 'every round confirms: runs to maxRounds')
  const b = await run({ ...BASE, maxRounds: 5, fix: false }, { finds: always, outcomes: { 'bug number two': { red: 'pass' } } })
  eq(b.out.rounds.length, 2, 'round 2 confirms nothing: stop')
}])
scenarios.push(['S12 only confirmed findings go to the fix; nothing merges', async () => {
  const { out, wfArgs, calls } = await run(BASE, { finds: once([sus('good'), sus('bad', 'P0')]), outcomes: { bad: { votes: 1 } } })
  eq(wfArgs[0].args.tasks.map((t) => t.id), [`fix-${out.findings[0].id}`], 'fix tasks')
  ok(piCalls(calls).filter((c) => c.isolation === 'worktree' || /pi-workdir: \//.test(c.prompt)).every((c) => /Do not commit/.test(c.prompt)), 'every writing clanker is told not to commit')
  ok(!JSON.stringify(out).match(/"merged"|gh pr merge/), 'no merge in the result')
}])
scenarios.push(['S13 fix checks restore the red test before the red command', async () => {
  const { wfArgs, out } = await run(BASE, { finds: once([sus('target bug')]) })
  const [restore, red, ...rest] = wfArgs[0].args.tasks[0].checks
  ok(/^mkdir -p "\$\(dirname e2e\/a\.test\.mjs\)" && cp \/wt\/red-target-bug\/e2e\/a\.test\.mjs e2e\/a\.test\.mjs$/.test(restore), `restore command: ${restore}`)
  eq(red, out.findings[0].redCmd, 'red command second')
  eq(rest, [], 'no repo checks given')
}])
scenarios.push(['S14 executor down: the fallback runs, never first', async () => {
  const { out, calls } = await run({ ...BASE, fix: false }, { executorDown: true, finds: once([sus('target bug')]) })
  eq(out.findings.length, 1, 'still confirmed')
  ok(piCalls(calls).every((c, i, a) => !c.prompt.startsWith(`pi-model: ${FALLBACK}`) || (a[i - 1] && a[i - 1].prompt.startsWith('pi-model: example/open'))), 'every fallback call follows a failed executor call')
}])
scenarios.push(['S15 maxFindings caps loudly', async () => {
  const { out, logs } = await run({ ...BASE, maxFindings: 1, maxRounds: 1, fix: false }, { finds: once([sus('low', 'P2'), sus('high', 'P0')]) })
  eq(out.findings.map((f) => f.title), ['high'], 'highest severity tried first')
  eq(out.dropped.map((f) => [f.title, f.status]), [['low', 'capped']], 'capped returned')
  ok(logs.some((l) => /over maxFindings/.test(l)), 'cap logged')
}])
scenarios.push(['S16 clanker-loop missing: red findings stand', async () => {
  const { out } = await run(BASE, { noClankerLoop: true, finds: once([sus('target bug')]) })
  eq(out.fix, 'fix-unavailable', 'fix status')
  eq(out.findings[0].status, 'confirmed', 'finding kept')
  eq(out.findings[0].fix.status, 'fix-unavailable', 'per-finding fix status')
}])

scenarios.push(['S18 a blocked fix is not fixed; the clanker-loop result is carried through', async () => {
  const { out, logs } = await run({ ...BASE, maxRounds: 1 }, { fixOk: false, finds: once([sus('target bug')]) })
  const f = out.findings[0]
  eq(f.status, 'confirmed', 'the red finding stands')
  ok(f.fix.status && !/^passed/.test(f.fix.status), `fix status ${f.fix.status} is not passed`)
  ok(Array.isArray(f.fix.openFindings) && f.fix.openFindings.length > 0, 'open findings carried')
  ok(logs.some((l) => /1 confirmed, 0 dropped, 0 fixed/.test(l)), 'counted as not fixed')
  // Newer clanker-loop versions explain why patching stopped; the explanation must reach the result.
  if (/rethink:/.test(CL_RAW)) ok(typeof f.fix.rethink === 'string' && f.fix.rethink.length > 0, 'rethink carried')
}])

for (const [name, fn] of scenarios) {
  try { await fn(); pass(name) } catch (e) { fail(name, e.message) }
}

// ---- bounded exhaustive check over the real code ----
// Two suspicions in round 1, one new and one repeat in round 2; every outcome combination.
const PROOFS = ['ok', 'notproven', 'badpath', 'nojson']
const REDS = ['fail2', 'fail1', 'pass', 'unavailable', 'notests']
const VOTES = [0, 1, 2, 3, 'null1']
const OUTCOMES = []
for (const proof of PROOFS) for (const red of REDS) for (const extra of [false, true]) for (const votes of VOTES) {
  // Outcomes that never reach a later stage collapse to one representative.
  if (proof !== 'ok' && (red !== 'fail2' || extra || votes !== 3)) continue
  if (red !== 'fail2' && (extra || votes !== 3)) continue
  if (extra && votes !== 3) continue
  OUTCOMES.push({ proof, red, extra, votes })
}
const confirmedOutcome = (o) => !!o && o.proof === 'ok' && o.red === 'fail2' && !o.extra && (o.votes === 'null1' || o.votes >= 2)

function properties(o, out, calls, wfArgs, maxRounds) {
  const probs = []
  const all = [...out.findings, ...out.dropped]
  // P1 confirmed <=> proven twice by the checks runner and upheld by 2 of 3 skeptics.
  for (const f of all) {
    const want = confirmedOutcome(o[f.title.replace(/^the /, '')])
    if ((f.status === 'confirmed') !== want) probs.push(`P1 ${f.title} status ${f.status}, expected confirmed=${want}`)
  }
  for (const f of out.findings) {
    if (f.checks?.verdict !== 'fail') probs.push(`P1 ${f.title} confirmed without a failing check`)
    if ((f.votes || []).filter((v) => !v.refuted).length < 2) probs.push(`P1 ${f.title} confirmed with <2 votes`)
    // P2 a confirmed finding changed test files only.
    if (!f.files.length || f.files.some((x) => !TEST_PATH.test(x))) probs.push(`P2 ${f.title} non-test file ${f.files}`)
  }
  // P3 no suspicion is tried twice.
  const keys = all.filter((f) => f.status !== 'capped').map((f) => f.key)
  if (new Set(keys).size !== keys.length) probs.push(`P3 duplicate keys ${keys}`)
  // P4 rounds bounded; only the last round may confirm nothing.
  if (out.rounds.length > maxRounds) probs.push(`P4 ${out.rounds.length} rounds > ${maxRounds}`)
  out.rounds.slice(0, -1).forEach((r) => { if (!r.confirmed) probs.push(`P4 round ${r.round} confirmed nothing but the loop went on`) })
  // P5 no merge anywhere: no clanker is asked to commit, and nothing reports a merge.
  if (piCalls(calls).some((c) => (c.isolation === 'worktree' || /pi-workdir: \//.test(c.prompt)) && !/Do not commit/.test(c.prompt))) probs.push('P5 a writing clanker was not told not to commit')
  if (/merged|gh pr merge|git push/.test(JSON.stringify(out))) probs.push('P5 the result mentions a merge or push')
  // P6 the fix stage gets exactly the confirmed findings, each with the restore + red command first.
  const tasks = wfArgs[0]?.args.tasks || []
  const ids = tasks.map((t) => t.id).sort().join(',')
  const want = out.findings.map((f) => `fix-${f.id}`).sort().join(',')
  if (ids !== want) probs.push(`P6 fix tasks ${ids} != confirmed ${want}`)
  for (const t of tasks) if (!/ && cp \//.test(t.checks[0]) || !/^npx vitest run /.test(t.checks[1])) probs.push(`P6 ${t.id} checks ${t.checks.slice(0, 2)}`)
  return probs
}

async function bounded(mutate = null, limit = Infinity) {
  let runs = 0
  const violations = []
  const seenStatus = new Set()
  for (const oa of OUTCOMES) for (const ob of OUTCOMES) for (const oc of OUTCOMES.slice(0, 6)) {
    if (runs >= limit) break
    runs++
    const o = { 'first bug': oa, 'second bug': ob, 'third bug': oc }
    const finds = (r) => (r === 1 ? [sus('first bug'), sus('second bug', 'P0')] : r === 2 ? [sus('the first bug'), sus('third bug')] : [])
    let res
    try { res = await run({ ...BASE, maxRounds: 2 }, { finds, outcomes: o }, mutate) } catch (e) { violations.push(`threw: ${e.message}`); continue }
    for (const f of [...res.out.findings, ...res.out.dropped]) seenStatus.add(f.status)
    for (const f of res.out.findings) seenStatus.add('fix:' + f.fix?.status)
    const p = properties(o, res.out, res.calls, res.wfArgs, 2)
    if (p.length) violations.push(`${JSON.stringify(o)}: ${p.join('; ')}`)
  }
  return { runs, violations, seenStatus }
}

const b = await bounded()
// Non-vacuity: the enumeration reached every outcome the workflow can produce.
const wantStatus = ['confirmed', 'refuted', 'unproven', 'no-test', 'touched-code', 'fix:passed']
const missing = wantStatus.filter((x) => !b.seenStatus.has(x))
if (missing.length) fail('bounded non-vacuity', `never produced: ${missing}`)
else pass(`bounded non-vacuity: produced ${[...b.seenStatus].sort().join(', ')}`)
if (b.violations.length) fail(`bounded P1-P6 (${b.runs} runs)`, b.violations.slice(0, 3).join(' || '))
else pass(`bounded P1-P6 over ${b.runs} runs (${OUTCOMES.length} outcomes per suspicion, 3 suspicions, 2 rounds)`)

// ---- negative controls ----
const scen = (n) => scenarios.find(([name]) => name.startsWith(n + ' '))[1]
const controls = [
  ['confirm threshold dropped', 'const upheld = kept.filter((v) => !v.refuted).length', (s) => s.replace('const upheld = kept.filter((v) => !v.refuted).length', 'const upheld = 3'), 'S6'],
  ['red command run once', 'runs.length !== 2 || runs.some((x) => x.ok', (s) => s.replace('runs.length !== 2 || runs.some((x) => x.ok', 'runs.length !== 2 || runs.every((x) => x.ok'), 'S5'],
  ['extra changed files allowed', 'if (extra.length) return drop', (s) => s.replace('if (extra.length) return drop', 'if (false) return drop'), 'S7'],
  ['test-path check removed', '|| !TEST_PATH.test(x))', (s) => s.replace('|| !TEST_PATH.test(x))', ')'), 'S7'],
  ['checks verdict ignored', "if (c.verdict !== 'fail') return drop", (s) => s.replace("if (c.verdict !== 'fail') return drop", 'if (false) return drop'), 'S3'],
  ['dedup removed', 'if (!k || seen.has(k))', (s) => s.replace('if (!k || seen.has(k))', 'if (!k)'), 'S10'],
  ['no stop on a dry round', 'if (!newly.length) break', (s) => s.replace('if (!newly.length) break', ''), 'S11'],
  ['preflight bypassed', "if (pre.verdict !== 'pass' ||", (s) => s.replace("if (pre.verdict !== 'pass' ||", 'if (false &&'), 'S2'],
  ['red test not restored in the fix', '.join(\' && \'), f.redCmd', (s) => s.replace(".join(' && '), f.redCmd", ".join(' && ').replace(/cp \\S+ \\S+/g, 'true'), f.redCmd"), 'S13'],
  ['unconfirmed findings sent to the fix', "const newly = results.filter((r) => r.status === 'confirmed')", (s) => s.replace("const newly = results.filter((r) => r.status === 'confirmed')", "const newly = results.filter((r) => r.status !== 'prove-failed')"), 'S12'],
  ['no-test output accepted as a failure', "if (runs.some((x) => NO_TESTS.test(", (s) => s.replace("if (runs.some((x) => NO_TESTS.test(", 'if (false && runs.some((x) => NO_TESTS.test('), 'S17'],
  ['blocked fix counted as fixed', "const fixed = confirmed.filter((f) => /^passed/.test(f.fix?.status || '')).length", (s) => s.replace("const fixed = confirmed.filter((f) => /^passed/.test(f.fix?.status || '')).length", 'const fixed = confirmed.length'), 'S18'],
  ['clanker-loop result fields dropped', 'openFindings: r.openFindings, preExisting: r.preExisting, rethink: r.rethink }', (s) => s.replace('openFindings: r.openFindings, preExisting: r.preExisting, rethink: r.rethink }', '}'), 'S18'],
  ['path guard removed', "!SAFE_PATH.test(x) || x.includes('..') ||", (s) => s.replace("!SAFE_PATH.test(x) || x.includes('..') ||", ''), 'S9'],
]
for (const [name, target, mutate, sc] of controls) {
  const label = `negative-control ${name} (${sc})`
  if (!SRC.includes(target)) { fail(label, `mutation target missing: ${JSON.stringify(target)}`); continue }
  // Swap the body the scenario runs, then expect the scenario to fail.
  const saved = BODIES.get(null)
  BODIES.set(null, loadWorkflowBody(mutate(SRC)))
  let caught = false, why = ''
  try { await scen(sc)() } catch (e) { caught = true; why = e.message }
  BODIES.set(null, saved)
  if (caught) pass(`${label}: ${why.slice(0, 80)}`)
  else fail(label, 'the scenario still passed with the guard removed')
}
// The bounded check must also see the core mutations, without the scenarios' help.
for (const [name, target, mutate] of controls.filter(([n]) => ['confirm threshold dropped', 'dedup removed', 'no stop on a dry round', 'unconfirmed findings sent to the fix', 'extra changed files allowed'].includes(n))) {
  const r = await bounded(mutate, 400)
  if (r.violations.length) pass(`negative-control bounded sees: ${name} (${r.violations.length}/${r.runs} runs violate)`)
  else fail(`negative-control bounded sees: ${name}`, `no property violated in ${r.runs} runs`)
}

console.log(fails ? `${fails} FAIL` : 'ALL PASS')
if (REPORT_PATH) fs.writeFileSync(REPORT_PATH, JSON.stringify({ workflow: path.basename(WF_PATH), bounded: { runs: b.runs, outcomesPerSuspicion: OUTCOMES.length, violations: b.violations.length }, results }, null, 2))
process.exit(fails ? 1 : 0)
