#!/usr/bin/env node
// Scenario checks for research.js (run with its two wrappers): fake agent(), no model.
//   node harness/research.scenarios.mjs research.js
// Prints one PASS/FAIL per assertion, plus negative controls (mutated body must break
// the matching scenario). Exits 1 on any FAIL.
import fs from 'node:fs'
import path from 'node:path'
import { PI, piAnswer, instance, loadWorkflowBody, runBody } from '../lib/stubs.mjs'

const target = process.argv[2] || 'research.js'
const DIR = path.dirname(path.resolve(target))
const src = fs.readFileSync(path.resolve(target), 'utf8')
const gatherSrc = fs.readFileSync(path.join(DIR, 'gather-context.js'), 'utf8')
const parallelSrc = fs.readFileSync(path.join(DIR, 'parallel-research.js'), 'utf8')

const EXECUTOR = 'example/open-model'
const DEFAULT_ANGLES = ['External evidence', 'Local code context', 'Practical tradeoffs']

let fails = 0
const t = (name, ok, why) => {
  if (ok) console.log(`PASS ${name}`)
  else { fails++; console.log(`FAIL ${name}: ${why || 'assertion failed'}`) }
}
const report = (cs) => cs.forEach((c) => t(c.name, c.ok, c.why))

// Scripted agent(); mode 'fail' makes every call look broken.
function makeAgent(calls, mode) {
  return async (prompt, opts = {}) => {
    const p = String(prompt)
    const model = opts.agentType === PI ? (p.match(/^pi-model: (\S+)/)?.[1] || '?') : opts.model
    calls.push({ label: opts.label, agentType: opts.agentType, model, first: p.split('\n', 1)[0], prompt: p, schema: !!opts.schema })
    if (calls.length > 200) throw new Error('runaway: more than 200 agent calls')
    if (mode === 'fail') return opts.agentType === PI ? 'pi agent: upstream_unavailable (HTTP 502)' : null
    if (opts.agentType === PI) {
      const ask = p.match(/a JSON Schema\); nothing after it:\n(.*)$/m)
      const text = ask ? `Done.\n\`\`\`json\n${JSON.stringify(instance(JSON.parse(ask[1]), true))}\n\`\`\`` : 'Done.'
      return piAnswer(text, model, 'read-only')
    }
    return opts.schema ? instance(opts.schema, true) : 'Stub synthesis.'
  }
}

async function runOn(bodyText, args, mode = 'ok') {
  const calls = []
  const out = { calls }
  try { out.result = await runBody(bodyText, { args, agent: makeAgent(calls, mode) }) }
  catch (e) { out.error = e && e.message ? e.message : String(e) }
  return out
}
const run = (args, mode) => runOn(loadWorkflowBody(src), args, mode)

async function runWrapper(wrapSrc, args) {
  const wf = [], agentLabels = []
  const out = { wf, agentLabels }
  try {
    out.result = await runBody(loadWorkflowBody(wrapSrc), {
      args,
      agent: (p, o = {}) => { agentLabels.push(o.label); return null },
      workflow: async (name, a) => { wf.push({ name, args: a }); return { stub: true } },
    })
  } catch (e) { out.error = e && e.message ? e.message : String(e) }
  return out
}

const has = (calls, pred) => calls.some(pred)
const all = (calls, pred) => calls.every(pred)

// ---- scenario checks: each returns [{name, ok, why}] ----

function scAnswer(w) {
  const { calls, result: r, error } = w
  const web = calls.filter((c) => c.label === 'research:1')
  const clank = calls.filter((c) => c.label === 'research:2' || c.label === 'research:3')
  return [
    { name: 'answer: runs', ok: !error, why: error },
    { name: 'answer: one Claude sonnet web researcher', ok: web.length === 1 && web[0].agentType === 'Plan' && web[0].model === 'sonnet' && web[0].schema, why: JSON.stringify(web) },
    { name: 'answer: clanker angles on the executor', ok: clank.length === 2 && clank.every((c) => c.agentType === PI && c.first === `pi-model: ${EXECUTOR}`), why: JSON.stringify(clank) },
    { name: 'answer: no retries or Claude clanker fallbacks', ok: !has(calls, (c) => /:fallback|:claude/.test(c.label || '')), why: calls.map((c) => c.label).join(',') },
    { name: 'answer: sonnet synthesis returns the answer', ok: has(calls, (c) => c.label === 'synthesize' && c.model === 'sonnet' && !c.schema) && typeof r?.synthesis === 'string' && r.synthesis.length > 0, why: JSON.stringify(r && r.synthesis) },
    { name: 'answer: result shape', ok: r?.workflow === 'research' && r?.question === 'q' && JSON.stringify(r?.angles) === JSON.stringify(DEFAULT_ANGLES) && r?.results?.length === 3 && r.results.every((x) => !('_by' in x)) && JSON.stringify(r?.answeredBy) === JSON.stringify(['sonnet', EXECUTOR, EXECUTOR]) && !r?.error, why: JSON.stringify(r) },
  ]
}

