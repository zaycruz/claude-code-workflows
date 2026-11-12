#!/usr/bin/env node
// Deterministic smoke test and policy lint for workflow scripts. No model runs.
//
//   node wf-smoke.mjs <workflow.js>...     (no args: every *.js workflow here)
//
// Each workflow runs against stub agent()/parallel()/pipeline() under several
// scenarios, once per backend (pi, then claude): happy (every agent answers), busy (structured
// answers carry one item per array for the first calls, so loops run), executordown (every worker
// call on the executor model fails: on pi the fallback runs, on claude the workflow must still
// return), checksfail (the checks step reports a failure). On pi every recorded agent() call is
// held to the routing policy:
//   - a pi call (pi-agent-for-claude:pi) starts with `pi-model:` and has a
//     `pi-workdir:` line or isolation 'worktree' - clankers are always confined;
//   - a checks call (checks-runner:checks) has a `checks-dir:` line;
//   - any other call is a Claude role: agentType Plan or Explore (read-only)
//     with an explicit model (sonnet, opus or haiku) - never the coordinator's
//     model by inheritance, never a Claude writer;
//   - a workflow that changes code (CONFIG.mustCheck) calls the checks runner.
// On claude: a clanker-worker call has the {report, workdir} schema, an explicit model and is
// confined (isolation 'worktree' or a `Work only inside /abs:` header); a clanker-reader call has a
// schema and an explicit model; a clanker-checks call runs on haiku with a schema; no call uses the
// pi or checks-runner agent types; any other call follows the Claude-role rule above.
// Also: the clanker kit block matches lib/clanker-kit.js byte for byte, and the
// script never calls Date.now() or Math.random() (they break workflow resume).
// A CONFIG entry may be { wrapper: 'other.js' }: the script just calls workflow(), so the nested
// workflow() stub below runs the real target and the wrapper exercises it. Wrapper entries skip the
// kit-block, mustCheck and clanker-use static checks (the target is checked under its own name).
// A wrapper entry may also set { mode, rejects }: we then check that every run forwards that mode to
// the target, that the wrapper returns an object, and that each value in rejects is rejected as
// unknown args.
// Writes wf-smoke-report.json and exits 1 on any failure.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PI, CHECKS, WORKER, READER, CHECKER, PI_BACKEND, CLAUDE_BACKEND, piAnswer, checksAnswer, instance, parallelStub, pipelineStub, loadWorkflowBody, runBody } from './lib/stubs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const KIT = fs.readFileSync(path.join(HERE, 'lib/clanker-kit.js'), 'utf8').trim()
const KIT_START = '// ---- clanker kit v3'
const KIT_END = '// ---- end clanker kit ----'
const MAX_CALLS = 400

const CONFIG = {
  'clanker-loop.js': { mustCheck: true, args: [{ tasks: [{ id: 't1', prompt: 'Add sub(a, b).' }] }, { tasks: 'Fix the bug.', checks: ['node test.js'], maxRounds: 2 }] },
  'engineering-review-loop.js': { mustCheck: true, args: [{}, { task: 'Add a --dry-run flag.' }, { focus: 'performance', strict: true, risky: true, maxRounds: 2 }] },
  'feature-pipeline.js': { mustCheck: true, args: [{ brief: 'Add a --dry-run flag.' }, { brief: 'Add SSO login.', risky: true, checks: ['npm test'], maxRounds: 2 }] },
  'artifact-review-loop.js': { args: [{ artifact: '# Plan\n\nWe will ship it on Friday.\n' }, { artifact: '# Spec\n\nThe API returns 200.\n', risky: true, maxRounds: 2 }] },
  'council.js': { args: [{ question: 'Should we adopt pnpm?' }, { question: 'Monorepo or not?', maxPasses: 3 }] },
  'red-blue-loop.js': { mustCheck: true, args: [{ base: 'origin/staging' }, { base: 'origin/main', lenses: ['drift', 'Check the CSV parser.'], maxRounds: 3, maxFindings: 2, checks: ['npm test'], targets: [65, 'src/a.ts'], known: ['redteam: stub'] }, { base: 'HEAD', fix: false }] },
  'research.js': { args: [{ question: 'Which queue to use?' }, { question: 'Which queue?', angles: ['cost', 'ops'] }, { intent: 'Add SSO login.', mode: 'clarify' }, { intent: 'Add SSO login.', mode: 'clarify', skipExternal: true }] },
  'gather-context.js': { wrapper: 'research.js', mode: 'clarify', rejects: [{ bogus: 1 }, [1]], args: [{ intent: 'Add SSO login.' }, { intent: 'Add SSO login.', skipExternal: true }] },
  'parallel-research.js': { wrapper: 'research.js', mode: 'answer', rejects: [{ bogus: 1 }, [1]], args: [{ question: 'Which queue to use?' }, { question: 'Which queue?', angles: ['cost', 'ops'] }] },
}
const SCENARIOS = ['happy', 'busy', 'executordown', 'checksfail']
const BACKENDS = { pi: PI_BACKEND, claude: CLAUDE_BACKEND }
const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku']

