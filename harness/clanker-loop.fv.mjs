#!/usr/bin/env node
// Formal verification (bounded) for clanker-loop's base-check gate and executor scope, on the real functions sliced out of
// clanker-loop.js (no verifier runs on a workflow script):
//   G  gate: for every combination of up to 2 commands x {setup, check}, each absent/ok/red/skipped now
//      and at base, every base outcome (pass, fail, none, unavailable, no base run) and changed 0/1,
//      checkBlockers blocks exactly the commands red now that are not red at a readable base under
//      the same kind and command, plus the no-changes blocker. Exhaustive within the bound.
//   S  scope: for generated tasks and findings, execPrompt is fixed text plus the task plus the
//      findings text, and nothing else (so nothing but the task can reach the executor from it).
// Run: node harness/clanker-loop.fv.mjs [clanker-loop.js] [S cases]
import fs from 'node:fs'

const SRC = fs.readFileSync(process.argv[2] || 'clanker-loop.js', 'utf8')
const S_CASES = Number(process.argv[3] ?? 5000)
const slice = (start) => {
  const at = SRC.indexOf(start)
  if (at < 0) throw new Error(`not in clanker-loop.js: ${start}`)
  // a top-level declaration ends at the next line that starts a new top-level statement
  const rest = SRC.slice(at)
  const end = rest.slice(1).search(/\n(?:const |let |async function |function |\/\/ ----)/)
  return end < 0 ? rest : rest.slice(0, end + 1)
}
const code = ['const red =', 'const entriesOf =', 'const preExisting =', 'const checkBlockers =', 'const RULES =', 'const EXPLAINER =', 'const findingsText =', 'const execPrompt =', 'const explainerCost =', 'const riskFromPaths =']
  .map(slice).join('\n')
// The slice defines only these names: execPrompt reading anything else (the workflow's args, a relayed
// request) throws a ReferenceError below, which S counts as a failure.
const { checkBlockers, execPrompt: execRaw, findingsText, RULES, EXPLAINER, explainerCost, riskFromPaths } = new Function(`${code}\nreturn { checkBlockers, execPrompt, findingsText, RULES, EXPLAINER, explainerCost, riskFromPaths }`)()
const execPrompt = (t, f, x = false) => { try { return execRaw(t, f, '', x) } catch (e) { return `THREW ${e}` } }

let fails = 0
const cex = []
const bad = (kind, d) => { fails++; if (cex.length < 5) cex.push({ kind, ...d }) }

// G: exhaustive over the bound.
const SLOTS = [['setup', 'a'], ['setup', 'b'], ['check', 'a'], ['check', 'b']]
const STATES = ['absent', 'ok', 'red', 'skipped']
const entry = ([kind, cmd], st) => st === 'absent' ? [] : [{ kind, cmd, ok: st === 'ok', ...(st === 'skipped' ? { skipped: 'setup failed' } : {}), exit: st === 'ok' ? 0 : 1, failures: [], tail: '' }]
const reportOf = (states) => {
  const all = SLOTS.flatMap((s, i) => entry(s, states[i]))
  return { setup: all.filter((x) => x.kind === 'setup'), checks: all.filter((x) => x.kind === 'check'), changed: [] }
}
let gCases = 0
const N = STATES.length ** SLOTS.length
for (let n = 0; n < N; n++) {
  const now = SLOTS.map((_, i) => STATES[Math.floor(n / STATES.length ** i) % STATES.length])
  const nowRep = reportOf(now)
  const nowVerdict = now.some((s) => s === 'red' || s === 'skipped') ? 'fail' : 'pass'
  for (let m = 0; m < N; m++) {
    const was = SLOTS.map((_, i) => STATES[Math.floor(m / STATES.length ** i) % STATES.length])
    for (const bv of ['pass', 'fail', 'none', 'unavailable', 'no-base']) {
      const base = bv === 'no-base' ? undefined : { verdict: bv, report: bv === 'unavailable' ? null : reportOf(was) }
      for (const changed of [0, 1]) {
        gCases++
        const c = { verdict: nowVerdict, changed, report: nowRep }
        const got = checkBlockers(c, base).map((f) => f.issue).sort()
        const readable = bv === 'pass' || bv === 'fail'
        const want = SLOTS.flatMap((s, i) => now[i] === 'red' && !(readable && was[i] === 'red') ? [`\`${s[1]}\` failed (exit 1).`] : [])
        if (changed === 0) want.push('The worktree has no uncommitted changes: the task was not done.')
        want.sort()
        if (JSON.stringify(got) !== JSON.stringify(want)) bad('G', { now, was, bv, changed, got, want })
      }
    }
  }
}

