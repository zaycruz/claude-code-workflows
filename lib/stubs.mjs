// Shared stub layer for the two tools that run workflow bodies without a model:
// wf-smoke.mjs and harness/engineering-review-loop.harness.mjs.
import { withBackend } from './workers-config.mjs'

export const PI = 'pi-agent-for-claude:pi'
export const CHECKS = 'checks-runner:checks'
// The claude backend's agent types (install.sh installs them).
export const WORKER = 'clanker-worker'
export const READER = 'clanker-reader'
export const CHECKER = 'clanker-checks'

// A clanker answer: text plus the pi footer naming the model and where it ran.
export const piAnswer = (text, model, where) => `${text}\n\n— answered by pi [${where}], ${model}`

// A checks-runner answer: headline, the report as JSON, then the deterministic checks footer.
export const checksAnswer = (report, headline) =>
  `${headline}\n${JSON.stringify(report, null, 2)}\n\n— answered by checks [sandbox: ${report.dir}], deterministic`

// A minimal instance of a JSON Schema; `fill` puts one item in each array.
export function instance(s, fill, depth = 0) {
  if (!s || typeof s !== 'object' || depth > 6) return null
  if (Array.isArray(s.enum)) return s.enum[0]
  const t = Array.isArray(s.type) ? s.type[0] : s.type
  if (t === 'object' || s.properties) {
    const o = {}
    for (const [k, v] of Object.entries(s.properties || {})) o[k] = instance(v, fill, depth + 1)
    return o
  }
  if (t === 'array') return fill ? [instance(s.items || { type: 'string' }, fill, depth + 1)] : []
  if (t === 'string') return 'stub'
  if (t === 'integer' || t === 'number') return 1
  if (t === 'boolean') return false
  return null
}

// parallel(): run every thunk, turning a rejected one into null.
export const parallelStub = async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))

// pipeline(): run every item through the stages, null for an item whose stage throws.
export const pipelineStub = async (items, ...stages) => Promise.all(items.map(async (item, i) => {
  let v = item
  try { for (const s of stages) v = await s(v, item, i) } catch { return null }
  return v
}))

// The kit's one backend line, and the pi config the pi-path harnesses run under. Model names are
// fixtures: the repo names no real open model.
export const PI_BACKEND = { backend: 'pi', executor: 'example/open-model', fallback: 'example/fallback-model', checks: 'runner' }
export const CLAUDE_BACKEND = { backend: 'claude', executor: 'sonnet', fallback: 'opus', checks: 'claude' }
export { WORKERS_LINE, withBackend } from './workers-config.mjs'

// The workflow script as an async function body: its exported meta becomes a local. The harnesses
// written for the pi path get PI_BACKEND by default; pass null to keep the source's own line.
export const loadWorkflowBody = (src, cfg = PI_BACKEND) => (cfg ? withBackend(src, cfg) : src).replace(/^export const meta\s*=/m, 'const meta =')

// Run a workflow body with faked globals; anything not given falls back to a permissive stub.
export async function runBody(body, { args, agent, parallel = parallelStub, pipeline = pipelineStub, log = () => {}, phase = () => {}, budget = { total: null, spent: () => 0, remaining: () => Infinity }, workflow = () => { throw new Error('workflow() not stubbed') } } = {}) {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  return new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', 'workflow', body)(
    args, agent, parallel, pipeline, log, phase, budget, workflow)
}
