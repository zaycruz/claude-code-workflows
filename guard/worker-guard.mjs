#!/usr/bin/env node
// PreToolUse guard for the clanker-* agents (install.sh writes its path into their frontmatter
// hooks, so it runs only inside those subagents). A prompt rule does not hold a model; this does.
// Blocks: history writes and pushes, GitHub writes, secrets, remote shells, killing processes,
// publishing packages, and file writes outside the work tree. Exit 2 blocks the call and the
// reason on stderr goes back to the worker; exit 0 allows it. Any error blocks (fail closed).
// guard/guard.check.mjs lists how this can fail and checks each case.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SECRET_PATH = /(?:^|[\s/~'"=])\.ssh\/|\.aws\/credentials|\.netrc\b|\.git-credentials|\.config\/gh\/hosts\.yml|\.docker\/config\.json|\.npmrc\b|\.pypirc\b/
// git subcommands that write history, move refs or reach a remote.
const GIT_DENY = new Set(['push', 'commit', 'merge', 'rebase', 'tag', 'am', 'cherry-pick', 'revert', 'reset', 'update-ref', 'filter-branch', 'filter-repo', 'pull', 'fetch', 'send-email', 'notes', 'replace'])
// git global options that take the next token as their value.
const GIT_OPT_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
// Commands that only prefix another command.
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'sudo', 'nice', 'xargs', 'stdbuf', 'caffeinate'])
const GH_READ = { pr: ['view', 'list', 'diff', 'checks', 'status'], issue: ['view', 'list', 'status'], repo: ['view'], run: ['view', 'list', 'watch'] }

