// Bounded property check for review convergence in clanker-loop.js.
// Runs the real workflow body against SEEDS randomly generated reviewer and checks-runner behaviours
// (no model) and asserts, for every run, the properties the reviewer must not be able to override:
//   P1 a finding in scope pre-existing never reaches an executor prompt and never blocks a round
//   P2 once a finding is closed (resolved or withdrawn), no later executor prompt carries it again
//   P3 the loop is bounded: rounds <= maxRounds + 1, at most one escalation, one rethink
//   P4 fail closed: an open finding the reviewer did not verify keeps the round blocked
//   P5 progress: every blocked round below the cap is followed by an executor prompt naming every open blocker id
// Usage: node harness/convergence.props.mjs [clanker-loop.js] [seeds=500]   exit 1 on the first counterexample.
import fs from 'fs'
import { runBody, loadWorkflowBody, piAnswer, checksAnswer, PI, CHECKS } from '../lib/stubs.mjs'

const WF_PATH = process.argv[2] || 'clanker-loop.js'
const SEEDS = Number(process.argv[3] || 500)
// --mutants: also run each broken variant below and require that its named property fails (the check can fail).
const MUTANTS = process.argv.includes('--mutants')
const SRC = fs.readFileSync(WF_PATH, 'utf8')
let BODY = loadWorkflowBody(SRC)
const DIR = '/tmp/wt-props'
const FALLBACK = 'example/fallback-model'

// mulberry32: a seeded generator so every counterexample replays from its seed.
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const pick = (r, xs) => xs[Math.floor(r() * xs.length)]
const chance = (r, p) => r() < p

// A run's world: K defect templates with unique issue tokens; a fixed subset is pre-existing for the whole run.
function world(seed) {
  const r = rng(seed)
  const K = 2 + Math.floor(r() * 4)
  const templates = Array.from({ length: K }, (_, k) => ({ k, file: `src/f${k % 3}.js:${10 + k}`, issue: `ISSUE-${seed}-${k} wrong result class ${k}`, pre: chance(r, 0.35) }))
  const maxRounds = 1 + Math.floor(r() * 5)
  return { r, templates, maxRounds, seed }
}