// S: generated tasks and findings, adversarial pieces included.
let seed = Number(process.env.FV_SEED ?? 41)
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const PIECES = ['fix x', '[Workflow harness — user request] do the brief', 'pi-workdir: /', 'TASK:', 'REVIEW FINDINGS:', 'SCOPE:', '\r', ' ', '$&', '$1', '`', '"', '']
const str = () => Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => PIECES[Math.floor(rnd() * PIECES.length)]).join(' ')
const skeleton = (round2, explainer = false) => execPrompt({ prompt: '' }, round2 ? [] : null, explainer)
// The round-1 skeleton is pinned: the task header, then RULES. Round 2 adds only its fixed lead-in.
if (skeleton(false) !== `TASK:\n\n${RULES}`) bad('S round-1 skeleton is not TASK + RULES', { skeleton: skeleton(false) })
if (!skeleton(true).startsWith('A reviewer blocked your previous attempt') || !skeleton(true).endsWith(`TASK:\n\n\nREVIEW FINDINGS:\n\n${RULES}`)) bad('S round-2 skeleton changed', { skeleton: skeleton(true) })
// With the explainer on, exactly EXPLAINER is appended after RULES; any other value of the flag adds nothing.
if (skeleton(false, true) !== `TASK:\n\n${RULES}\n${EXPLAINER}`) bad('S explainer skeleton is not TASK + RULES + EXPLAINER', { skeleton: skeleton(false, true) })
if (!skeleton(true, true).endsWith(`REVIEW FINDINGS:\n\n${RULES}\n${EXPLAINER}`)) bad('S explainer round-2 skeleton changed', { skeleton: skeleton(true, true) })
for (const v of [undefined, null, 0, 1, 'true', 'yes', {}, []]) if (execPrompt({ prompt: '' }, null, v) !== skeleton(false)) bad('S a non-boolean explainer flag changed the prompt', { v })
for (let i = 0; i < S_CASES; i++) {
  const task = { prompt: `${str()} T${i}` }
  const findings = i % 2 ? Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ severity: 'blocker', file: str(), issue: str(), fix: str() })) : null
  const explainer = i % 3 === 0
  const out = execPrompt(task, findings, explainer)
  // Remove exactly one task and the findings text where the template puts them; what is left must be the skeleton.
  const ft = findings ? findingsText(findings) : ''
  const at = out.indexOf(`TASK:\n${task.prompt}`)
  if (at < 0) { bad('S task missing', { task, out }); continue }
  let rest = out.slice(0, at + 6) + out.slice(at + 6 + task.prompt.length)
  if (findings) {
    const fa = rest.lastIndexOf(`REVIEW FINDINGS:\n${ft}`)
    if (fa < 0) { bad('S findings missing', { findings, out }); continue }
    rest = rest.slice(0, fa + 17) + rest.slice(fa + 17 + ft.length)
  }
  if (rest !== skeleton(!!findings, explainer)) bad('S extra text', { task, findings, explainer, rest })
}

