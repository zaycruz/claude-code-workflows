#!/usr/bin/env node
// The kit's one backend line, and the config install.sh writes into it. Used by install.sh (CLI
// below) and by the harnesses (lib/stubs.mjs re-exports it).
//
//   node lib/workers-config.mjs resolve <saved.json|-> [--workers W] [--executor M] [--fallback M] [--checks C]
//       prints the resolved config as JSON, or exits 2 with the reason
//   node lib/workers-config.mjs render <config.json> <src.js>
//       prints src.js with its WORKERS line set to the config (unchanged when it has none)
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const WORKERS_LINE = /^const WORKERS = \{[^\n]*$/m
export const DEFAULTS = { backend: 'claude', executor: 'sonnet', fallback: 'opus', checks: 'claude' }
// Model names go into a JS string literal: letters, digits and . _ : / @ - only.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/

export const withBackend = (src, cfg) => src.replace(WORKERS_LINE, `const WORKERS = { backend: '${cfg.backend}', executor: '${cfg.executor}', fallback: '${cfg.fallback}', checks: '${cfg.checks}' } // install.sh --workers rewrites this line`)

// Flags over the saved config over the defaults. Choosing a backend resets the models to that
// backend's defaults unless they are given too; pi has no default model.
export function resolve(saved, flags) {
  const base = saved && typeof saved === 'object' ? saved : {}
  const backend = flags.workers ?? base.backend ?? DEFAULTS.backend
  if (!['claude', 'pi'].includes(backend)) throw new Error(`--workers must be claude or pi, not ${JSON.stringify(backend)}`)
  const keep = flags.workers === undefined || flags.workers === base.backend
  let executor = flags.executor ?? (keep ? base.executor : undefined)
  let fallback = flags.fallback ?? (keep && flags.executor === undefined ? base.fallback : undefined)
  if (backend === 'claude') { executor ??= DEFAULTS.executor; fallback ??= executor === DEFAULTS.executor ? DEFAULTS.fallback : executor }
  if (backend === 'pi') {
    if (!executor) throw new Error('--workers pi needs --executor <model> (the pi model pattern your workers run on)')
    fallback ??= executor
  }
  const checks = flags.checks ?? (flags.workers === undefined ? base.checks : undefined) ?? DEFAULTS.checks
  if (!['claude', 'runner'].includes(checks)) throw new Error(`--checks must be claude or runner, not ${JSON.stringify(checks)}`)
  for (const [k, v] of [['executor', executor], ['fallback', fallback]]) if (!MODEL.test(v)) throw new Error(`--${k} ${JSON.stringify(v)} is not a model name (letters, digits and . _ : / @ - only)`)
  return { backend, executor, fallback, checks }
}

function cli(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'render') {
    const [cfgPath, src] = rest
    process.stdout.write(withBackend(fs.readFileSync(src, 'utf8'), JSON.parse(fs.readFileSync(cfgPath, 'utf8'))))
    return
  }
  if (cmd === 'resolve') {
    const [savedPath, ...opts] = rest
    let saved = null
    if (savedPath && savedPath !== '-' && fs.existsSync(savedPath)) saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'))
    const flags = {}
    for (let i = 0; i < opts.length; i++) {
      const m = /^--(workers|executor|fallback|checks)$/.exec(opts[i])
      if (!m) throw new Error(`unknown option ${opts[i]}`)
      if (i + 1 >= opts.length) throw new Error(`${opts[i]} needs a value`)
      flags[m[1]] = opts[++i]
    }
    process.stdout.write(JSON.stringify(resolve(saved, flags)) + '\n')
    return
  }
  throw new Error('usage: workers-config.mjs resolve <saved.json|-> [flags] | render <config.json> <src.js>')
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { cli(process.argv.slice(2)) } catch (e) { process.stderr.write(`install: ${e.message}\n`); process.exit(2) }
}
