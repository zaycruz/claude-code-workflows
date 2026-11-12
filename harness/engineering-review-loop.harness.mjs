import fs from 'fs'
import { PI, CHECKS, loadWorkflowBody, runBody } from '../lib/stubs.mjs'
// Scripted-agent harness for the engineering-review-loop controller. Workflow path: WF env var,
// default $HOME/.claude/workflows/engineering-review-loop.js.
// agent() is faked three ways, all keyed by the agent label:
//   - Claude roles (agentType 'Plan')   -> the scenario's schema object, as-is.
//   - clankers (agentType pi-agent-for-claude:pi) -> text + one ```json block + a pi footer built from
//     the prompt's pi-model:/pi-workdir: lines. A null scenario return answers WITHOUT the footer,
//     which is a failed clanker (and makes a the executor call fall back to the fallback).
//   - checks runner (agentType checks-runner:checks) -> headline + JSON report + checks footer, shaped
//     by the per-scenario table C below. No footer = the runner was unavailable.
// A scenario that returns a STRING for a clanker label answers that prose, with the footer and no
// ```json block at all: the step is recorded as unparsed rather than as a failed clanker.
// Usage: node engineering-review-loop.harness.mjs <scenario> ['{"maxRounds":3}']   (see run-all.sh)
const [scenario, extra] = process.argv.slice(2)
const WF = process.env.WF || process.env.HOME + '/.claude/workflows/engineering-review-loop.js'
const body = loadWorkflowBody(fs.readFileSync(WF,'utf8'))
const bug = { severity:'BLOCKER', file:'src/a.js', line:3, title:'null deref', evidence:'e', fix:'guard' }
const bug2 = { severity:'BLOCKER', file:'./src/b.js:9', line:9, title:'O(n^2) loop', evidence:'e', fix:'use map' }
const G = {quality:'GREEN',functional:'GREEN',performance:'GREEN'}
const rev = (o={}) => ({summary:'ok',findings:[],verification:[],checksRun:[],...o})
const fpeer = (pass=true, o={}) => rev({checksRun:[{kind:'test',command:'npm test',exitCode:pass?0:1},{kind:'other',command:'rg TODO',exitCode:1}],testsPassing:pass,noTestsReason:'',...o})
const cons = (findings, verification=[], st=G, o={}) => ({summary:'c',findings,rejected:[],verification,dimensionStatus:st,workingTree:['src/a.js','src/b.js'],...o})
const eng = (ids, files, disp='FIXED', o={}) => ({summary:'e',addressed:ids.map(id=>({id,disposition:disp,...o})),filesChanged:files,validation:[]})
const implw = (ids, files) => ({summary:'impl',addressed:ids.map(id=>({id,disposition:'FIXED'})),filesChanged:files,validation:[]})
const imp = (t) => ({severity:'IMPROVE',dimension:'performance',file:'src/'+t+'.js',line:1,title:'improve '+t,evidence:'e',fix:'f',sources:[]})
const logAll = (p) => { const keys=[...p.matchAll(/"key": "(U\d+)"/g)].map(m=>m[1]); globalThis.LOGGED=keys.length; return {tracker:'beads',filed:keys.map(k=>({key:k,status:'created',ref:'bd-'+k}))} }
const R = (l) => +l.slice(1, l.indexOf(':'))
// One blocker in round 1, fixed, verified resolved in round 2.
const fixB1 = (r) => r===1 ? cons([{...bug,dimension:'functional',sources:['x']}],[],{...G,functional:'RED'}) : cons([],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}])
const engFix = () => eng(['B1.1'],['src/a.js'])
// A blocker in round 1 whose fix must be edited in a directory only the consolidator can name, because
// the checks runner is unavailable: cons returns repoRoot and table C decides whether root-verify confirms it.
const consRoot1 = (l, p = '') => base(l, (r) => r === 1 ? cons([{...bug, dimension: 'functional', sources: ['x']}], [], { ...G, functional: 'RED' }, { repoRoot: '/w/repo' }) : cons([], [{ id: 'B1.1', status: 'RESOLVED', evidence: 'ok' }]), engFix, p)
const base = (l, cfn, efn, p='') => {
  if (l.endsWith(':consolidate')) return cfn(R(l))
  if (l.includes('engineer')) return efn(R(l), l)
  if (l.startsWith('implement')) return implw(['W1'],['src/a.js'])
  if (l.startsWith('log-improvements')) return logAll(p)
  if (l.includes(':functional:peer') && !l.endsWith('-x')) return fpeer()
  if (l.endsWith('-x')) return {responses:[],newFindings:[]}
  return rev()
}
const S = {
  green: (l,p) => base(l, fixB1, engFix, p),
  // The checks runner was unavailable: the functional peer (default fpeer above) is the only source of
  // test evidence left, and it says the tests it ran passed.
  checksdown: (l,p) => base(l, fixB1, engFix, p),
  // Every executor pi answer is refused; the fallback (label `<x>:fallback`) gives the same answer.
  executordown: (l,p) => /^pi-model: example\/open/.test(p) ? null : base(l, fixB1, engFix, p),
  // args.task + an implementer that reports no files + round-1 checks saw nothing change.
  implnoop: (l,p) => l.startsWith('implement') ? implw([],[]) : base(l, () => cons([]), () => null, p),
  // Same, but the only changed path is protected (.github/), so nothing was editable.
  protectedonly: (l,p) => l.startsWith('implement') ? implw([],[]) : base(l, () => cons([]), () => null, p),
  // The implementer's filesChanged is a string, not an array (jsonTail only checks required keys).
  strfiles: (l,p) => l.startsWith('implement') ? {...implw(['W1'],[]), filesChanged:'src/a.js'} : base(l, fixB1, engFix, p),
  // The checks runner fails in round 1, passes later. The functional peer still claims testsPassing
  // true, so this also covers the old liar/noclaim/bench1 case: a peer claim cannot outrun the runner.
  testsfail: (l,p) => base(l, r => r===1 ? cons([]) : cons([],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]), () => eng(['B1.1'],['src/a.js']), p),
  // The checks runner found no tests at all.
  untested: (l,p) => base(l, () => cons([]), () => null, p),
  // The implementer claims a file; the round-1 checks report shows nothing changed. The checks report
  // alone decides: implement-noop, plus an integrity entry naming the claim that was not the tree.
  implclaim: (l,p) => base(l, () => cons([]), () => null, p),
  // The runner is unavailable and no repo arg was given, so the consolidator's repoRoot is the only
  // thing that can name the directory the engineers edit.
  checksdownroot: (l,p) => base(l, r => r===1 ? cons([{...bug,dimension:'functional',sources:['x']}],[],{...G,functional:'RED'},{repoRoot:'/w/repo'}) : cons([],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]), engFix, p),
  // Same, but the consolidator names no root either: nothing may edit anything, so the round stops.
  checksdownnoroot: (l,p) => base(l, fixB1, engFix, p),
  // The runner never answers, so the consolidator's repoRoot is the only candidate; its root-verify
  // run (table C) confirms '/w/repo', which is what the engineer must then be given.
  "rootverify-ok": (l, p) => consRoot1(l, p),
  // The consolidator names '/home/dev'; the root-verify report names the real toplevel '/w/repo':
  // the runner's root is adopted and the run continues there (fix batch G; before it this was no-root).
  "rootverify-bad": (l, p) => base(l, r => r===1 ? cons([{...bug,dimension:'functional',sources:['x']}],[],{...G,functional:'RED'},{repoRoot:'/home/dev'}) : cons([],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]), engFix, p),
  // The consolidator names '/w/repo' but the verify call itself is unavailable: the verify report has
  // no root, so the candidate is never adopted and nothing may be edited.
  "rootverify-none": (l, p) => consRoot1(l, p),
  // The consolidator's root passes root-verify, then round 2's own report names a different toplevel:
  // one of the two is wrong, so the run stops as no-root with a rootConflict integrity entry.
  rootconflict: (l, p) => consRoot1(l, p),
  // The checks answer carries the footer but its report has no `changed` list: unreadable evidence,
  // which is the same missing evidence as no footer, not a failing build.
  badreport: (l, p) => consRoot1(l, p),
  // Same, with a footered answer that holds no JSON at all, and one whose `checks` is a string: both
  // are unreadable, so both must read as unavailable checks, never as a failing build.
  "checks-noreport": (l, p) => consRoot1(l, p),
  "checks-badchecks": (l, p) => consRoot1(l, p),
  // The runner is unavailable and the functional peer claims its tests passed while its checksRun holds
  // only a kind 'other' command: no build or test entry backs the claim, so testsPassing drops to null
  // and the best the run can do is green-untested.
  "checksdown-liar": (l, p) => (l.includes(':functional:peer') && !l.endsWith('-x')
    ? (peerLied = true, rev({ checksRun: [{ kind: 'other', command: 'rg -n TODO src', exitCode: 0 }], testsPassing: true, noTestsReason: '' }))
    : base(l, fixB1, engFix, p)),
  // The round-1 engineer answers prose: footer present, no ```json block. The step is recorded as
  // unparsed (its tail kept as the summary) and the loop carries on instead of throwing.
  "clanker-prose": (l, p) => (l.includes('engineer') && R(l) === 1
    ? 'I could not put this in JSON. I edited src/a.js by hand and it works now.'
    : base(l, fixB1, engFix, p)),
  // An engineer's addressed items arrive with a numeric id and otherFiles as a string. Both the
  // WONT-FIX id check and the NEEDS-OTHER-FILES otherFiles map must survive them.
  badaddressed: (l,p) => l.includes('engineer') ? {summary:'e',addressed:[{id:1,disposition:'WONT-FIX-NEEDS-DECISION',how:'pick API shape',otherFiles:'src/b.js'},{id:2,disposition:'NEEDS-OTHER-FILES',otherFiles:'src/b.js'}],filesChanged:['src/a.js'],validation:[]} : base(l, r => cons(r===1?[{...bug,dimension:'quality',sources:[]}]:[], r>1?[{id:`B${r-1}.1`,status:'NOT-RESOLVED',evidence:'x'}]:[], {...G,quality:'RED'}), () => null, p),
  consred: (l,p) => base(l, () => cons([],[],{...G,performance:'RED'}), () => null, p),
  // Convergence. The consolidator's only BLOCKER is scope pre-existing: it is reported,
  // never opened, no engineer runs, and the run is green in one round.
  preexisting: (l,p) => base(l, () => cons([{...bug,scope:'pre-existing',dimension:'functional',sources:['x']}]), () => null, p),
  // Round 2 verifies B1.1 RESOLVED and, in the same report, re-reports the same defect (same file and
  // title, no priorId) as a fresh BLOCKER: the re-report is suppressed and the run is green in round 2.
  closedrereport: (l,p) => base(l, r => r===1 ? cons([{...bug,dimension:'functional',sources:['x']}],[],{...G,functional:'RED'}) : cons([{...bug,dimension:'functional',sources:['y']}],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]), engFix, p),
  // Round 1's consolidator rejects the adversary's 'sql injection' with a reason; round 2 re-reports it
  // as a fresh BLOCKER: closed by key, so suppressed, and the run is green once B1.1 is resolved.
  rejectedrereport: (l,p) => {
    if (l==='r1:quality:adversary') return rev({findings:[{...bug,title:'sql injection'}]})
    return base(l, r => r===1 ? cons([{...bug,dimension:'functional',sources:['x']}],[],{...G,functional:'RED'},{rejected:[{ref:'quality.A1',reason:'parameterised already; false positive'}]}) : cons([{...bug,title:'sql injection',dimension:'quality',sources:['z']}],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]), engFix, p)
  },
  handoff: (l,p) => base(l, r => r===1 ? cons([{...bug,dimension:'functional',sources:[]}],[],{...G,functional:'RED'})
      : r===2 ? cons([],[{id:'B1.1',status:'NOT-RESOLVED',evidence:'needs b'}],{...G,functional:'RED'})
      : cons([],[{id:'B2.1',status:'RESOLVED',evidence:'ok'}]),
    (r) => r===1 ? eng(['B1.1'],[],'NEEDS-OTHER-FILES',{otherFiles:['src/b.js']}) : eng(['B2.1'],['src/a.js','src/b.js']), p),
  dropped: (l,p) => {
    if (l==='r1:quality:adversary') return rev({findings:[{...bug,title:'sql injection'}]})
    if (l.startsWith('r2:') && l.includes('quality:adversary')) return rev({verification:[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]})
    return base(l, r => r===1 ? cons([]) : cons([],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]), () => eng(['B1.1'],['src/a.js']), p)
  },
  deferred: (l,p) => base(l, r => cons(r===1?[{...bug,dimension:'quality',sources:[]}]:[], r>1?[{id:`B${r-1}.1`,status:'NOT-RESOLVED',evidence:'x'}]:[], {...G,quality:'RED'}),
    (r) => eng([`B${r}.1`],['src/a.js'],'WONT-FIX-NEEDS-DECISION',{how:'pick API shape'}), p),
  stuck: (l,p) => base(l, r => cons(r===1?[{...bug,dimension:'quality',sources:[]}]:[], r>1?[{id:`B${r-1}.1`,status:'NOT-RESOLVED',evidence:'x'}]:[], {...G,quality:'RED'}), () => eng([],['src/a.js']), p),
  rereport: (l,p) => base(l, r => cons([{...bug,dimension:'quality',sources:[],...(r>1?{priorId:`B${r-1}.1`}:{})}], r>1?[{id:`B${r-1}.1`,status:'NOT-RESOLVED',evidence:'x'}]:[], {...G,quality:'RED'}), () => eng([],['src/a.js']), p),
  revfail: (l,p) => (l.startsWith('r1:performance:peer') ? null : base(l, () => cons([]), () => null, p)),
  consfail: (l,p) => base(l, () => null, () => null, p),
  parallel3: (l,p) => base(l, r => r===1 ? cons([{...bug,dimension:'quality',sources:[]},{...bug2,dimension:'performance',sources:[]},{...bug,file:'src/c.js',title:'c',dimension:'functional',sources:[]}],[],{quality:'RED',functional:'RED',performance:'RED'})
      : cons([],['B1.1','B1.2','B1.3'].map(id=>({id,status:'RESOLVED',evidence:'ok'}))), (r) => eng(['B1.1','B1.2','B1.3'],['src/a.js']), p),
  badpath: (l,p) => base(l, r => r===1 ? cons([{...bug,file:'.git/hooks/pre-commit',dimension:'quality',sources:[]},{...bug,file:'/etc/passwd',title:'p',dimension:'quality',sources:[]},{...bug2,dimension:'performance',sources:[]}],[],{...G,quality:'RED',performance:'RED'}) : cons([],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]), () => eng(['B1.1'],['src/b.js']), p),
  absroot: (l,p) => base(l, r => r===1 ? cons([{...bug,file:'/w/repo/src/a.js',dimension:'quality',sources:[]}],[],{...G,quality:'RED'}) : cons([],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]), () => eng(['B1.1'],['/w/repo/src/a.js']), p),
  crossdrop: (l,p) => {
    if (l==='r1:quality:peer') return rev({findings:[{...bug,severity:'NOTE',title:'n'}]})
    if (l==='r1:quality:adversary-x') return {responses:[{ref:'quality.P1',stance:'CONFIRM',evidence:'y'}],newFindings:[{...bug2,title:'race found in cross'}]}
    return base(l, r => r===1 ? cons([],[],G,{rejected:[{ref:'quality.P1',reason:'nit'}]}) : cons([],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]), () => eng(['B1.1'],['src/b.js']), p)
  },
  impfinal: (l,p) => l==='log-improvements' ? logAll(p) : base(l, () => cons([imp('a'),imp('b')]), () => null, p),
  impcap: (l,p) => {
    if (l==='log-improvements') return logAll(p)
    if (l.includes('engineer')) return {summary:'e',addressed:[{id:'B1.1',disposition:'FIXED'},{id:'I1.1',disposition:'FIXED'},{id:'I1.2',disposition:'PARTIAL'}],filesChanged:['src/a.js'],validation:[]}
    return base(l, r => r===1 ? cons([{...bug,dimension:'quality',sources:[]}, ...'1234567'.split('').map(imp)],[],{...G,quality:'RED'}) : cons([imp('late')],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]), () => null, p)
  },
  impnone: (l,p) => l==='log-improvements' ? logAll(p) : base(l, () => cons([imp('a')]), () => null, p),
  implogfail: (l,p) => l.startsWith('log-improvements') ? null : base(l, () => cons([imp('a')]), () => null, p),
  impnobeads: (l,p) => l==='log-improvements' ? {tracker:'none-available',filed:[{key:'U1',status:'skipped'}]} : base(l, () => cons([imp('a')]), () => null, p),
  collide: (l,p) => {
    if (l==='log-improvements') return logAll(p)
    if (l.includes('engineer')) return {summary:'e',addressed:[{id:'B1.1',disposition:'FIXED'},{id:'I1.1',disposition:'PARTIAL'},{id:'I1.2',disposition:'FIXED'}],filesChanged:['src/a.js'],validation:[]}
    return base(l, r => r===1 ? cons([{...bug,dimension:'quality',sources:[]},{...imp('x'),line:10,title:'Extract helper'},{...imp('x'),line:200,title:'Extract helper'}],[],{...G,quality:'RED'}) : cons([],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]), () => null, p)
  },
  r2fail: (l,p) => {
    if (l==='log-improvements') return logAll(p)
    if (l.startsWith('r2:') && !l.includes('consolidate')) return null
    if (l.includes('engineer')) return {summary:'e',addressed:[{id:'B1.1',disposition:'FIXED'},{id:'I1.1',disposition:'FIXED'}],filesChanged:['src/a.js'],validation:[]}
    return base(l, r => cons([{...bug,dimension:'quality',sources:[]},imp('done')],[],{...G,quality:'RED'}), () => null, p)
  },
  refimp: (l,p) => {
    if (l==='log-improvements') return logAll(p)
    if (l.includes('engineer')) return eng(['B1.1'],['src/a.js'])
    return base(l, r => r===1 ? cons([{...bug,dimension:'quality',sources:[]},{...imp('z'),file:'/etc/hosts'}],[],{...G,quality:'RED'}) : cons([],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}]), () => null, p)
  },
  noref: (l,p) => l==='log-improvements' ? {tracker:'beads',filed:[{key:'U1',status:'created'}]} : base(l, () => cons([imp('a')]), () => null, p),
  moved: (l,p) => {
    if (l==='log-improvements') return logAll(p)
    if (l==='r1:engineer-1' || l==='r1:engineer-2') return {summary:'e',addressed:[{id:'B1.1',disposition:'FIXED'},{id:'I1.1',disposition:'PARTIAL'}],filesChanged:['src/a.js'],validation:[]}
    if (l.includes('engineer')) return {summary:'e',addressed:[{id:'B2.1',disposition:'FIXED'},{id:'I2.1',disposition:'FIXED'}],filesChanged:['src/a.js'],validation:[]}
    return base(l, r => r===1 ? cons([{...bug,dimension:'quality',sources:[]},{...imp('m'),line:10,title:'Extract helper'}],[],{...G,quality:'RED'})
      : r===2 ? cons([{...bug,title:'other',dimension:'quality',sources:[]},{...imp('m'),line:14,title:'Extract helper'}],[{id:'B1.1',status:'RESOLVED',evidence:'ok'}],{...G,quality:'RED'})
      : cons([],[{id:'B2.1',status:'RESOLVED',evidence:'ok'}]), () => null, p)
  },
}
// Per-scenario control of the checks runner: (label, round) -> { verdict, changed, root, dir }.
// verdict 'unavailable' answers without the footer. `changed` defaults to the files the clankers
// reported so far (or one file), as paths relative to the git root.
const C = {
  testsfail: (l, r) => ({ verdict: r === 1 ? 'fail' : 'pass' }),
  untested: () => ({ verdict: 'none' }),
  checksdown: () => ({ verdict: 'unavailable' }),
  implnoop: (l) => ({ changed: l === 'r1:checks' ? [] : undefined }),
  protectedonly: (l) => ({ changed: l === 'r1:checks' ? ['.github/workflows/ci.yml'] : undefined }),
  implclaim: (l) => ({ changed: l === 'r1:checks' ? [] : undefined }),
  // Root-verify is the one checks call that must answer, or no clanker gets a directory at all.
  checksdownroot: (l) => (l.endsWith(':root-verify') ? { root: '/w/repo' } : { verdict: 'unavailable' }),
  checksdownnoroot: () => ({ verdict: 'unavailable' }),
  badreport: (l) => (l.endsWith(':root-verify') ? { root: '/w/repo' } : { broken: true }),
  "checks-noreport": (l) => (l.endsWith(':root-verify') ? { root: '/w/repo' } : { noJson: true }),
  "checks-badchecks": (l) => (l.endsWith(':root-verify') ? { root: '/w/repo' } : { badChecks: true }),
  "rootverify-ok": (l) => (l.endsWith(':root-verify') ? { root: '/w/repo' } : { verdict: 'unavailable' }),
  // The candidate was '/home/dev'; the runner reports the real toplevel instead, and it is adopted.
  "rootverify-bad": (l) => (l.endsWith(':root-verify') ? { root: '/w/repo' } : { verdict: 'unavailable' }),
  // Even the root-verify run is unavailable: no verify report, no root, no-root.
  "rootverify-none": () => ({ verdict: 'unavailable' }),
  rootconflict: (l) => (l.endsWith(':root-verify') ? { root: '/w/repo' } : l.startsWith('r2:') ? { root: '/other/repo' } : { verdict: 'unavailable' }),
  "checksdown-liar": () => ({ verdict: 'unavailable' }),
}
let engFiles = []
let curRound = 0
// Set when a functional peer answered testsPassing true with no build/test command behind it.
let peerLied = false
// A clanker answer: body, one json block, then the footer naming the model and the directory it ran in.
// A string scenario answer is prose: the same footer with no json block.
const piText = (obj, p) => {
  if (obj === null || obj === undefined) return 'the clanker did not answer'
  const model = (p.match(/^pi-model: (.+)$/m) || [, 'example/open-model'])[1].trim()
  const dir = (p.match(/^pi-workdir: (.+)$/m) || [, ''])[1].trim()
  const body = typeof obj === 'string' ? obj : `done\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``
  return `${body}\n— answered by pi [sandbox: ${dir}], ${model}`
}
const checksAnswer = (label) => {
  const m = label.match(/^r(\d+):checks$/); if (m) curRound = +m[1]
  const s = ((C[scenario] || (() => ({verdict:'pass'})))(label, m ? +m[1] : curRound) || {})
  const verdict = s.verdict || 'pass'
  if (verdict === 'unavailable') return 'the checks runner did not answer'
  const paths = (s.changed === undefined ? (engFiles.length ? engFiles : ['src/a.js']) : s.changed)
    .map((p) => (typeof p === 'string' ? { status: 'M', path: p } : p))
  const root = s.root || '/w/repo'
  const dir = s.dir || root
  // A footered answer whose body holds no JSON at all: unreadable, so unavailable, not a failing build.
  if (s.noJson) return `CHECKS PASS - 1/1 passed, 1s\n(no report)\n— answered by checks [sandbox: ${dir}], deterministic`
  if (s.broken) return `CHECKS PASS - 1/1 passed, ${paths.length} changed file(s), 1s\n${JSON.stringify({ dir, root, diffStat: `${paths.length} files changed`, commands: ['npm test'], setup: [], checks: [], verdict: 'pass' })}\n— answered by checks [sandbox: ${dir}], deterministic`
  const ran = verdict === 'none' ? [] : [{ kind: 'check', cmd: 'npm test', ok: verdict === 'pass', exit: verdict === 'pass' ? 0 : 1, seconds: 1, failures: verdict === 'pass' ? [] : ['FAIL src/a.js'], tail: 'Tests failed' }]
  const rep = { dir, root, changed: paths, diffStat: `${paths.length} files changed`, commands: ['npm test'], setup: [], checks: ran, verdict }
  if (s.badChecks) rep.checks = 'x'
  rep.head = `CHECKS ${verdict.toUpperCase()} - ${ran.filter((x) => x.ok).length}/${ran.length} passed, ${paths.length} changed file(s), 1s`
  return `${rep.head}\n${JSON.stringify(rep)}\n— answered by checks [sandbox: ${dir}], deterministic`
}
const calls=[]; const pk=[]; const wd=[]; const ckCalls=[]
// Engineer prompts containing this string are reported in the HARNESS_JSON line (HARNESS_PROBE).
const probe = process.env.HARNESS_PROBE || ''
const probeHits = []
const agent = async (p, o) => {
  calls.push(o.label); if (o.label.includes('engineer')) pk.push(o.label+'{'+(p.split('YOUR FILES:\n')[1]||'').split('\n').slice(1).join(',').split(',UNTRUSTED>>>')[0]+'}');
  if (probe && o.label.includes('engineer') && p.includes(probe)) probeHits.push(o.label);
  if (o.agentType === CHECKS) { ckCalls.push(o.label); return checksAnswer(o.label) }
  const obj = S[scenario](o.label, p)
  if (o.agentType === PI) {
    wd.push((p.match(/^pi-workdir: (.+)$/m) || [, '(none)'])[1].trim())
    if (obj && Array.isArray(obj.filesChanged)) engFiles = [...new Set([...engFiles, ...obj.filesChanged.filter((x) => typeof x === 'string')])]
    return piText(obj, p)
  }
  return obj
}
const parallel = async (t) => Promise.all(t.map(x=>x()))
const pipeline = async (items, ...st) => Promise.all(items.map(async (it,i)=>{ let v=it; for (const s of st) { try { v = await s(v,it,i) } catch(e){ console.log('STAGE THROW',e.stack); return null } } return v }))
const log = ()=>{}; const phase = ()=>{}
const r = await runBody(body, { args: extra ? JSON.parse(extra) : {maxRounds:3}, agent, parallel, pipeline, log, phase })
const summary = {
  scenario, verdict: r.verdict, needsParent: r.needsParentDecision, rounds: r.reviewRounds,
  unapplied: (r.unappliedImprovements || []).length, untracked: (r.untrackedImprovements || []).length,
  refused: (r.refusedPaths || []).length, unappliedFiles: (r.unappliedImprovements || []).map((u) => u.file),
  tests: r.testsPassing, integrity: r.integrity || [], workdirs: [...new Set(wd)],
  // Any pi call pointed at a directory other than the test repository: an edit outside the repo.
  workdirsOutside: [...new Set(wd.filter((x) => x !== '(none)' && !x.startsWith('/w/repo')))],
  // The peer lied about tests and the cross-check dropped the claim (testsPassing never came back true).
  liarFired: peerLied && r.testsPassing !== true,
  // Rounds in which at least one engineer call was made; a stopped run must show no later round here.
  engRounds: [...new Set(pk.map((x) => x.split(':')[0]))],
  checksVerdicts: (r.loop || []).map((h) => h.checks && h.checks.verdict).filter(Boolean),
  checksCalls: ckCalls,
  engineers: pk,
  openBlockers: (r.loop || []).flatMap((h) => (h.openBlockers || []).map((b) => `r${h.round}:${b.id}:${b.file}:${b.title}:${b.source}`)),
  engSteps: (r.loop || []).flatMap((h) => (h.engineers || []).map((e) => `r${h.round}:e${e.engineer}:${e.error ? 'failed' : (e.filesChanged || []).length + 'f:' + String(e.summary || '').slice(0, 32)}`)),
  probeHits,
  preExisting: (r.preExisting || []).length, suppressed: (r.suppressed || []).length, closed: (r.closed || []).map((c) => c.id), rethink: !!r.rethink,
}
if (process.env.HARNESS_JSON) { console.log(JSON.stringify(summary)); process.exit(0) }
console.log(scenario.padEnd(9), (r.verdict||'').padEnd(22), 'rounds='+r.reviewRounds, 'tests='+r.testsPassing, 'needsParent='+r.needsParentDecision, 'open='+r.openBlockers.map(b=>b.id+(b.carriedFrom?'<'+b.carriedFrom:'')+':'+b.source+(b.deferred?'(deferred)':'')).join(','), 'agents='+calls.length)
if (r.integrity && r.integrity.length) console.log('          integrity:', JSON.stringify(r.integrity))
if (r.unappliedImprovements && r.unappliedImprovements.length) console.log('          unapplied:', r.unappliedImprovements.map(u=>u.key+'('+u.file+' '+u.title.replace('improve ','')+': '+u.reason+')').join(' | '), '| logged='+(globalThis.LOGGED??'-'), 'untracked='+r.untrackedImprovements.length, r.escalationReason||'')
if (pk.length) console.log('          engineers:', pk.join(' '))