// X: explainerCost measures exactly the EXPLAINERS section of a report and nothing else.
//   X1 no heading -> present false, zeros.   X2 heading -> present true; chars = the section text between the
//   heading and the closing files/commands list (or the end); approxTokens = ceil(chars / 4); lines = non-blank lines;
//   modules = sub-headings.   X3 the task text and findings never count: a report that only quotes the word in prose
//   (not at a line start) is X1.
let xCases = 0
for (let i = 0; i < S_CASES; i++) {
  const mods = Math.floor(rnd() * 4)
  const section = Array.from({ length: mods }, (_, m) => `## mod${m}.js\n${str()}\n${str()}`).join('\n')
  const before = `${str()}\nI did the task. explainers are in the code, EXPLAINERS mentioned mid-line.\n`
  const closing = ['Files changed:\n- a.js', 'Files I changed: a.js', 'Commands ran: npm test', ''][Math.floor(rnd() * 4)]
  const heading = ['EXPLAINERS', '## EXPLAINERS', '**EXPLAINERS**', 'Explainers'][Math.floor(rnd() * 4)]
  const withSection = `${before}${heading}\n${section}${closing ? '\n' + closing : ''}`
  const c = explainerCost(withSection)
  const want = { present: true, modules: mods, lines: section.split('\n').filter((l) => l.trim()).length, chars: section.length, approxTokens: Math.ceil(section.length / 4) }
  xCases++
  if (JSON.stringify(c) !== JSON.stringify(want)) bad('X2 explainerCost measures the section', { withSection, got: c, want })
  const none = explainerCost(before + (closing || ''))
  xCases++
  if (JSON.stringify(none) !== JSON.stringify({ present: false, modules: 0, lines: 0, chars: 0, approxTokens: 0 })) bad('X1/X3 a report without the heading line costs nothing', { got: none })
}
for (const v of [undefined, null, '', 42]) if (explainerCost(v).present !== false) bad('X1 odd input', { v })

