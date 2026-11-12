#!/usr/bin/env node
// Text check: engineering-review-loop tells every reviewer to read REVIEW.md first, and
// says it cannot lower a severity. (clanker-loop's copy is checked on the real prompt by scenario V1.)
//   T1 the shared TARGET text names REVIEW.md at the repository root, read first, citing C-REV-10.
//   T2 the same text says REVIEW.md cannot lower a severity, and names the fix-at-the-source rule.
//   T3 TARGET is passed to every dimension's review prompt (it is in reviewPrompt's list).
import fs from 'node:fs'
const WF = process.argv[2] || 'engineering-review-loop.js'
const src = fs.readFileSync(WF, 'utf8')
let failed = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ' - ' + detail}`); if (!ok) failed++ }
const at = src.indexOf('const TARGET = `')
const end = at < 0 ? -1 : src.indexOf('`', at + 16)
const target = at < 0 || end < 0 ? '' : src.slice(at, end)
check('T1 TARGET names REVIEW.md at the repository root, read first, C-REV-10', /If REVIEW\.md exists at the repository root, read it first \(C-REV-10\)/.test(target))
check('T2 TARGET says it cannot lower a severity and names fix at the source', /cannot lower a severity/.test(target) && /seen three times/.test(target))
const rp = src.slice(src.indexOf('function reviewPrompt('), src.indexOf('\n}', src.indexOf('function reviewPrompt(')))
check('T3 reviewPrompt includes TARGET for every dimension and role', /\bTARGET\b/.test(rp) && !/d === .* \? TARGET/.test(rp))
console.log(JSON.stringify({ property: 'every ERL reviewer prompt tells the reviewer to read REVIEW.md first and that it cannot lower a severity', tool: 'text check on the real file', bounds: { file: WF }, failures: failed }))
console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
process.exit(failed ? 1 : 0)
