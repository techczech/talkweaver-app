#!/usr/bin/env node
// Share for comments (ticket 03): the handout build hook, on the real compiler. What one push sends
// must carry no speaker notes and no HTML comments — neither in the handout HTML (its SLIDE_SCRIPT
// companion included) nor in the per-slide source text the Worker serves publicly — and what counts
// as notes or a comment is the compiler's own parse. Each slide's text is its authored outline
// source, keyed by the same slide id her page reads from the compiled section.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSharedTalkPayload, loadOutlineTreeLib, ownerNameFrom, shareSafeOutline, slideSourceTexts, slideTextsByLine } from '../src/main/shared-talk-build.ts'

const compilerDir = resolve(import.meta.dirname, '../compiler/scripts')
const root = mkdtempSync(join(tmpdir(), 'tw-shared-build-'))
const SECRETS = ['SECRET-AFTER-HEADING', 'SECRET-IN-LIST', 'SECRET-CRLF', 'SECRET-UNCLOSED', 'SECRET-AFTER-COMMENT', 'TODO-PRIVATE', 'SECRET-COMMENT-FENCE', 'SECRET-PLAIN']

async function build(name, content, proposals = true) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const outlinePath = join(dir, `${name}-outline.md`)
  writeFileSync(outlinePath, content)
  return buildSharedTalkPayload({ compilerDir, outlinePath, content, slug: name, ownerName: 'Dominik', proposals })
}

function assertClean(payload, label) {
  const script = payload.html.match(/var SLIDE_SCRIPT = ([\s\S]*?);\n/)?.[1] ?? ''
  assert.ok(script.length > 0, `${label}: the page carries a SLIDE_SCRIPT companion to check`)
  const slideText = JSON.stringify(payload.slides)
  for (const secret of SECRETS) {
    assert.equal(script.includes(secret), false, `${label}: ${secret} is not in SLIDE_SCRIPT`)
    assert.equal(payload.html.includes(secret), false, `${label}: ${secret} is not in the pushed HTML`)
    assert.equal(slideText.includes(secret), false, `${label}: ${secret} is not in the pushed slide text`)
  }
}

const text = (payload, id) => payload.slides.find((slide) => slide.slideId === id)?.text

const fm = '---\noutline_version: 2\ntitle: AI and assessment workshop\nauthor: Dominik Lukeš (owner@example.org)\n---\n'
const awkward = `${fm}
## Where it breaks

### Notes right after the heading
{id=afterheading}
:::notes
SECRET-AFTER-HEADING
:::
- Visible after heading

### Notes inside a list
{id=inlist}

- First point
:::notes
SECRET-IN-LIST
:::
- Second point

### Unclosed notes
{id=unclosed}

- Visible before
:::notes
SECRET-UNCLOSED runs to the next heading

### The next slide still appears
{id=afterunclosed}

- Still here

### Comment with a fence line
{id=commentfence}

<!-- draft:
\`\`\`text
SECRET-COMMENT-FENCE
-->
- Visible under the comment

:::notes
SECRET-AFTER-COMMENT
:::

### A TODO comment
{id=todo}

- Shown <!-- TODO-PRIVATE check the figure -->
- Also shown

### Code stays code
{id=code}

\`\`\`text
:::notes
this is inside a code fence and is slide content
:::
\`\`\`

:::notes
SECRET-PLAIN
:::
`

