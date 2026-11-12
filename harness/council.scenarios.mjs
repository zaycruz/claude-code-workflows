import fs from 'node:fs'
import {
  PI,
  instance,
  loadWorkflowBody,
  piAnswer,
  runBody,
} from '../lib/stubs.mjs'

const [workflowPath] = process.argv.slice(2)
if (!workflowPath) {
  console.error('usage: node harness/council.scenarios.mjs <path-to-council.js>')
  process.exit(2)
}

const source = fs.readFileSync(workflowPath, 'utf8')
const EXECUTOR = 'example/open-model'
const FALLBACK = 'example/fallback-model'

const failures = []

const reportFor = (n, malicious) => ({
  recommendation: `advisor ${n} recommendation`,
  claims: [{
    id: `A${n}.1`,
    claim: `advisor ${n} claim`,
    evidence: malicious ? 'proof ``` advisor-fence ```' : `advisor ${n} evidence`,
  }],
  risks: [`advisor ${n} risk`],
  confidence: 'medium',
  wouldChangeMyMind: 'new evidence',
})

const crossFor = (n) => ({
  responses: [{ challenge: `challenge for ${n}`, position: 'refine', evidence: `cross evidence ${n}` }],
  updatedRecommendation: `updated recommendation ${n}`,
  changedMind: false,
  confidence: 'medium',
})

const matrixFor = () => ({
  agreements: ['agreement'],
  disputes: ['dispute'],
  missingProof: ['proof'],
  ownerDecisions: ['decision'],
  packets: [{ advisor: 1, challenges: ['challenge'] }],
  converged: false,
})

