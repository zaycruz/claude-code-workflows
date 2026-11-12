// ---- clanker kit v3 (paste verbatim; wf-smoke.mjs checks every copy matches lib/clanker-kit.js) ----
// Roles: Claude coordinates, workers ("clankers") execute, a checks step runs the tests, Claude
// models (Sonnet; Opus when risky) review and judge.
// Backends. claude: workers are the clanker-worker / clanker-reader subagents install.sh installs,
// each with a guard hook; checks run in the clanker-checks subagent. pi: workers run through the
// pi-agent-for-claude plugin on open models; checks run in the checks-runner plugin (no model).
// fallback is the model a blocked task escalates to (and, on pi, the retry when the executor fails).
const WORKERS = { backend: 'claude', executor: 'sonnet', fallback: 'opus', checks: 'claude' } // install.sh --workers rewrites this line
const PI = 'pi-agent-for-claude:pi'
const CHECKS = 'checks-runner:checks'
const WORKER = 'clanker-worker'
const READER = 'clanker-reader'
const CHECKER = 'clanker-checks'
const ROUTING = { executor: WORKERS.executor, fallback: WORKERS.fallback, reviewer: 'sonnet', riskyReviewer: 'opus', synthesis: 'sonnet', jsonFallback: 'sonnet', webResearcher: 'sonnet' }
const reviewModel = (risky) => (risky ? ROUTING.riskyReviewer : ROUTING.reviewer)
const PI_FOOTER = /\n*— answered by pi \[([^\]]*)\], (\S+)\s*$/
const CHECKS_FOOTER = /\n*— answered by checks \[[^\]]*\], deterministic\s*$/
const piBody = (r) => String(r || '').replace(PI_FOOTER, '').trim()
// Missing footer or empty body = failed. The error-text scan runs only on short bodies (<400 chars):
// a real report that merely quotes "HTTP 502" is not a failure.
const piFailed = (r) => {
  const s = String(r || '')
  if (!PI_FOOTER.test(s)) return true
  const b = piBody(s)
  return !b || (b.length < 400 && /upstream_unavailable|(?:HTTP|status)[ :]*50[234]|ECONNREFUSED|No API key|model not found/i.test(s.slice(-800)))
}

// What a Claude worker returns: its answer, and the absolute directory it worked in.
const WORKER_OUT = { type: 'object', properties: { report: { type: 'string' }, workdir: { type: 'string' } }, required: ['report', 'workdir'] }
const workerHead = (where) => [
  where === 'readonly' ? 'Read-only: change no file anywhere.'
    : where ? `Work only inside ${where}: cd there before anything else and change no file outside it.`
      : 'You are in a fresh git worktree: work only inside it.',
  'Return {report, workdir}: report is your full answer; workdir is the absolute path of the directory you worked in (pwd -P).',
].join('\n')

// Runs one clanker on `model` (the executor by default). where: an absolute directory the worker may
// write in, or 'readonly'. Omit it only with isolation: 'worktree'. Returns { ok, text (the answer),
// used (model), dir (where it ran, when it wrote) }. On pi, a failed call on any model but the
// fallback is retried once on the fallback.
async function clank(prompt, { where, model = ROUTING.executor, label, phase, isolation } = {}) {
  if (WORKERS.backend === 'claude') {
    const ro = where === 'readonly'
    const opts = { label, phase, model, schema: WORKER_OUT, agentType: ro ? READER : WORKER }
    if (isolation) opts.isolation = isolation
    const r = await agent(`${workerHead(where)}\n\n${prompt}`, opts)
    const text = String(r?.report || '').trim()
    const wd = String(r?.workdir || '').trim()
    return { ok: !!text, text, used: model, dir: !ro && wd.startsWith('/') ? wd : '' }
  }
  const head = (m) => [`pi-model: ${m}`, where ? `pi-workdir: ${where}` : ''].filter(Boolean).join('\n')
  const opts = { label, phase, agentType: PI }
  if (isolation) opts.isolation = isolation
  let r = await agent(`${head(model)}\n${prompt}`, opts)
  let used = model
  if (ROUTING.fallback && model !== ROUTING.fallback && piFailed(r)) {
    log(`${label}: ${model} failed; falling back to ${ROUTING.fallback}`)
    r = await agent(`${head(ROUTING.fallback)}\n${prompt}`, { ...opts, label: `${label}:fallback` })
    used = ROUTING.fallback
  }
  const sandbox = (String(r || '').match(PI_FOOTER)?.[1] || '').match(/^sandbox: (\/.+)$/)?.[1] || ''
  return { ok: !piFailed(r), text: piBody(r), used, dir: sandbox }
}