try {
  const payload = await build('awkward', awkward)
  assertClean(payload, 'awkward outline')
  assert.equal(payload.title, 'AI and assessment workshop')
  assert.equal(/id="notesPanel"/.test(payload.html), false, 'no notes panel in the share build')
  assert.match(payload.html, /SHARED_TALK_OPTIONS = \{"proposals":true,"ownerName":"Dominik"\}/, 'her page gets the comments runtime')
  for (const id of ['afterheading', 'inlist', 'unclosed', 'afterunclosed', 'commentfence', 'todo', 'code']) {
    assert.ok(payload.slides.some((slide) => slide.slideId === id), `${id} is pushed`)
    assert.match(payload.html, new RegExp(`data-id="${id}"`), `${id} has the same id in the page`)
  }
  assert.equal(text(payload, 'afterheading'), '### Notes right after the heading\n{id=afterheading}\n- Visible after heading')
  assert.equal(text(payload, 'inlist'), '### Notes inside a list\n{id=inlist}\n\n- First point\n- Second point')
  assert.equal(text(payload, 'unclosed'), '### Unclosed notes\n{id=unclosed}\n\n- Visible before')
  assert.equal(text(payload, 'afterunclosed'), '### The next slide still appears\n{id=afterunclosed}\n\n- Still here', 'an unclosed notes block ends at the next heading')
  assert.match(payload.html, /Still here/)
  assert.equal(text(payload, 'commentfence'), '### Comment with a fence line\n{id=commentfence}\n\n- Visible under the comment', 'a fence line inside a comment opens no fence')
  assert.match(payload.html, /Visible under the comment/)
  assert.equal(text(payload, 'todo'), '### A TODO comment\n{id=todo}\n\n- Shown\n- Also shown')
  assert.match(text(payload, 'code'), /```text\n:::notes\nthis is inside a code fence and is slide content\n:::\n```$/, 'a notes marker inside a code fence is content')
  console.log('PASS awkward outline: notes after a heading, in a list, unclosed before a heading, after a comment with a fence line, TODO comments — none pushed; the next slide still appears')

  const crlf = await build('crlf', `${fm}\n### Windows line endings\n{id=crlf1}\n\n- Visible CRLF\n:::notes\nSECRET-CRLF\n:::\n\n### Second\n{id=crlf2}\n\n- Two\n`.replace(/\n/g, '\r\n'))
  assertClean(crlf, 'CRLF outline')
  assert.equal(text(crlf, 'crlf1'), '### Windows line endings\n{id=crlf1}\n\n- Visible CRLF')
  assert.equal(text(crlf, 'crlf2'), '### Second\n{id=crlf2}\n\n- Two')
  console.log('PASS CRLF outline: notes removed, slide text intact')

  const narrow = await build('narrow', awkward, false)
  assert.match(narrow.html, /SHARED_TALK_OPTIONS = \{"proposals":false/, 'switch 2 off reaches her page')
  console.log('PASS build: the proposals switch reaches the page options')

  // The helpers keep line count and endings (the compiler's source lines must not drift).
  const lib = await loadOutlineTreeLib(compilerDir)
  const sample = `${fm}### A\r\n{id=a}\r\n:::notes\r\nsecret\r\n:::\r\n- b <!-- x -->\r\n`
  const safe = shareSafeOutline(lib, sample)
  assert.equal(safe.split('\n').length, sample.split('\n').length, 'line count kept')
  assert.equal(safe.includes('secret'), false)
  assert.equal(safe.startsWith(fm), true, 'frontmatter untouched')
  assert.match(safe, /- b {1,}\r\n$/, 'comment blanked, line ending kept')
  // The compiler reads image refs resolved to local paths; the pushed text stays authored.
  const authored = '### Pic\n{id=p1}\n\n![chart](img-abc1234)'
  const pushed = slideSourceTexts(slideTextsByLine(lib, authored), [{ id: 'p1', title: 'Pic', sourceLine: 1 }], ['p1', 'deck-title'])
  assert.equal(pushed[0].text, authored, 'no local path travels in the slide text')
  assert.equal(pushed[1].text, '', 'generated slides have no source text')
  assert.equal(ownerNameFrom(awkward), 'Dominik Lukeš')
  assert.equal(ownerNameFrom('---\ntitle: x\n---\n', 'Fallback Name'), 'Fallback Name')
  console.log('PASS helpers: line count and endings kept, authored text, owner name without e-mail')
} finally {
  rmSync(root, { recursive: true, force: true })
}