// The checks-runner answer for the smoke scenarios, in the shared footer format.
const checksAnswerLocal = (fail) => {
  const rep = {
    dir: '/tmp/wf-smoke-repo', head: 'abc1234', changed: [{ status: 'M', path: 'src/a.js' }], diffStat: '1 file changed', commands: 'detected', setup: [],
    checks: [{ kind: 'check', cmd: 'npm run test', ok: !fail, exit: fail ? 1 : 0, seconds: 1, failures: fail ? ['FAIL src/a.test.js'] : [], tail: fail ? 'FAIL src/a.test.js' : 'ok' }],
    verdict: fail ? 'fail' : 'pass', seconds: 1,
  }
  return checksAnswer(rep, `CHECKS ${fail ? 'FAIL - 0/1' : 'PASS - 1/1'} passed, 1 changed file(s), 1s`)
}
// The clanker-checks answer: the structured report itself.
const checksReportLocal = (fail) => ({
  dir: '/tmp/wf-smoke-repo', head: 'abc1234', changed: [{ status: 'M', path: 'src/a.js' }], setup: [],
  checks: [{ kind: 'test', cmd: 'npm run test', ok: !fail, exit: fail ? 1 : 0, seconds: 1, failures: fail ? ['FAIL src/a.test.js'] : [], tail: fail ? 'FAIL src/a.test.js' : 'ok' }],
  verdict: fail ? 'fail' : 'pass',
})
// The claude backend's stub answers and policy; null when the call is not a claude-backend agent type.
function claudeAnswer(p, opts, scenario, fill, problems) {
  const t = opts.agentType
  if (t === PI || t === CHECKS) { problems.push(`${opts.label}: the claude backend called ${t}`); return undefined }
  if (![WORKER, READER, CHECKER].includes(t)) return undefined
  if (!opts.schema) problems.push(`${opts.label}: ${t} call without a schema`)
  if (t === CHECKER) {
    if (opts.model !== 'haiku') problems.push(`${opts.label}: checks agent not on haiku`)
    return checksReportLocal(scenario === 'checksfail')
  }
  if (!CLAUDE_MODELS.includes(opts.model)) problems.push(`${opts.label}: ${t} call without an explicit Claude model (got ${JSON.stringify(opts.model)})`)
  if (scenario === 'executordown' && opts.model === CLAUDE_BACKEND.executor) return null
  if (t === READER) return instance(opts.schema, fill)
  const where = p.match(/^Work only inside (\/[^:\n]+):/m)?.[1]
  if (!where && opts.isolation !== 'worktree') problems.push(`${opts.label}: worker neither confined to a directory nor in a worktree`)
  if (!opts.schema?.properties?.workdir) problems.push(`${opts.label}: worker schema has no workdir`)
  return { report: 'Done. Files changed: src/a.js. Ran: npm test (ok).', workdir: where || '/tmp/worktrees/repo/wf_smoke-1' }
}