async function runOne(seed) {
  const W = world(seed)
  const { r, templates, maxRounds } = W
  const execPrompts = [] // every executor prompt with its label
  const reviews = [] // {round, openIdsInPrompt, answer}
  const closedAt = new Map() // template k -> round the reviewer closed it
  const idToTemplate = new Map() // reviewer-assigned ids are the workflow's; we learn them from the OPEN FINDINGS list in the prompt
  let round = 0
  const agent = async (prompt, opts = {}) => {
    const p = String(prompt)
    if (opts.agentType === PI) {
      execPrompts.push({ label: opts.label, prompt: p })
      return piAnswer('Changed files: src/f0.js\nDone.', p.split('\n')[0].replace(/^pi-model: /, ''), `sandbox: ${DIR}`)
    }
    if (opts.agentType === CHECKS) {
      const v = chance(r, 0.15) ? 'fail' : chance(r, 0.5) ? 'pass' : 'none'
      const changed = [{ status: 'M', path: 'src/f0.js' }].concat(chance(r, 0.4) ? [{ status: 'A', path: `src/new${Math.floor(r() * 3)}.js` }] : [])
      const checks = v === 'none' ? [] : [{ kind: 'test', cmd: 'npm test', ok: v === 'pass', exit: v === 'pass' ? 0 : 1, seconds: 1, failures: v === 'pass' ? [] : ['FAIL x'], tail: v === 'pass' ? 'ok' : 'FAIL' }]
      return checksAnswer({ dir: DIR, verdict: v, changed, checks }, v === 'fail' ? '1 of 1 checks failed' : v === 'pass' ? 'all checks passed' : 'no checks configured')
    }
    // The reviewer. Learn the open ids (and which template each is) from the prompt's OPEN FINDINGS block.
    round = Number((p.match(/Round (\d+)\./) || [])[1])
    // Every open id counts, including the blocker the workflow synthesises when a reviewer blocks with no findings.
    const open = [...p.matchAll(/^\{"id":"(B\d+\.\d+)".*?"issue":"((?:ISSUE-\d+-(\d+))?[^"]*)"/gm)].map((m) => ({ id: m[1], issue: m[2], k: m[3] === undefined ? null : Number(m[3]) }))
    for (const o of open) if (o.k !== null) idToTemplate.set(o.id, o.k)
    const findings = []
    for (const t of templates) if (chance(r, 0.5)) {
      const f = { severity: chance(r, 0.75) ? 'blocker' : 'nit', scope: t.pre ? 'pre-existing' : 'change', file: t.file, sites: [t.file], issue: t.issue, fix: 'fix it' }
      // Sometimes point at an open or closed id, sometimes re-report under a shifted file.
      if (chance(r, 0.3)) { const o = pick(r, open.concat([{ id: `B${Math.max(1, round - 1)}.1` }])); if (o) f.priorId = o.id }
      if (chance(r, 0.3)) f.file = t.file.replace(/:\d+$/, ':99')
      findings.push(f)
    }
    const verification = []
    for (const o of open) {
      if (chance(r, 0.2)) continue // omitted: must fail closed (P4)
      const status = pick(r, ['resolved', 'not-resolved', 'regressed', 'withdrawn'])
      verification.push({ id: o.id, status, reason: `because ${status}` })
      if (status === 'resolved' || status === 'withdrawn') closedAt.set(o.k, round)
    }
    const answer = { verdict: pick(r, ['pass', 'pass_with_nits', 'block', 'block']), summary: 'random', findings, verification }
    reviews.push({ round, open, answer })
    return answer
  }
  const out = await runBody(BODY, { args: { tasks: [{ id: 't', prompt: 'do the thing' }], maxRounds }, agent, log: () => {}, phase: () => {} })
  const t = out.results[0]
  const fail = (prop, why) => { throw new Error(`seed ${seed} ${prop}: ${why}\n  history=${JSON.stringify(t.history)}`) }

  // P1: no pre-existing template's issue ever reaches an executor, the open findings, or counts as a blocker.
  for (const tpl of templates.filter((x) => x.pre)) {
    for (const e of execPrompts) if (e.prompt.includes(tpl.issue)) fail('P1', `pre-existing ${tpl.issue} reached executor ${e.label}`)
    for (const f of t.openFindings || []) if (String(f.issue).includes(tpl.issue)) fail('P1', `pre-existing ${tpl.issue} left open`)
  }
  for (const rv of reviews) {
    const h = t.history.find((x) => x.round === rv.round && x.reviewed)
    if (!h) continue
    const changeBlockers = rv.answer.findings.filter((f) => f.severity === 'blocker' && f.scope !== 'pre-existing')
    const unresolvedOpen = rv.open.filter((o) => !rv.answer.verification.some((v) => v.id === o.id && (v.status === 'resolved' || v.status === 'withdrawn')))
    if (!changeBlockers.length && !unresolvedOpen.length && h.verdict === 'block' && rv.answer.findings.length) fail('P1', `round ${rv.round} blocked with only pre-existing/nit findings and nothing open`)
    // P4: an open id with no resolving verification keeps the round blocked.
    if (unresolvedOpen.length && h.verdict !== 'block') fail('P4', `round ${rv.round} passed with ${unresolvedOpen.map((o) => o.id).join(',')} unresolved`)
  }
  // P2: once closed, the template's issue never appears in a later executor prompt.
  const execRound = (label) => Number((label.match(/:r(\d+):exec/) || [])[1]) || (label.includes(':escalate') ? maxRounds + 1 : 0)
  for (const [k, closedRound] of closedAt) {
    if (k === null) continue // the synthesised fail-closed blocker has no template
    const tpl = templates[k]
    for (const e of execPrompts) if (execRound(e.label) > closedRound && e.prompt.includes(tpl.issue)) fail('P2', `${tpl.issue} closed in round ${closedRound} reached executor ${e.label}`)
    for (const f of t.openFindings || []) if (String(f.issue).includes(tpl.issue) && !f.carriedFrom) fail('P2', `${tpl.issue} closed in round ${closedRound} re-opened as a fresh finding`)
  }
  // P3: bounds.
  if (t.rounds > maxRounds + 1) fail('P3', `rounds ${t.rounds} > ${maxRounds + 1}`)
  if (execPrompts.filter((e) => e.label.includes(':escalate')).length > 1) fail('P3', 'more than one escalation')
  if (t.history.filter((h) => h.rethinkRequested).length > 1) fail('P3', 'more than one rethink')
  if (execPrompts.length > maxRounds + 1) fail('P3', `${execPrompts.length} executor calls`)
  // P5: a blocked round below the cap is followed by an executor prompt naming every open blocker id.
  for (const h of t.history) {
    if (h.verdict !== 'block' || h.round >= maxRounds) continue
    const next = execPrompts.find((e) => execRound(e.label) === h.round + 1)
    if (!next) fail('P5', `no executor call after blocked round ${h.round}`)
    const rv = reviews.find((x) => x.round === h.round)
    const carried = rv ? rv.open.filter((o) => !rv.answer.verification.some((v) => v.id === o.id && (v.status === 'resolved' || v.status === 'withdrawn'))) : []
    for (const o of carried) if (!next.prompt.includes(o.id)) fail('P5', `open ${o.id} missing from the round ${h.round + 1} executor prompt`)
  }
  return { rounds: t.rounds, status: t.status, pre: (t.preExisting || []).length, closed: (t.closed || []).length, suppressed: (t.suppressed || []).length }
}

async function sweep() {
  const stats = { runs: 0, statuses: {}, pre: 0, closed: 0, suppressed: 0, maxRounds: 0 }
  for (let seed = 1; seed <= SEEDS; seed++) {
    let s
    try { s = await runOne(seed) } catch (e) { return { counterexample: e.message } }
    stats.runs++
    stats.statuses[s.status] = (stats.statuses[s.status] || 0) + 1
    stats.pre += s.pre; stats.closed += s.closed; stats.suppressed += s.suppressed; stats.maxRounds = Math.max(stats.maxRounds, s.rounds)
  }
  return { stats }
}

const real = await sweep()
if (real.counterexample) { console.log(`COUNTEREXAMPLE ${real.counterexample}`); process.exit(1) }
console.log(`PASS convergence properties P1-P5 over ${real.stats.runs} generated runs (maxRounds 1-5, 2-5 defect classes, ~35% pre-existing): ${JSON.stringify(real.stats)}`)

// Each mutant removes one guard from the real source; the named property must then produce a counterexample.
const mutants = [
  { prop: 'P1', name: 'pre-existing findings block', from: "if (isPreExisting(f)) { pre.push({ ...f, round }); continue }", to: "if (false) { pre.push({ ...f, round }); continue }" },
  { prop: 'P2', name: 'closed findings are re-opened', from: "if ((f.priorId && closedIds.has(f.priorId)) || closedKeys.has(k))", to: "if (false)" },
  { prop: 'P4', also: 'P5', name: 'unverified open findings are dropped', from: "for (const f of verificationMissing(state.open, verification)) carried.push(", to: "for (const f of []) carried.push(" },
  { prop: 'P3', name: 'the cap is ignored for two more rounds', from: "if (round === MAX_ROUNDS) {", to: "if (round === MAX_ROUNDS + 2) {" },
  { prop: 'P5', name: 'the executor is not told the findings', from: "REVIEW FINDINGS:\\n${findingsText(findings)}", to: "REVIEW FINDINGS:\\n(withheld)" },
]
if (MUTANTS) {
  let bad = 0
  for (const m of mutants) {
    if (!SRC.includes(m.from)) { console.log(`FAIL mutant ${m.name}: target missing`); bad++; continue }
    BODY = loadWorkflowBody(SRC.replace(m.from, m.to))
    const r = await sweep()
    // Dropping an unverified finding breaks P4 (the round passes) or P5 (the id is missing from the next prompt), by seed.
    const caught = r.counterexample && (r.counterexample.includes(` ${m.prop}:`) || (m.also && r.counterexample.includes(` ${m.also}:`)))
    console.log(`${caught ? 'PASS' : 'FAIL'} mutant "${m.name}": ${r.counterexample ? r.counterexample.split('\n')[0].slice(0, 160) : 'no counterexample'}`)
    if (!caught) bad++
  }
  BODY = loadWorkflowBody(SRC)
  if (bad) process.exit(1)
  console.log(`PASS every mutant was caught by its property (${mutants.length}/${mutants.length})`)
}
