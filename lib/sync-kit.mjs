#!/usr/bin/env node
// Replaces the clanker kit block in each workflow file with the exact (trimmed) contents of
// lib/clanker-kit.js, so every copy stays byte-identical (what wf-smoke.mjs checks).
//
//   node lib/sync-kit.mjs [files...]     no args: every *.js workflow in the repo root
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const KIT = fs.readFileSync(path.join(HERE, 'clanker-kit.js'), 'utf8').trim()
const START = '// ---- clanker kit v3'
const END = '// ---- end clanker kit ----'

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(ROOT).filter((f) => f.endsWith('.js') && fs.readFileSync(path.join(ROOT, f), 'utf8').includes(START))

let changed = 0
for (const f of files) {
  const p = path.resolve(ROOT, f)
  if (!fs.existsSync(p)) { console.log(`SKIP ${f}: not found`); continue }
  const src = fs.readFileSync(p, 'utf8')
  const a = src.indexOf(START)
  const b = src.indexOf(END)
  if (a < 0 || b < a) { console.log(`SKIP ${f}: no clanker kit block`); continue }
  const out = src.slice(0, a) + KIT + src.slice(b + END.length)
  if (out === src) { console.log(`ok    ${f}`); continue }
  fs.writeFileSync(p, out)
  changed++
  console.log(`synced ${f}`)
}
console.log(changed ? `${changed} file(s) changed` : 'no changes')