// Asks for a JSON answer: the clanker must end with one ```json fenced block matching `shape`.
const JSON_ASK = (shape) => `End your answer with exactly one fenced \`\`\`json block holding a single JSON object of this shape (a JSON Schema); nothing after it:\n${JSON.stringify(shape)}`

// The last ```json block (else the last top-level {...}) in a clanker's text, parsed; null when none parses,
// or a `required` key of `shape` is missing, or one has the wrong JSON type (an `array` of `object` items
// must hold objects).
const jsonTypeOk = (v, s) => {
  const ty = s?.type
  if (ty === 'array') return Array.isArray(v) && (s.items?.type !== 'object' || v.every((e) => e && typeof e === 'object' && !Array.isArray(e)))
  if (ty === 'string') return typeof v === 'string'
  if (ty === 'object') return !!v && typeof v === 'object' && !Array.isArray(v)
  if (ty === 'boolean') return typeof v === 'boolean'
  if (ty === 'number') return typeof v === 'number' && Number.isFinite(v)
  if (ty === 'integer') return Number.isInteger(v)
  return true
}
function jsonTail(text, shape) {
  const t = String(text || '')
  const fenced = [...t.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map((m) => m[1])
  const cands = fenced.length ? fenced.reverse() : [t.slice(t.lastIndexOf('\n{') + 1)]
  for (const c of cands) {
    try {
      const o = JSON.parse(c)
      if (o && typeof o === 'object' && !Array.isArray(o) && (shape?.required || []).every((k) => k in o && jsonTypeOk(o[k], shape?.properties?.[k]))) return o
    } catch {}
  }
  return null
}

// A read-only clanker that must answer as JSON. claude: one reader call with the schema enforced.
// pi: pi first; when it fails or returns no valid JSON, one Claude fallback (`fallbackModel`, Sonnet
// by default) with the schema enforced.
async function clankJson(prompt, shape, { label, phase, model = ROUTING.executor, fallbackModel = ROUTING.jsonFallback } = {}) {
  if (WORKERS.backend === 'claude') {
    const c = await agent(prompt, { label, phase, schema: shape, agentType: READER, model })
    return c ? { ...c, _by: model } : null
  }
  const r = await clank(`${prompt}\n\n${JSON_ASK(shape)}`, { where: 'readonly', model, label, phase })
  const o = r.ok ? jsonTail(r.text, shape) : null
  if (o) return { ...o, _by: r.used }
  log(`${label}: ${r.ok ? 'no valid JSON from ' + r.used : r.used + ' failed'}; falling back to Claude ${fallbackModel}`)
  const c = await agent(prompt, { label: `${label}:claude`, phase, schema: shape, agentType: 'Plan', model: fallbackModel })
  return c ? { ...c, _by: fallbackModel } : null
}

// Runs the deterministic checks (no model) in `dir` (absolute, or '.' for the session's directory).
// run/setup: one-line commands; empty = what the repo declares. base: a git revision (HEAD) to check
// instead of the directory's working tree, in a temp export of that commit. Returns
// { verdict: pass|fail|none|unavailable, head, report, dir, changed }.
async function runChecks(dir, { run = [], setup = [], timeout, base, label = 'checks', phase = 'Checks' } = {}) {
  if (WORKERS.checks === 'claude') return claudeChecks(dir, { run, setup, timeout, base, label, phase })
  const prompt = [`checks-dir: ${dir}`, base ? `checks-base: ${base}` : '', ...run.map((c) => `checks-run: ${c}`), ...setup.map((c) => `checks-setup: ${c}`), timeout ? `checks-timeout: ${timeout}` : '']
    .filter(Boolean).join('\n')
  const r = String((await agent(prompt, { label, phase, agentType: CHECKS })) || '')
  const m = r.match(CHECKS_FOOTER)
  if (!m) {
    log(`${label}: the checks runner did not answer (${r.trim().slice(0, 120) || 'empty'})`)
    return { verdict: 'unavailable', head: 'checks runner unavailable', report: null, dir: '', changed: undefined }
  }
  const body = r.slice(0, m.index).trim()
  const head = body.split('\n')[0]
  let rep = null
  try { rep = JSON.parse(body.slice(body.indexOf('{'))) } catch {}
  // A footer with an unreadable or incomplete body is not evidence of a failing build. It is the same
  // missing evidence as no footer at all, so it must not raise a "the checks are failing" blocker.
  if (!rep || typeof rep !== 'object' || Array.isArray(rep) || !Array.isArray(rep.changed) || !Array.isArray(rep.checks)) {
    log(`${label}: the checks report was unreadable`)
    return { verdict: 'unavailable', head: 'the checks report was unreadable', report: null, error: body.slice(-1500), dir: '', changed: undefined }
  }
  const verdict = rep.verdict === 'pass' ? 'pass' : rep.verdict === 'none' ? 'none' : rep.verdict === 'fail' ? 'fail' : 'unavailable'
  return { verdict, head, report: rep, dir: rep.dir, changed: Array.isArray(rep.changed) ? rep.changed.length : undefined }
}

// The checks report, as the checks runner writes it: one entry per setup and check command.
const CHECK_ENTRY = { type: 'object', properties: { kind: { type: 'string' }, cmd: { type: 'string' }, ranIn: { type: 'string' }, ok: { type: 'boolean' }, exit: { type: 'integer' }, seconds: { type: 'number' }, timedOut: { type: 'boolean' }, skipped: { type: 'string' }, failures: { type: 'array', items: { type: 'string' } }, tail: { type: 'string' } }, required: ['kind', 'cmd', 'ok', 'exit', 'seconds', 'failures', 'tail'] }
const CHECKS_REPORT = { type: 'object', properties: { dir: { type: 'string' }, head: { type: 'string' }, changed: { type: 'array', items: { type: 'object', properties: { status: { type: 'string' }, path: { type: 'string' } }, required: ['status', 'path'] } }, changedError: { type: 'string' }, workDir: { type: 'string' }, setup: { type: 'array', items: CHECK_ENTRY }, checks: { type: 'array', items: CHECK_ENTRY }, verdict: { type: 'string', enum: ['pass', 'fail', 'none'] } }, required: ['dir', 'head', 'changed', 'setup', 'checks', 'verdict'] }

// The checks on the claude backend: a Haiku subagent runs the commands and reports exit codes and
// output, the same report shape as the runner. A model ran them, so the headline says so.
async function claudeChecks(dir, { run, setup, timeout, base, label, phase }) {
  const secs = timeout || 900
  const prompt = [
    'You run a project\'s checks and report what happened. Never fix, edit, judge or explain anything; never commit.',
    // A subagent's shell goes back to the session's directory between Bash calls, so a cd on its own
    // does not hold: each command carries its cd, and pwd in the same call shows where it ran.
    dir === '.' ? 'Directory: your current directory. Run every command as `pwd && <command>` in one Bash call; ranIn is the line pwd printed.'
      : base ? `Check commit ${base}, not the working tree. First run \`mktemp -d\` on its own; its output is your work dir W. Then run \`git -C ${dir} archive ${base} | tar -x -C W\` (W written out). Run every command below as \`cd W && pwd && <command>\` in one Bash call: the shell does not stay in a directory between calls. Report workDir W, dir ${dir}, changed [] and head ${base}.`
        : `Directory: ${dir}. Run every command below as \`cd ${dir} && pwd && <command>\` in one Bash call: the shell does not stay in a directory between calls.`,
    'For each command, ranIn is the line pwd printed in that same call.',
    setup.length ? `Setup commands, in order, before the checks (kind "setup"):\n${setup.map((c) => `- ${c}`).join('\n')}` : 'Setup: if package.json exists, declares dependencies or devDependencies, and node_modules does not exist, run the install command its lock file implies (kind "setup"). Otherwise there is no setup.',
    run.length ? `Check commands, in order:\n${run.map((c) => `- ${c}`).join('\n')}`
      : 'Check commands: detect them. If package.json declares a "check" (or "verify") script, run that alone. Otherwise its test, lint and typecheck scripts; else cargo test, go test ./..., pytest, or a Makefile test target, whichever the project declares.',
    `Give each Bash call a timeout of ${Math.min(secs, 600)} seconds. For each record kind (setup, test, lint, typecheck, build or check), cmd, ok (exit 0), exit, seconds, timedOut, failures (up to 20 output lines naming a failure) and tail (the last 40 output lines), verbatim.`,
    base || dir === '.' ? '' : `changed: run \`git -C ${dir} status --porcelain\` (Claude Code refuses cd followed by git in one call), as [{status, path}]. If it cannot run (refused, needs approval, errors), set changed to [] and changedError to its exact error text; never guess. head: \`git -C ${dir} rev-parse --short HEAD\`.`,
    dir === '.' ? 'changed: `git status --porcelain`, as [{status, path}]; if it cannot run, changed [] and changedError its exact error text. head: `git rev-parse --short HEAD`.' : '',
    'A command that did not run (refused, needs approval, not found) has ok false, exit -1 and skipped set to why; never retry it in another form.',
    'verdict: none when there was no check command to run; pass when every check exited 0; else fail.',
  ].filter(Boolean).join('\n')
  const rep = await agent(prompt, { label, phase, agentType: CHECKER, model: 'haiku', schema: CHECKS_REPORT })
  if (!rep || !Array.isArray(rep.changed) || !Array.isArray(rep.checks)) {
    log(`${label}: the checks agent did not answer`)
    return { verdict: 'unavailable', head: 'checks agent unavailable', report: null, dir: '', changed: undefined }
  }
  if (!Array.isArray(rep.setup)) rep.setup = []
  // A command that did not run is not a failure of the change: the worker cannot fix a refused
  // command. The agent marks it with skipped, or sometimes only with exit -1; a timeout is a failure.
  const notRun = (x) => !x.ok && !x.timedOut && ((typeof x.skipped === 'string' && x.skipped.trim() !== '') || !(x.exit >= 0))
  for (const x of rep.setup.concat(rep.checks)) if (notRun(x)) x.skipped = (typeof x.skipped === 'string' && x.skipped.trim()) || 'did not run'
  const ranRed = (x) => !x.ok && !x.skipped
  const passed = rep.checks.filter((x) => x.ok).length
  const skippedChecks = rep.checks.filter((x) => x.skipped)
  // Commands that ran must show, by pwd, that they ran where they were sent; checks run elsewhere
  // say nothing about the change. The base check must run in its own temp dir, not the worktree.
  const norm = (p) => String(p || '').trim().replace(/\/+$/, '')
  const want = dir === '.' ? '' : base ? norm(rep.workDir) : norm(dir)
  const badBase = !!base && dir !== '.' && (!want || want === norm(dir))
  const strayRuns = dir === '.' ? [] : rep.setup.concat(rep.checks).filter((x) => !x.skipped && (badBase || norm(x.ranIn) !== want))
  // The verdict comes from the exit codes, not from the model's own verdict. A check that did not run,
  // or a red check after a setup that did not run, leaves the checks unavailable, not failed.
  const verdict = strayRuns.length || skippedChecks.length || (rep.setup.some((x) => x.skipped) && rep.checks.some(ranRed)) ? 'unavailable'
    : rep.setup.some(ranRed) ? 'fail' : rep.checks.length === 0 ? 'none' : passed === rep.checks.length ? 'pass' : 'fail'
  // A changed list the agent could not get is unknown, not empty: an empty one blocks the task as not done.
  const unknown = typeof rep.changedError === 'string' && rep.changedError.trim() !== ''
  const notRunNote = verdict === 'unavailable' ? ` (${strayRuns.map((x) => `\`${x.cmd}\` ran in ${norm(x.ranIn).slice(0, 200) || 'an unknown dir'}, not ${want || 'a temp dir of its own'}`)
    .concat(rep.setup.concat(rep.checks).filter((x) => x.skipped).map((x) => `\`${x.cmd}\` did not run: ${String(x.skipped).slice(0, 200)}`)).join('; ')})` : ''
  const head = `CHECKS ${verdict.toUpperCase()}${notRunNote} - ${passed}/${rep.checks.length} passed, ${unknown ? 'changed files unknown' : `${rep.changed.length} changed file(s)`} (run by haiku, not deterministic)`
  return { verdict, head, report: { ...rep, verdict, changed: unknown ? null : rep.changed }, dir: rep.dir, changed: unknown ? undefined : rep.changed.length }
}

// A checks result as text for a reviewer or a clanker: headline, changed files, and each failing command's output.
function checksText(c) {
  if (!c.report) return c.error ? `${c.head}\n${c.error}` : c.head
  const r = c.report
  return [
    c.head,
    Array.isArray(r.changed) ? `changed files: ${r.changed.map((f) => `${f.status} ${f.path}`).join(', ') || '(none)'}` : `changed files: unknown (${String(r.changedError || 'git status did not run').slice(0, 300)})`,
    ...(Array.isArray(r.setup) ? r.setup : []).concat(r.checks).map((x) => x.skipped
      ? `- ${x.kind} \`${x.cmd}\`: skipped (${x.skipped})`
      : `- ${x.kind} \`${x.cmd}\`: ${x.ok ? 'ok' : `FAILED exit ${x.exit}${x.timedOut ? ' (timed out)' : ''}`} in ${x.seconds}s${x.ok ? '' : `\n  failure lines: ${x.failures.join(' | ').slice(0, 1500) || '(none matched)'}\n  output tail:\n${x.tail.slice(-1500)}`}`),
  ].join('\n')
}