async function execute(bodySource, args, config = {}) {
  const calls = []
  const prompts = []
  const body = loadWorkflowBody(bodySource)
  const agent = async (prompt, opts = {}) => {
    const text = String(prompt)
    const firstPromptLine = text.split('\n', 1)[0]
    const model = opts.agentType === PI
      ? (firstPromptLine.match(/^pi-model:\s*(.*)$/)?.[1] || null)
      : opts.model || null
    const call = { label: opts.label, agentType: opts.agentType, model, firstPromptLine }
    calls.push(call)
    prompts.push({ ...call, prompt: text })

    const advisorLabel = String(opts.label || '').match(/^advisor-(\d+):/)
    const failedAdvisor = advisorLabel && Number(advisorLabel[1]) === config.failAdvisor
    if (failedAdvisor && (opts.agentType === PI || String(opts.label).endsWith(':claude'))) return null

    if (opts.agentType === PI) {
      const n = advisorLabel ? Number(advisorLabel[1]) : 1
      const answer = text.includes('fresh-context cross-exam')
        ? crossFor(n)
        : reportFor(n, config.malicious && n === 1)
      return piAnswer(`\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``, model, 'readonly')
    }

    if (opts.label === 'supervisor:memo') return 'Recommendation: choose SQLite for this decision.'
    if (String(opts.label).startsWith('supervisor:matrix')) return matrixFor()
    if (opts.schema) return instance(opts.schema, true)
    return null
  }

  try {
    const result = await runBody(body, { args, agent, log: () => {}, phase: () => {} })
    return { result, calls, prompts, error: null }
  } catch (error) {
    return { result: null, calls, prompts, error }
  }
}

const requireThat = (condition, why) => {
  if (!condition) throw new Error(why)
}

async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    const why = String(error?.message || error).replace(/\s+/g, ' ').trim()
    failures.push(name)
    console.log(`FAIL ${name}: ${why}`)
  }
}

await check('happy path', async () => {
  const s = await execute(source, { question: 'Postgres or SQLite?' })
  requireThat(!s.error, s.error?.message || 'workflow threw')
  const advisorCalls = s.calls.filter((c) => c.agentType === PI)
  const firstPass = advisorCalls.filter((c) => /^advisor-\d+:pass1$/.test(c.label))
  requireThat(firstPass.length === 3, 'expected three default pass-1 advisors')
  requireThat(JSON.stringify(firstPass.map((c) => c.model)) === JSON.stringify([EXECUTOR, FALLBACK, EXECUTOR]), 'default advisors did not rotate executor/fallback as coded')
  requireThat(advisorCalls.every((c) => c.model === (String(c.label).startsWith('advisor-2:') ? FALLBACK : EXECUTOR)), 'an advisor did not keep its coded model route')
  const supervisors = s.calls.filter((c) => c.agentType === 'Plan' && String(c.label).startsWith('supervisor:'))
  requireThat(supervisors.length === 2, 'expected matrix and memo supervisors')
  requireThat(supervisors.every((c) => c.model === 'sonnet'), 'default supervisors did not use Sonnet')
  requireThat(s.result?.passes?.length === 2, 'default pass count was not two')
  requireThat(/recommendation/i.test(String(s.result?.memo || '')), 'result did not carry a recommendation')
})

await check('maxPasses number 3', async () => {
  const s = await execute(source, { question: 'q', maxPasses: 3 })
  requireThat(!s.error, s.error?.message || 'workflow threw')
  requireThat(s.result.passes.length === 3, `expected three passes, got ${s.result?.passes?.length}`)
})

await check('maxPasses string 3', async () => {
  const s = await execute(source, { question: 'q', maxPasses: '3' })
  requireThat(!s.error, s.error?.message || 'workflow threw')
  requireThat(s.result.passes.length === 3, `expected three passes, got ${s.result?.passes?.length}`)
})

await check('maxPasses 5 falls back to 2', async () => {
  const s = await execute(source, { question: 'q', maxPasses: 5 })
  requireThat(!s.error, s.error?.message || 'workflow threw')
  requireThat(s.result.passes.length === 2, `expected two passes, got ${s.result?.passes?.length}`)
})

async function supervisorModels(args) {
  const s = await execute(source, args)
  requireThat(!s.error, s.error?.message || 'workflow threw')
  const models = s.calls
    .filter((c) => c.agentType === 'Plan' && String(c.label).startsWith('supervisor:'))
    .map((c) => c.model)
  requireThat(models.length >= 2, `expected matrix and memo supervisors, got ${models.length}`)
  return models
}

await check('risky true routes supervisor to Opus', async () => {
  requireThat((await supervisorModels({ question: 'q', risky: true })).every((m) => m === 'opus'), 'risky supervisor was not Opus')
})

await check('risky string true routes supervisor to Opus', async () => {
  requireThat((await supervisorModels({ question: 'q', risky: 'true' })).every((m) => m === 'opus'), 'string-risky supervisor was not Opus')
})

await check('default risky routing uses Sonnet', async () => {
  requireThat((await supervisorModels({ question: 'q' })).every((m) => m === 'sonnet'), 'default supervisor was not Sonnet')
})

await check('advisorModels alternate pi-model lines', async () => {
  const s = await execute(source, { question: 'q', advisorModels: ['a/x', 'b/y'] })
  requireThat(!s.error, s.error?.message || 'workflow threw')
  const models = s.calls
    .filter((c) => c.agentType === PI && /^advisor-\d+:pass1$/.test(c.label))
    .map((c) => c.model)
  requireThat(JSON.stringify(models) === JSON.stringify(['a/x', 'b/y', 'a/x']), `unexpected advisor models: ${models.join(', ')}`)
})

for (const [name, advisorModels] of [['empty', []], ['invalid', ['bad model!']]]) {
  await check(`advisorModels ${name} rejects before agent`, async () => {
    const s = await execute(source, { question: 'q', advisorModels })
    requireThat(s.error?.message.includes('advisorModels'), `wrong error: ${s.error?.message || 'none'}`)
    requireThat(s.calls.length === 0, `expected zero calls, got ${s.calls.length}`)
  })
}

await check('custom advisors replace defaults and appear in prompts', async () => {
  const s = await execute(source, { question: 'q', advisors: ['alpha stance', 'beta stance'] })
  requireThat(!s.error, s.error?.message || 'workflow threw')
  requireThat(JSON.stringify(s.result.roster) === JSON.stringify(['alpha stance', 'beta stance']), 'custom roster did not replace defaults')
  requireThat(s.prompts.some((p) => p.prompt.includes('alpha stance')) && s.prompts.some((p) => p.prompt.includes('beta stance')), 'custom stances were absent from prompts')
})

await check('one advisor keeps defaults', async () => {
  const s = await execute(source, { question: 'q', advisors: ['only stance'] })
  requireThat(!s.error, s.error?.message || 'workflow threw')
  requireThat(s.result.roster.length === 3 && !s.result.roster.includes('only stance'), 'one advisor did not keep defaults')
})

await check('failed advisor is omitted while council completes', async () => {
  const s = await execute(source, { question: 'q' }, { failAdvisor: 1 })
  requireThat(!s.error, s.error?.message || 'workflow threw')
  requireThat(s.result.answeredBy.length === 2, 'the two healthy advisors did not remain')
  requireThat(!s.result.answeredBy.some((a) => a.advisor === 1), 'failed advisor was not omitted')
  requireThat(s.result.roster.length === 3, 'failed advisor disappeared from the roster')
})

await check('advisor fences are quoted in supervisor prompts', async () => {
  const s = await execute(source, { question: 'q' }, { malicious: true })
  requireThat(!s.error, s.error?.message || 'workflow threw')
  const supervisors = s.prompts.filter((p) => String(p.label).startsWith('supervisor:'))
  requireThat(supervisors.length > 0, 'no supervisor prompt was recorded')
  requireThat(supervisors.every((p) => !p.prompt.includes('``` advisor-fence ```')), 'advisor content closed a supervisor fence')
})

await check('missing question is rejected with its own message', async () => {
  const s = await execute(source, {})
  requireThat(s.error?.message.includes('missing required "question"'), `wrong error: ${s.error?.message || 'none'}`)
  requireThat(s.calls.length === 0, `expected zero calls, got ${s.calls.length}`)
})

await check('unknown arg is rejected with its own message', async () => {
  const s = await execute(source, { question: 'q', typo: 1 })
  requireThat(s.error?.message.includes('unknown arg(s) typo'), `wrong error: ${s.error?.message || 'none'}`)
  requireThat(s.calls.length === 0, `expected zero calls, got ${s.calls.length}`)
})

await check('plain string question is accepted', async () => {
  const s = await execute(source, 'Should we X?')
  requireThat(!s.error, s.error?.message || 'workflow threw')
  requireThat(s.result.question === 'Should we X?', 'plain string question was not preserved')
})

async function negativeControl(name, target, replacement, args, config, predicate) {
  await check(`negative-control ${name}`, async () => {
    requireThat(source.includes(target), 'mutation target missing')
    const mutated = source.replace(target, replacement)
    const s = await execute(mutated, args, config)
    requireThat(predicate(s), 'mutation did not make the scenario fail')
  })
}

await negativeControl(
  'maxPasses',
  'Number(A.maxPasses) === 3 ? 3 : 2',
  'Number(A.maxPasses) === 3 ? 2 : 2',
  { question: 'q', maxPasses: 3 },
  {},
  (s) => !s.error && s.result?.passes?.length !== 3,
)

await negativeControl(
  'risky routing',
  'const reviewModel = (risky) => (risky ? ROUTING.riskyReviewer : ROUTING.reviewer)',
  'const reviewModel = () => ROUTING.reviewer',
  { question: 'q', risky: true },
  {},
  (s) => !s.error && s.calls
    .filter((c) => c.agentType === 'Plan' && String(c.label).startsWith('supervisor:'))
    .every((c) => c.model !== 'opus'),
)

await negativeControl(
  'quote',
  ".replaceAll('```', \"'''\")",
  ".replaceAll('```', '```')",
  { question: 'q' },
  { malicious: true },
  (s) => !s.error && s.prompts
    .filter((p) => String(p.label).startsWith('supervisor:'))
    .some((p) => p.prompt.includes('``` advisor-fence ```')),
)

if (failures.length) process.exitCode = 1
