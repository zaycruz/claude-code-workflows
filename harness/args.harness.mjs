import fs from 'fs'
// Runs a workflow script with every agent failing, to exercise argument validation.
// Claude roles answer null; clanker (pi) and checks-runner calls answer text with no footer, which is
// how the kit defines a failed clanker / an unavailable checks runner. Every argument check throws
// before the workflow reaches an agent, so this only proves validation still runs first. agent(),
// parallel() and pipeline() must all exist: a missing stub throws on its own and would make every
// argument case look like a correct rejection.
// Usage: node args.harness.mjs [workflow.js] '<json args>'   (workflow path: argv or WF env)
const [fileArg, a] = process.argv.slice(2)
const WF = fileArg || process.env.WF || process.env.HOME + '/.claude/workflows/engineering-review-loop.js'
const body = fs.readFileSync(WF,'utf8').replace('export const meta','const meta')
globalThis.agent = async (p,o) => (o && (o.agentType === 'checks-runner:checks' || o.agentType === 'pi-agent-for-claude:pi'))
  ? 'the runner is unavailable and this answer has no footer' : null
globalThis.parallel = async(t)=>Promise.all(t.map(x=>x())); globalThis.pipeline = async(items, ...st) => Promise.all(items.map(async (it,i)=>{ let v=it; for (const s of st) { try { v = await s(v,it,i) } catch(e){ console.log('STAGE THROW',e.stack); return null } } return v })); globalThis.log=()=>{}; globalThis.phase=()=>{}
const fn = new (Object.getPrototypeOf(async function(){}).constructor)('args', body)
try { const r = await fn(JSON.parse(a)); console.log('OK   ', a.slice(0,50), '->', r.verdict || r.arbitration || r.error || r.status || Object.keys(r).slice(0,3).join(',')) } catch(e) { console.log('THROW', a.slice(0,50), '->', e.message.slice(0,90)) }
