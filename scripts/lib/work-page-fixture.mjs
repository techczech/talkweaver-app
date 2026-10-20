// Participant work pages built the way the app builds them (work-files ticket 15): a work file compiled by
// compileWorkFile (ticket 05) and made into a page by buildParticipantWorkPage, for the page's tests. The
// files are the locked mockup's (section 13): pre-work "AI for research teams", four steps (a video, a
// quick check, a task drawn as title + picture beside numbered steps, an open question), and post-work,
// three steps (a 1-to-5 rating, two open questions).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileWorkFile } from '../../src/main/work-file-compile.ts'
import { buildParticipantWorkPage } from '../../src/main/work-page.ts'

export const COMPILER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'compiler', 'scripts')

/** The task's picture: a paper beside a chat, as the mockup draws it. */
export const TASK_PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 460" width="460" height="460">
<rect width="460" height="460" rx="10" fill="#e6ecf4" stroke="#c2d0e3" stroke-width="2"/>
<rect x="16" y="16" width="208" height="428" rx="6" fill="#fff"/><rect x="236" y="16" width="208" height="428" rx="6" fill="#fff"/>
<g fill="#d9d1c0"><rect x="30" y="32" width="180" height="8" rx="4"/><rect x="30" y="50" width="180" height="8" rx="4"/><rect x="30" y="68" width="180" height="8" rx="4"/>
<rect x="30" y="122" width="180" height="8" rx="4"/><rect x="30" y="140" width="180" height="8" rx="4"/><rect x="30" y="158" width="180" height="8" rx="4"/><rect x="30" y="176" width="180" height="8" rx="4"/></g>
<rect x="30" y="86" width="180" height="30" rx="4" fill="#f5e8d2" stroke="#e5cc9c"/>
<rect x="282" y="314" width="146" height="30" rx="15" fill="#e6ecf4"/><rect x="250" y="360" width="166" height="50" rx="15" fill="#f1ecdf"/><rect x="320" y="420" width="108" height="16" rx="8" fill="#e6ecf4"/>
</svg>
`

export const PRE_WORK = `---
id: research-teams-intake
title: Research teams intake
revision: 3
---
Four short steps before we meet. About twenty minutes in all; you can stop and come back.

### Watch: what the tools can do
{id=watch}{video}

https://youtu.be/dQw4w9WgXcQ

Six minutes. Watch it before the session; we start from here.

### Quick check
{id=quick-check}{check}{poll=single}

- The caveats and limitations {right}
- The title
- The authors’ names

### Try one prompt on a paper of your own
{id=try-a-prompt}{task}{minutes=20}

![A paper beside a chat](paper-and-chat.svg)

1. Open a paper you know well.
2. Copy one paragraph from its methods section.
3. Paste it into the chat and ask: “What would a reviewer query here?”
4. Note one useful point and one it got wrong.

### What do you most want from the session?
{id=what-you-want}{poll=open}
`

export const POST_WORK = `---
id: after-the-session
title: After the session
revision: 1
---
Three short steps; the speaker reads every answer.

### How useful was the session for your work?
{id=useful}{poll=rating}

[scale: 1 · not useful, 2, 3, 4, 5 · very useful]

- How useful was the session for your work?

### One thing you will try
{id=one-thing}{poll=open}

### Anything unclear?
{id=unclear}{poll=open}{noask}
`

/**
 * Compile `text` (beside the task's picture) and build its page.
 * @param {{ text?: string, phase?: 'pre'|'post', preworkId: string, workerBaseUrl: string, handoutUrl?: string,
 *   talkTitle?: string, runLine?: string }} options
 */
export async function buildWorkPageFixture({ text, phase = 'pre', preworkId, workerBaseUrl, handoutUrl = 'https://handouts.fyi/dl/said-21-oct', talkTitle = 'AI for research teams', runLine = 'Saïd workshop · Wed 21 Oct, 14:00' }) {
  const dir = await mkdtemp(join(tmpdir(), 'tw-work-page-'))
  try {
    await writeFile(join(dir, 'paper-and-chat.svg'), TASK_PICTURE)
    const source = text ?? (phase === 'post' ? POST_WORK : PRE_WORK)
    const path = join(dir, 'work.md')
    await writeFile(path, source)
    const compiled = await compileWorkFile({ compilerDir: COMPILER_DIR, path, text: source })
    const page = await buildParticipantWorkPage({ compilerDir: COMPILER_DIR, compiled, phase, preworkId, workerBaseUrl, talkTitle, runLine, handoutUrl })
    return { ...page, compiled, form: compiled.form }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
