#!/usr/bin/env node
// Model-checks verify/RedBlueLoop.tla with TLC: the real configs must pass, and each broken
// variant (Mut) must make TLC report the property it breaks, or the model is too weak to see that
// defect. Writes reports/verify/red-blue-loop.json and the TLC logs next to it.
// TLC is a solver: it runs in CI (job verify), not on the Mac (pass --allow-mac to try a bound).
//   TLA2TOOLS_JAR=/path/tla2tools.jar node verify/run-tlc.mjs
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '..', 'reports', 'verify')
const TLA_VERSION = '1.7.4'
const JAR_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'

if (process.platform === 'darwin' && !process.argv.includes('--allow-mac')) {
  console.error('run-tlc: TLC runs in CI by default, not on a Mac (--allow-mac to override)')
  process.exit(2)
}
const jar = process.env.TLA2TOOLS_JAR
if (!jar || !fs.existsSync(jar)) { console.error('run-tlc: set TLA2TOOLS_JAR to tla2tools.jar v' + TLA_VERSION); process.exit(2) }
const sha = createHash('sha256').update(fs.readFileSync(jar)).digest('hex')
if (sha !== JAR_SHA256) { console.error(`run-tlc: ${jar} sha256 ${sha} is not the pinned v${TLA_VERSION} jar`); process.exit(2) }

const INVARIANTS = ['TypeOK', 'ConfirmedIsProven', 'FixOnlyConfirmed', 'NoRework', 'RoundBound', 'DryStops', 'NoMerge']
const cfg = ({ sus, known, maxRounds, mut }) => [
  `CONSTANTS Sus = {${sus.join(', ')}}`,
  `          Known = {${known.join(', ')}}`,
  `          MaxRounds = ${maxRounds}`,
  `          Mut = "${mut}"`,
  ...sus.map((s) => `          ${s} = ${s}`),
  'SPECIFICATION Spec',
  `INVARIANTS ${INVARIANTS.join(' ')}`,
  'PROPERTY Terminates',
].join('\n') + '\n'

const SMALL = { sus: ['s1', 's2', 's3'], known: ['s1'], maxRounds: 2 }
const LARGE = { sus: ['s1', 's2', 's3', 's4', 's5'], known: ['s1'], maxRounds: 4 }
const RUNS = [
  { name: 'model-small', ...SMALL, mut: 'none', expect: 'pass' },
  { name: 'model-large', ...LARGE, mut: 'none', expect: 'pass' },
  { name: 'mutant-nodedup', ...SMALL, mut: 'nodedup', expect: /Invariant NoRework is violated/ },
  { name: 'mutant-confirmunproven', ...SMALL, mut: 'confirmunproven', expect: /Invariant ConfirmedIsProven is violated/ },
  { name: 'mutant-fixunconfirmed', ...SMALL, mut: 'fixunconfirmed', expect: /Invariant FixOnlyConfirmed is violated/ },
  { name: 'mutant-nostop', ...SMALL, mut: 'nostop', expect: /Invariant DryStops is violated/ },
  { name: 'mutant-nobound', ...SMALL, mut: 'nobound', expect: /Invariant RoundBound is violated/ },
  { name: 'mutant-merge', ...SMALL, mut: 'merge', expect: /Invariant NoMerge is violated/ },
]

fs.mkdirSync(OUT, { recursive: true })
const report = { model: 'verify/RedBlueLoop.tla', tool: `TLC ${TLA_VERSION} (tla2tools.jar sha256 ${JAR_SHA256})`, invariants: INVARIANTS, properties: ['Terminates'], runs: [] }
let failed = false
for (const r of RUNS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbl-tlc-'))
  fs.copyFileSync(path.join(HERE, 'RedBlueLoop.tla'), path.join(dir, 'RedBlueLoop.tla'))
  fs.writeFileSync(path.join(dir, 'RedBlueLoop.cfg'), cfg(r))
  const t0 = process.hrtime.bigint()
  const p = spawnSync('java', ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', 'auto', '-cleanup', '-metadir', path.join(dir, 'states'), 'RedBlueLoop.tla'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 })
  const log = (p.stdout || '') + (p.stderr || '')
  fs.writeFileSync(path.join(OUT, `red-blue-loop.${r.name}.tlc.log`), log)
  const states = (log.match(/(\d[\d,]*) distinct states found/) || [])[1] || '?'
  const clean = /Model checking completed\. No error has been found\./.test(log)
  const ok = r.expect === 'pass' ? clean : r.expect.test(log)
  failed ||= !ok
  report.runs.push({ name: r.name, mut: r.mut, bounds: `Sus=${r.sus.length} (Known=${r.known.length}), MaxRounds=${r.maxRounds}`, expect: r.expect === 'pass' ? 'pass' : `violation ${r.expect.source}`, ok, distinctStates: states, seconds: Number(process.hrtime.bigint() - t0) / 1e9 })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.expect === 'pass' ? (clean ? 'no error' : 'TLC reported an error') : ok ? 'violation found' : 'violation NOT found'} (${states} distinct states)`)
}
fs.writeFileSync(path.join(OUT, 'red-blue-loop.json'), JSON.stringify(report, null, 2))
console.log(failed ? 'TLC: FAILURES' : 'TLC: ALL PASS')
process.exit(failed ? 1 : 0)