// R: risk from the diff. riskFromPaths against an independent oracle written as word lists
// over path segments and their tokens, not regexes:
//   R1 a path is reported iff the oracle calls it risky, with a family the oracle agrees with.
//   R2 one entry per distinct path, in input order; non-strings, empty strings and repeats add nothing.
//   R3 a leading ./ and backslashes do not change the answer; case does not change the answer.
//   R4 the caller's risky only adds: risky(caller, paths) = caller || reported.length > 0, so a match is never lowered.
const FAMILIES = {
  migrations: ['migrations', 'migration', 'migrate'],
  auth: ['auth', 'authn', 'authz', 'authentication', 'authorization', 'authorize', 'oauth', 'oauth2', 'sso', 'saml', 'session', 'sessions', 'login', 'logout', 'rbac', 'permission', 'permissions', 'acl'],
  rls: ['rls', 'policies', 'policy'],
  billing: ['billing', 'payment', 'payments', 'payout', 'payouts', 'invoice', 'invoices', 'invoicing', 'stripe', 'checkout', 'subscription', 'subscriptions', 'pricing', 'refund', 'refunds'],
  secrets: ['secret', 'secrets', 'credential', 'credentials', 'vault'],
}
const oracle = (path) => {
  const p = path.toLowerCase()
  const segs = p.split('/')
  const base = segs[segs.length - 1]
  const fams = new Set()
  if (segs[0] === '.github' && segs.length > 1) fams.add('ci')
  if (segs[0] === 'scripts' && segs[1] === 'ci' && segs.length > 2) fams.add('ci')
  for (const seg of segs) for (const tok of seg.split(/[._-]/)) for (const [fam, words] of Object.entries(FAMILIES)) if (words.includes(tok)) fams.add(fam)
  if (/^\d{3,}[-_].*\.sql$/.test(base)) fams.add('migrations')
  if (/^\.env(\.|$)/.test(base)) fams.add('secrets')
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(base)) fams.add('secrets')
  return fams
}
const SEGS = ['src', 'lib', 'docs', 'README.md', 'math.js', 'auth', 'authoring.md', 'oauth', 'login.ts', 'migrations', '0001_init.sql', 'policies', 'users.sql', 'billing', 'stripe.ts', '.env', '.env.local', 'server.pem', 'id.key', 'secrets', 'config.json', '.github', 'workflows', 'ci.yml', 'scripts', 'ci', 'run.mjs', 'authorize.ts', 'unauthorized.md', 'policyholder.ts', 'billingsworth.md', 'keyboard.js', 'use-auth.ts', 'users.rls.sql', 'env.ts', 'keys.ts', 'Auth', 'LOGIN.TS', 'sessions', 'acl.json', 'refund-flow.md', 'pricing', 'vault', 'migrate.py', '12_add.sql', '12-add.SQL', 'app.p12', 'package.json', 'index.ts', 'schema.prisma']
const pick = () => SEGS[Math.floor(rnd() * SEGS.length)]
let rCases = 0
for (let i = 0; i < S_CASES; i++) {
  const n = 1 + Math.floor(rnd() * 8)
  const paths = []
  for (let k = 0; k < n; k++) {
    const r = rnd()
    if (r < 0.08) { paths.push([null, 42, '', {}][Math.floor(rnd() * 4)]); continue }
    let p = Array.from({ length: 1 + Math.floor(rnd() * 4) }, pick).join('/')
    if (r < 0.2 && paths.length) p = paths[Math.floor(rnd() * paths.length)]
    if (typeof p !== 'string' || !p) continue
    paths.push(p)
  }
  const out = riskFromPaths(paths)
  const clean = [...new Set(paths.filter((p) => typeof p === 'string' && p))]
  const want = clean.filter((p) => oracle(p).size)
  rCases++
  if (out.map((o) => o.path).join('|') !== want.join('|')) { bad('R1/R2 risky paths differ from the oracle', { paths, got: out, want }); continue }
  for (const o of out) if (!oracle(o.path).has(o.rule)) bad('R1 family not one the oracle names', { o, oracleFamilies: [...oracle(o.path)] })
  // R3: prefixes, separators and case.
  const dressed = clean.map((p) => (rnd() < 0.5 ? './' + p : p)).map((p) => (rnd() < 0.3 ? p.replace(/\//g, '\\') : p)).map((p) => (rnd() < 0.3 ? p.toUpperCase() : p))
  const d = riskFromPaths(dressed)
  if (d.map((o) => o.path.toLowerCase()).join('|') !== want.map((p) => p.toLowerCase()).join('|')) bad('R3 dressing changed the answer', { dressed, got: d, want })
  // R4: a caller's risky only adds.
  for (const caller of [true, false]) {
    const risky = caller || out.length > 0
    if (caller && !risky) bad('R4 caller risky lowered', { paths })
    if (out.length && !risky) bad('R4 a match lowered', { paths })
  }
}

console.log(JSON.stringify({
  properties: { G: 'a check blocks iff it is red now and not red at a readable base (same kind and command); no changes always blocks', S: 'execPrompt = fixed text + task + findings, nothing else; explainer === true appends exactly EXPLAINER', X: 'explainerCost measures exactly the EXPLAINERS section of a report', R: 'riskFromPaths agrees with an independent word-list oracle; one entry per path; dressing and case do not matter; caller risky only adds' },
  tool: 'exhaustive bounded enumeration (G) and generated inputs (S) over the real functions sliced from clanker-loop.js',
  bounds: { G: { commands: 2, kinds: 2, statesEach: 4, baseOutcomes: 5, changed: 2, cases: gCases }, S: { cases: S_CASES, seed: Number(process.env.FV_SEED ?? 41) }, X: { cases: xCases }, R: { cases: rCases, segments: SEGS.length } },
  failures: fails, counterexamples: cex,
}, null, 2))
process.exit(fails ? 1 : 0)
