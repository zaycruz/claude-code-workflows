export const meta = {
  name: 'gather-context',
  description: 'Alias of the research workflow, mode clarify: a local scout (read-only clanker) and an external researcher (Claude Sonnet, WebSearch/WebFetch) gather context in parallel, then a Claude Sonnet synthesis lists what we know and the clarifying questions that still matter. Read-only.',
  whenToUse: 'Alias of research mode clarify. At the start of a fuzzy task, to ground it and surface the questions to ask the user (the parent asks the returned questions with AskUserQuestion). Args: {intent (required), skipExternal?: bool}; checked here (unknown keys are rejected), then passed to research, which does all the work. Ported from Pi /gather-context-and-clarify.',
  phases: [
    { title: 'Gather', detail: 'Scout (local) and researcher (external) in parallel' },
    { title: 'Synthesize', detail: 'Known facts and open clarification questions' },
  ],
}

const A = args && typeof args === 'object' ? args : { intent: args }
const ALLOWED = ['intent', 'skipExternal']
const unknown = Array.isArray(A) ? ['(an array)'] : Object.keys(A).filter((k) => !ALLOWED.includes(k))
if (unknown.length) throw new Error(`gather-context: unknown arg(s) ${unknown.join(', ')}; allowed: ${ALLOWED.join(', ')}`)
return await workflow('research', { intent: A.intent, skipExternal: A.skipExternal, mode: 'clarify' })