async function runOnce(file, src, args, scenario, shared = {}, backend = 'pi') {
  const calls = shared.calls || []
  const problems = shared.problems || []
  const depth = shared.depth || 0
  const agent = async (prompt, opts = {}) => {
    if (calls.length >= MAX_CALLS) throw new Error(`more than ${MAX_CALLS} agent calls (runaway loop?)`)
    const p = String(prompt)
    const call = { label: opts.label, agentType: opts.agentType, model: opts.model, isolation: opts.isolation, schema: !!opts.schema, head: p.split('\n').slice(0, 3).join(' | ').slice(0, 160) }
    calls.push(call)
    const fill = scenario === 'busy' && calls.length <= 12
    if (backend === 'claude') {
      const a = claudeAnswer(p, opts, scenario, fill, problems)
      if (a !== undefined) return a
      if (opts.agentType === PI || opts.agentType === CHECKS) return null
    }
    const where = opts.agentType === PI ? p.match(/^pi-workdir: (.*)$/m)?.[1] : undefined
    if (opts.agentType === PI) {
      if (!/^pi-model: \S+/.test(p)) problems.push(`${opts.label}: pi call without a first-line pi-model:`)
      if (!where && opts.isolation !== 'worktree') problems.push(`${opts.label}: pi call neither confined by pi-workdir: nor in a worktree`)
      const model = p.match(/^pi-model: (\S+)/)?.[1] || '?'
      if (scenario === 'executordown' && model.startsWith('example/open')) return 'pi agent: upstream_unavailable (HTTP 502)'
      const ask = p.match(/a JSON Schema\); nothing after it:\n(.*)$/m)
      const body = ask ? `Done.\n\`\`\`json\n${JSON.stringify(instance(JSON.parse(ask[1]), fill))}\n\`\`\`` : 'Done. Files changed: src/a.js. Ran: npm test (ok).'
      return piAnswer(body, model, where === 'readonly' ? 'read-only' : `sandbox: ${where || '/tmp/worktrees/repo/wf_smoke-1'}`)
    }
    if (opts.agentType === CHECKS) {
      if (!/^checks-dir: \S/m.test(p)) problems.push(`${opts.label}: checks call without checks-dir:`)
      return checksAnswerLocal(scenario === 'checksfail')
    }
    if (!['Plan', 'Explore'].includes(opts.agentType)) problems.push(`${opts.label}: Claude role with agentType ${JSON.stringify(opts.agentType)} (must be Plan or Explore: Claude reviews, clankers write)`)
    if (!['sonnet', 'opus', 'haiku'].includes(opts.model)) problems.push(`${opts.label}: Claude role without an explicit model (got ${JSON.stringify(opts.model)}); it would inherit the coordinator's`)
    return opts.schema ? instance(opts.schema, fill) : 'Stub memo.\n\n## Recommendation\nShip it.'
  }
  // One level deep, as the real harness: run the named workflow with the same stubs, sharing the
  // recorded calls and policy problems, so a wrapper is smoke-tested through its target.
  const workflow = async (nameOrRef, a) => {
    if (depth >= 1) throw new Error(`${file}: workflow() nested more than one level deep`)
    if (shared.wfArgs) shared.wfArgs.push(a)
    const target = String(nameOrRef).replace(/\.js$/, '') + '.js'
    const sub = await runOnce(target, fs.readFileSync(path.join(HERE, target), 'utf8'), a, scenario, { calls, problems, depth: depth + 1 }, backend)
    if (sub.error) throw new Error(`${target}: ${sub.error}`)
    return sub.result
  }
  let result, error
  try {
    result = await runBody(loadWorkflowBody(src, BACKENDS[backend]), { args: structuredClone(args), agent, parallel: parallelStub, pipeline: pipelineStub, workflow })
  } catch (e) {
    error = String(e && e.stack || e).split('\n').slice(0, 3).join(' / ')
  }
  const worker = (c) => [PI, WORKER, READER].includes(c.agentType)
  const checker = (c) => [CHECKS, CHECKER].includes(c.agentType)
  return { backend, scenario, args, result, calls: calls.length, problems: [...new Set(problems)], error, returned: result !== undefined && result !== null, wfArgs: shared.wfArgs, checksCalls: calls.filter(checker).length, workerCalls: calls.filter(worker).length, claudeCalls: calls.filter((c) => !worker(c) && !checker(c)).map((c) => `${c.label}:${c.model}`) }
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CONFIG)
const report = []
let failed = false
for (const f of files) {
  const name = path.basename(f)
  const cfg = CONFIG[name]
  const src = fs.readFileSync(path.resolve(f), 'utf8')
  const static_ = []
  if (!cfg) static_.push('no smoke CONFIG entry for this workflow')
  if (/\bDate\.now\s*\(|\bMath\.random\s*\(/.test(src)) static_.push('calls Date.now() or Math.random()')
  if (!cfg?.wrapper) {
    const a = src.indexOf(KIT_START), b = src.indexOf(KIT_END)
    if (a < 0 || b < 0) static_.push('clanker kit block missing')
    else if (src.slice(a, b + KIT_END.length).trim() !== KIT) static_.push('clanker kit block differs from lib/clanker-kit.js')
  }
  const runs = []
  for (const backend of Object.keys(BACKENDS)) {
    for (const args of cfg?.args || []) {
      for (const sc of SCENARIOS) {
        runs.push(await runOnce(name, src, args, sc, cfg?.wrapper ? { wfArgs: [] } : {}, backend))
      }
    }
  }
  if (cfg?.wrapper) {
    const wrapErr = new Set()
    for (const r of runs) {
      if (r.error) continue
      if (r.wfArgs?.length !== 1 || r.wfArgs[0]?.mode !== cfg.mode) wrapErr.add(`wrapper did not call research with mode ${cfg.mode}`)
      if (typeof r.result !== 'object' || r.result === null || Array.isArray(r.result)) wrapErr.add('wrapper returned a non-object')
    }
    // The wrapper itself must reject: research is never called, and the error is the wrapper's own
    // (research also rejects unknown keys, so matching /unknown arg/ alone would pass a forwarding wrapper).
    const own = new RegExp('^Error: ' + name.replace(/\.js$/, '') + ': unknown arg')
    for (const bad of cfg.rejects || []) {
      const r = await runOnce(name, src, bad, 'happy', { wfArgs: [] })
      if (!r.error || r.wfArgs.length !== 0 || !own.test(r.error)) wrapErr.add(`wrapper accepted bad args ${JSON.stringify(bad)}`)
    }
    static_.push(...wrapErr)
  }
  const happy = runs.filter((r) => r.scenario === 'happy')
  if (cfg?.mustCheck && !cfg?.wrapper && happy.some((r) => !r.error && r.checksCalls === 0)) static_.push('changes code but a happy run never called the checks runner')
  // Execution goes to clankers, but a run with nothing to execute (no blockers, nothing to rewrite) may
  // legitimately use none; the workflow must still route work to a clanker in some scenario.
  for (const b of Object.keys(BACKENDS)) {
    const mine = runs.filter((r) => r.backend === b)
    if (!cfg?.wrapper && mine.length && mine.every((r) => r.error || r.workerCalls === 0)) static_.push(`no ${b} run used a clanker (every role a Claude reviewer)`)
  }
  const bad = runs.filter((r) => r.error || r.problems.length || !r.returned)
  const ok = !static_.length && !bad.length
  failed ||= !ok
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${runs.length} runs${static_.length ? '; ' + static_.join('; ') : ''}`)
  for (const r of bad) console.log(`  - ${r.backend} ${r.scenario} ${JSON.stringify(r.args).slice(0, 60)}: ${r.error || ''}${r.problems.length ? ' ' + r.problems.slice(0, 4).join('; ') : ''}${!r.error && !r.returned ? ' returned nothing' : ''}`)
  report.push({ workflow: name, ok, static: static_, runs: runs.map(({ result, ...r }) => r) })
}
fs.writeFileSync(path.join(HERE, 'wf-smoke-report.json'), JSON.stringify(report, null, 2))
process.exit(failed ? 1 : 0)