// The simple commands in a shell line, as token lists. Quotes, $( and backticks end a command too,
// so `sh -c "git push"` yields `git push` on its own. That is conservative: a quoted argument that
// reads like a blocked command is blocked as well.
function simpleCommands(line) {
  return line.replace(/\\\n/g, ' ').replace(/\$\(|[`'"(){};&|\n]/g, '\n').split('\n')
    .map((c) => c.trim().split(/\s+/).filter(Boolean)).filter((t) => t.length)
}

// Drops VAR=value assignments and wrapper commands (with their own flags and VAR=value) from the front.
function stripPrefixes(t) {
  let i = 0
  for (;;) {
    while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++
    if (i < t.length && WRAPPERS.has(path.basename(t[i]))) {
      const w = path.basename(t[i++])
      while (i < t.length && t[i].startsWith('-')) i++
      if ((w === 'nice' || w === 'timeout') && /^\d/.test(t[i] || '')) i++
      continue
    }
    if (i < t.length && path.basename(t[i]) === 'timeout') { i++; while (i < t.length && t[i].startsWith('-')) i++; if (/^\d/.test(t[i] || '')) i++; continue }
    return t.slice(i)
  }
}

function gitVerdict(args) {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i++]
    if (GIT_OPT_ARG.has(a)) i++
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (!sub) return null
  if (GIT_DENY.has(sub)) return `git ${sub} is not allowed: leave changes uncommitted, the coordinator merges them`
  if (sub === 'remote' && rest.length && !['-v', '--verbose', 'show', 'get-url'].includes(rest[0])) return `git remote ${rest[0]} is not allowed`
  if (sub === 'config' && rest.some((a) => /^(remote|url|credential|core\.sshcommand|core\.hookspath|include|includeif)\./i.test(a))) return 'changing git remote, url, credential or hook config is not allowed'
  if (sub === 'worktree' && rest[0] !== 'list') return `git worktree ${rest[0] || ''} is not allowed`.trim()
  if (sub === 'branch' && rest.some((a) => /^(-d|-D|--delete|-m|-M|--move|-f|--force)$/.test(a))) return 'deleting, moving or forcing branches is not allowed'
  if (sub === 'stash' && ['clear', 'drop'].includes(rest[0])) return `git stash ${rest[0]} is not allowed: the stash is shared with other worktrees`
  return null
}

function commandVerdict(t) {
  const [cmd0, ...args] = stripPrefixes(t)
  if (!cmd0) return null
  const prog = path.basename(cmd0)
  if (prog === 'git') return gitVerdict(args)
  if (prog === 'gh') {
    const [sub, act] = args
    return (GH_READ[sub] || []).includes(act) ? null : `gh ${[sub, act].filter(Boolean).join(' ')} is not allowed: GitHub is read-only here`
  }
  if (prog === 'op') return 'the 1Password CLI is not allowed'
  if (prog === 'security' && /password|dump-keychain|export/.test(args[0] || '')) return 'reading the keychain is not allowed'
  if (['ssh', 'scp', 'sftp', 'mosh', 'sshpass'].includes(prog)) return `${prog} is not allowed: no remote shells`
  if (['kill', 'pkill', 'killall'].includes(prog)) return `${prog} is not allowed: do not stop processes you did not start in this call`
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(prog) && args.some((a) => ['publish', 'login', 'adduser', 'token'].includes(a))) return `${prog} ${args.find((a) => ['publish', 'login', 'adduser', 'token'].includes(a))} is not allowed`
  if (prog === 'cargo' && ['publish', 'login', 'owner', 'yank'].includes(args[0])) return `cargo ${args[0]} is not allowed`
  if (prog === 'docker' && ['push', 'login'].includes(args[0])) return `docker ${args[0]} is not allowed`
  if (prog === 'twine' && args[0] === 'upload') return 'twine upload is not allowed'
  if (prog === 'gem' && args[0] === 'push') return 'gem push is not allowed'
  return null
}

const inside = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
const realOr = (p) => { try { return fs.realpathSync(p) } catch { return p } }
function nearestExisting(p) {
  for (;;) {
    if (fs.existsSync(p)) return p
    const up = path.dirname(p)
    if (up === p) return p
    p = up
  }
}

// Linked worktrees of the repo at cwd (not the main checkout): where a worker told to "work only
// inside <dir>" writes when its own cwd is the session's checkout.
function linkedWorktrees(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
    return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).slice(1)
  } catch { return [] }
}

function fileVerdict(file, cwd, ctx) {
  if (typeof file !== 'string' || !file) return 'no file path'
  const expanded = file === '~' || file.startsWith('~/') ? path.join(ctx.home, file.slice(1)) : file
  const target = path.resolve(cwd, expanded)
  const roots = [cwd, ...ctx.linkedWorktrees(cwd), ctx.tmp, '/tmp', '/private/tmp'].filter(Boolean).map((r) => path.resolve(r))
  if (!roots.some((r) => inside(target, r))) return `writing ${target} is not allowed: work only inside ${cwd} or a temp dir`
  // A symlinked directory must not lead out of the roots: the deepest existing part of the path,
  // resolved, must still be inside a root (or the root itself does not exist yet).
  const have = nearestExisting(target)
  const real = realOr(have)
  if (!roots.some((r) => inside(real, realOr(r)) || inside(r, have))) return `writing ${target} is not allowed: it resolves to ${real}, outside the work tree`
  return null
}

// The decision for one hook input: { block: true, reason } or { block: false }.
export function decide(input, ctx = { linkedWorktrees, home: os.homedir(), tmp: os.tmpdir() }) {
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string' || !input.tool_input || typeof input.tool_input !== 'object') return { block: true, reason: 'guard: malformed hook input' }
  const { tool_name: name, tool_input: ti } = input
  const cwd = path.resolve(typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd())
  if (name === 'Bash') {
    if (typeof ti.command !== 'string') return { block: true, reason: 'guard: Bash call without a command' }
    if (SECRET_PATH.test(ti.command)) return { block: true, reason: 'reading credential files is not allowed' }
    for (const t of simpleCommands(ti.command)) {
      const why = commandVerdict(t)
      if (why) return { block: true, reason: why }
    }
    return { block: false }
  }
  if (name === 'Read') return SECRET_PATH.test(String(ti.file_path || '')) ? { block: true, reason: 'reading credential files is not allowed' } : { block: false }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const why = fileVerdict(ti.file_path ?? ti.notebook_path, cwd, ctx)
    return why ? { block: true, reason: why } : { block: false }
  }
  return { block: false }
}

export function main() {
  let input
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')) } catch { process.stderr.write('guard: hook input is not JSON\n'); process.exit(2) }
  try {
    const d = decide(input)
    // Opt-in audit trail (the E2E reads it to tell a block from a model that declined). Best effort:
    // a failed write never changes the decision.
    if (process.env.CLANKER_GUARD_LOG) {
      try { fs.appendFileSync(process.env.CLANKER_GUARD_LOG, JSON.stringify({ agent: input.agent_type || '', tool: input.tool_name, input: input.tool_input, block: d.block, reason: d.reason || '' }) + '\n') } catch { /* see above */ }
    }
    if (d.block) { process.stderr.write(`blocked by the clanker guard: ${d.reason}\n`); process.exit(2) }
    process.exit(0)
  } catch (e) {
    process.stderr.write(`guard error, blocking: ${e && e.message}\n`)
    process.exit(2)
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main()
