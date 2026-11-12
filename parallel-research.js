export const meta = {
  name: 'parallel-research',
  description: 'Alias of the research workflow, mode answer: parallel fresh-context research on a question or decision - read-only clankers gather local evidence and curl web sources; Claude Sonnet does the WebSearch/WebFetch research and the synthesis, with disagreements called out. Custom angles run on clankers, which use curl for web access. Read-only.',
  whenToUse: 'Alias of research mode answer. Grounding an answer or decision in sources and the local codebase. Args: {question (required), angles?: string[]}; checked here (unknown keys are rejected), then passed to research, which does all the work. Ported from Pi /parallel-research.',
  phases: [
    { title: 'Research', detail: 'One agent per angle, in parallel' },
    { title: 'Synthesize', detail: 'What we know, local implications, tradeoffs, gaps, next move' },
  ],
}

const A = args && typeof args === 'object' ? args : { question: args }
const ALLOWED = ['question', 'angles']
const unknown = Array.isArray(A) ? ['(an array)'] : Object.keys(A).filter((k) => !ALLOWED.includes(k))
if (unknown.length) throw new Error(`parallel-research: unknown arg(s) ${unknown.join(', ')}; allowed: ${ALLOWED.join(', ')}`)
return await workflow('research', { question: A.question, angles: A.angles, mode: 'answer' })
