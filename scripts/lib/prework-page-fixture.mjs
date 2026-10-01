// A planned Run's handout with pre-work, built the way the app builds it (compiler → the public form from
// the compiled definition and polls → buildShareHtml with the step slides in the inert template), for the
// pre-work form's page tests. The outline is the seven-step Before-the-session of the round-2 drawings.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildShareHtml } from '../../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../../compiler/scripts/lib/04-html-extraction.mjs'
import { prepareSource } from '../../compiler/scripts/lib/08-source-adapters.mjs'
import { publicPreworkForm } from '../../src/shared/run-prework.ts'

export const PREWORK_OUTLINE = `---
title: The current state of AI agents
auto_title_slide: false
auto_thanks_slide: false
---

## Opening {id=open}

### Why we are here {id=why}

Talk slide text for the day.

## Before the session {id=pwform}{prework}

Seven short steps: two slides, two questions, two small tasks and one last question. About 20 minutes in all, and you can stop and come back. No account and no name.

### Welcome: three things before Monday {id=pwwelcome}

- Read two short slides
- Answer two quick questions
- Try two small tasks and mark them done

### What an agent is, in one slide {id=pwagent}

- A chat answers: you copy the result into your work
- An agent acts: it opens files and tools and does the steps
- You stay in charge: you check what it did before it counts

### Quick check: what makes something an agent? {id=pwquiz}{poll=single}{check}

- It answers questions in full sentences
- It uses tools to carry out steps for you {right}
- It runs on a bigger model
- Not sure yet

### What AI tools do you already use? {id=pwtools}{poll=multiple}

- Copilot Chat
- ChatGPT
- Claude
- None yet

### Task 1: draft one real email with Copilot {id=pwtask1}{task}

- Pick an email you need to send this week
- Ask Copilot to draft it from your notes
- Write down one thing it got wrong

### Task 2: bring one file for an agent to work on {id=pwtask2}{task}{minutes=5}

- Choose a file you would be happy to share
- Note where it lives

### What do you hope to get out of the session? {id=pwhope}{poll=open}

## Your turn {id=turn}

### Discuss {id=discuss}

Talk slide.
`

/**
 * The handout page and what the Worker would hold. `workerBaseUrl` is where the page asks; `preworkId`
 * names the pre-work object there. Returns { html, form, stepIds, done() } (done removes the scratch).
 */
export async function buildPreworkHandout({ workerBaseUrl, preworkId, outline = PREWORK_OUTLINE, title = 'The current state of AI agents' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tw-prework-page-'))
  const path = join(dir, 'agents-outline.md')
  await writeFile(path, outline)
  const model = await prepareSource(path, outline, title, statSync(path))
  await rm(dir, { recursive: true, force: true })
  const all = extractSlides(model.fullHtml)
  const styles = extractStyles(model.fullHtml)
  const preworkIds = new Set(model.prework?.slideIds ?? [])
  const slides = all.filter((slide) => !preworkIds.has(slide.id))
  const steps = all.filter((slide) => preworkIds.has(slide.id)).map((slide) => ({ id: slide.id, html: slide.html }))
  const form = publicPreworkForm(model.prework, model.slides)
  if (!form) throw new Error('The fixture outline has no readable pre-work.')
  const html = buildShareHtml({
    title, slides, styles, includeNotes: false, slug: 'agents-run', license: null,
    workerBaseUrl, liveTalkSlug: 'agents', prework: { preworkId, workerBaseUrl, form, steps },
  })
  return { html, form, stepIds: steps.map((step) => step.id) }
}