// What a reviewer is told about running tests, given the checks verdict.
const REVIEWER_CHECKS_RULE = (c) => c.verdict === 'pass' || c.verdict === 'fail'
  ? 'The automated checks below already ran deterministically. Do NOT run test suites, builds or linters yourself; the report is authoritative. Spend your effort on what checks cannot see.'
  : c.verdict === 'none'
    ? 'No automated checks exist for this project. Do NOT run builds or test suites yourself; judge from the source, and flag missing tests the change needs.'
    : 'The automated checks runner was unavailable, so you may run the project\'s tests yourself, once, in a non-writing mode.'
const readArgs = (x, fromString) => {
  if (x && typeof x === 'object') return x
  if (typeof x !== 'string') return {}
  const s = x.trim()
  if (s) {
    try { const j = JSON.parse(s); if (j && typeof j === 'object') return j } catch {}
  }
  return fromString(s)
}
const rejectUnknown = (A, allowed) => {
  const unknown = Object.keys(A).filter((k) => !allowed.includes(k))
  if (unknown.length) throw new Error(NAME + ': unknown arg(s) ' + unknown.join(', ') + '; allowed: ' + allowed.join(', '))
}
const riskyArg = (v) => v === true || v === 'true'
const intArg = (A, key, def, min, max) => {
  if (A[key] === undefined) return def
  const n = Number(A[key])
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${NAME}: ${key} must be an integer ${min}-${max}`)
  return n
}
const cmdList = (x, what) => {
  if (x === undefined) return []
  if (!Array.isArray(x) || x.some((c) => typeof c !== 'string' || !c.trim() || /[\r\n]/.test(c))) throw new Error(`${NAME}: ${what} must be an array of one-line commands (strings, no newlines)`)
  return x.map((c) => c.trim())
}
const fence = (s, tag = 'UNTRUSTED') => `<<<${tag}\n${String(s).replace(/<<<(?:UNTRUSTED|DATA|ARTIFACT)|(?:UNTRUSTED|DATA|ARTIFACT)>>>/g, '...')}\n${tag}>>>`
const verificationMissing = (prior, verification) => {
  const covered = new Set(verification.map((x) => x.id))
  return prior.filter((f) => !covered.has(f.id))
}
const blockerIds = (items, round) => items.map((f, i) => ({ ...f, id: `B${round}.${i + 1}` }))
// ---- end clanker kit ----