function scSkipExternal(w) {
  const { calls, result: r, error } = w
  return [
    { name: 'skipExternal: runs', ok: !error, why: error },
    { name: 'skipExternal: clanker scout runs', ok: has(calls, (c) => c.label === 'scout' && c.agentType === PI && c.first === `pi-model: ${EXECUTOR}`), why: calls.map((c) => c.label).join(',') },
    { name: 'skipExternal: no sonnet web researcher call', ok: !has(calls, (c) => c.label === 'researcher'), why: calls.map((c) => `${c.label}/${c.model}`).join(',') },
    { name: 'skipExternal: clarify result shape', ok: r?.workflow === 'research' && r?.intent === 'x' && r?.gathered && 'scout' in r.gathered && !('researcher' in r.gathered) && !!r?.synthesis, why: JSON.stringify(r) },
  ]
}

function scCustomAngles(w) {
  const { calls, result: r, error } = w
  const rc = calls.filter((c) => (c.label || '').startsWith('research:'))
  return [
    { name: 'custom: runs', ok: !error, why: error },
    { name: 'custom: both angles on clankers only', ok: rc.length === 2 && rc.every((c) => c.agentType === PI && c.first === `pi-model: ${EXECUTOR}`), why: JSON.stringify(rc.map((c) => ({ l: c.label, m: c.model }))) },
    { name: 'custom: prompts mention the angles', ok: has(rc, (c) => c.prompt.includes('Your angle: a')) && has(rc, (c) => c.prompt.includes('Your angle: b')), why: rc.map((c) => c.prompt.slice(0, 120)).join(' || ') },
    { name: 'custom: result angles are a,b', ok: r?.angles?.join(',') === 'a,b' && r?.results?.length === 2 && typeof r?.synthesis === 'string', why: JSON.stringify(r) },
  ]
}

function scClarify(w) {
  const { calls, result: r, error } = w
  return [
    { name: 'clarify: runs', ok: !error, why: error },
    { name: 'clarify: scout (clanker) and researcher (sonnet) gather', ok: has(calls, (c) => c.label === 'scout' && c.agentType === PI) && has(calls, (c) => c.label === 'researcher' && c.agentType === 'Plan' && c.model === 'sonnet' && c.schema), why: calls.map((c) => c.label).join(',') },
    { name: 'clarify: sonnet synthesis answers', ok: has(calls, (c) => c.label === 'synthesize' && c.model === 'sonnet' && c.schema) && r?.synthesis && typeof r.synthesis === 'object', why: JSON.stringify(r && r.synthesis) },
    { name: 'clarify: result shape', ok: r?.workflow === 'research' && r?.intent === 'x' && r?.gathered && 'scout' in r.gathered && 'researcher' in r.gathered && !('_by' in r.gathered.scout) && (r?.nextStep || '').includes('AskUserQuestion'), why: JSON.stringify(r) },
  ]
}

function scFailAnswer(w) {
  const { calls, result: r, error } = w
  return [
    { name: 'fail-answer: no throw', ok: !error, why: error },
    { name: 'fail-answer: error result', ok: r?.workflow === 'research' && r?.error === 'every research agent failed', why: JSON.stringify(r) },
    { name: 'fail-answer: synthesis never runs', ok: !has(calls, (c) => c.label === 'synthesize'), why: calls.map((c) => c.label).join(',') },
  ]
}

function scFailClarify(w) {
  const { calls, result: r, error } = w
  return [
    { name: 'fail-clarify: no throw', ok: !error, why: error },
    { name: 'fail-clarify: error result', ok: r?.workflow === 'research' && r?.intent === 'x' && (r?.error || '').startsWith('every gatherer failed'), why: JSON.stringify(r) },
    { name: 'fail-clarify: synthesis never runs', ok: !has(calls, (c) => c.label === 'synthesize'), why: calls.map((c) => c.label).join(',') },
  ]
}

