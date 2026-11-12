#!/usr/bin/env node
// Bounded text check: the performance dimension of engineering-review-loop.js and the
// perf-checklist skill carry the same twelve points, in the same order, each as a numbered line, and the
// dimension's prompt text reaches the reviewer unchanged (the scope is a plain template with no ${}).
// Properties:
//   T1 the ERL performance scope lists the twelve points as lines "N. <point>:" for N = 1..12, in order.
//   T2 the skill file lists the same twelve, same order, same numbering.
//   T3 the scope template holds no interpolation, so the text the reviewer gets is the text in the file.
// Usage: node harness/perf-checklist.check.mjs [engineering-review-loop.js] [path to SKILL.md]
import fs from 'node:fs'

const WF = process.argv[2] || 'engineering-review-loop.js'
const SKILL = process.argv[3] || process.env.PERF_SKILL || ''
const POINTS = ['Sequential vs concurrent', 'Number of passes', 'Allocations', 'Batching vs streaming', 'Work while awaiting', 'Early exit', 'Thread count', 'Data structures', 'I/O count', 'Leaks', 'Pools', 'Races']
let failed = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`); if (!ok) failed++ }
const numbered = (text) => text.split('\n').map((l) => l.match(/^(\d+)\. ([^:]+):/)).filter(Boolean).map((m) => [Number(m[1]), m[2].trim()])

const src = fs.readFileSync(WF, 'utf8')
const at = src.indexOf('  performance: {')
const end = src.indexOf('    duty:', at)
const scope = at < 0 || end < 0 ? '' : src.slice(at, end)
const got = numbered(scope)
check('T1 the performance scope lists the twelve points in order', JSON.stringify(got) === JSON.stringify(POINTS.map((p, i) => [i + 1, p])), JSON.stringify(got))
check('T3 the scope template has no interpolation', scope.length > 0 && !scope.includes('${'))

let skill = ''
// The skill lives outside this repo. Without a path (argument or PERF_SKILL) or the file, T2 is
// skipped and said so.
try { skill = SKILL ? fs.readFileSync(SKILL, 'utf8') : '' } catch { /* reported below */ }
if (!skill) console.log(`skip T2 no perf-checklist skill file${SKILL ? ` at ${SKILL}` : ' given (set PERF_SKILL)'}`)
if (skill) {
  const sk = numbered(skill)
  check('T2 the skill lists the same twelve points in the same order', JSON.stringify(sk) === JSON.stringify(got) && sk.length === 12, JSON.stringify(sk))
  check('T2 the skill names the workflow and the workflow names the skill', /engineering-review-loop/.test(skill) && /perf-checklist skill/.test(scope))
}
console.log(JSON.stringify({ property: 'the ERL performance dimension and the perf-checklist skill carry the same twelve numbered points, in order, with no interpolation in the scope', tool: 'text check on the real files', bounds: { points: POINTS.length, files: [WF, SKILL] }, failures: failed }))
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