function scArgsEmpty(w) {
  return [
    { name: 'args{}: missing question error', ok: (w.error || '').includes('missing required "question"') && w.calls.length === 0, why: `error=${w.error} calls=${w.calls.length}` },
  ]
}
function scArgsMode(w) {
  return [
    { name: 'mode bogus: own error, no agent call', ok: (w.error || '').includes('mode must be "answer" or "clarify"') && w.calls.length === 0, why: `error=${w.error} calls=${w.calls.length}` },
  ]
}
function scArgsTypo(w) {
  return [
    { name: 'unknown arg: own error, no agent call', ok: (w.error || '').includes('unknown arg(s) typo') && w.calls.length === 0, why: `error=${w.error} calls=${w.calls.length}` },
  ]
}
function scArgsString(w) {
  return [
    { name: 'string arg: runs', ok: !w.error && w.calls.length > 0 && w.result?.question === 'q', why: `error=${w.error} calls=${w.calls.length}` },
  ]
}

function scGatherWrapper(w) {
  return [
    { name: 'gather-context: no throw', ok: !w.error, why: w.error },
    { name: 'gather-context: forwards mode clarify', ok: w.wf.length === 1 && w.wf[0].name === 'research' && w.wf[0].args?.mode === 'clarify' && w.wf[0].args?.intent === 'x', why: JSON.stringify(w.wf) },
    { name: 'gather-context: calls no agent itself', ok: w.agentLabels.length === 0, why: JSON.stringify(w.agentLabels) },
  ]
}
function scParallelWrapper(w) {
  return [
    { name: 'parallel-research: no throw', ok: !w.error, why: w.error },
    { name: 'parallel-research: forwards mode answer', ok: w.wf.length === 1 && w.wf[0].name === 'research' && w.wf[0].args?.mode === 'answer' && w.wf[0].args?.question === 'q' && JSON.stringify(w.wf[0].args?.angles) === JSON.stringify(['a']), why: JSON.stringify(w.wf) },
  ]
}
function scWrapperTypo(w, name) {
  return [
    { name: `${name}: rejects typo, workflow never called`, ok: (w.error || '').startsWith(`${name}: unknown arg(s) typo`) && w.wf.length === 0, why: `error=${w.error} wf=${JSON.stringify(w.wf)}` },
  ]
}

// ---- negative controls: mutated body must make the scenario FAIL ----

function mutated(base, from, to) {
  return base.includes(from) ? base.replace(from, to) : null
}
async function negativeControl(name, bodyText, checks) {
  if (bodyText === null) return void t(`negative-control ${name}`, false, 'mutation target missing')
  const cs = await checks(bodyText)
  t(`negative-control ${name}`, cs.some((c) => !c.ok), 'mutated body still passed every check')
}

// ---- main ----

report(scAnswer(await run({ question: 'q' })))
report(scSkipExternal(await run({ intent: 'x', mode: 'clarify', skipExternal: true })))
report(scCustomAngles(await run({ question: 'q', angles: ['a', 'b'] })))
report(scClarify(await run({ intent: 'x', mode: 'clarify' })))
report(scFailAnswer(await run({ question: 'q' }, 'fail')))
report(scFailClarify(await run({ intent: 'x', mode: 'clarify' }, 'fail')))
report(scArgsEmpty(await run({})))
report(scArgsMode(await run({ question: 'q', mode: 'bogus' })))
report(scArgsTypo(await run({ question: 'q', typo: 1 })))
report(scArgsString(await run('q')))

report(scGatherWrapper(await runWrapper(gatherSrc, { intent: 'x' })))
report(scParallelWrapper(await runWrapper(parallelSrc, { question: 'q', angles: ['a'] })))
report(scWrapperTypo(await runWrapper(gatherSrc, { typo: 1 }), 'gather-context'))
report(scWrapperTypo(await runWrapper(parallelSrc, { typo: 1 }), 'parallel-research'))

await negativeControl('skipExternal', mutated(src, 'if (!SKIP_EXTERNAL) gatherers.push({', 'if (true) gatherers.push({'),
  async (b) => scSkipExternal(await runOn(b, { intent: 'x', mode: 'clarify', skipExternal: true })))
await negativeControl('mode-check', mutated(src, "if (MODE !== 'answer' && MODE !== 'clarify') throw", "if (false) throw"),
  async (b) => scArgsMode(await runOn(b, { question: 'q', mode: 'bogus' })))
await negativeControl('unknown-arg-check', mutated(src, "if (unknown.length) throw new Error(NAME + ': unknown arg(s) '", "if (false) throw new Error(NAME + ': unknown arg(s) '"),
  async (b) => scArgsTypo(await runOn(b, { question: 'q', typo: 1 })))
await negativeControl('gather-context-mode', mutated(gatherSrc, "mode: 'clarify' })", "mode: 'answer' })"),
  async (b) => scGatherWrapper(await runWrapper(b, { intent: 'x' })))

console.log(fails ? `\n${fails} FAIL` : '\nALL PASS')
process.exit(fails ? 1 : 0)
