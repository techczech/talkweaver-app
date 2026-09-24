// Ticket 5 — the poll frame on the slide. A `{poll=…}` heading must COMPILE a presenter-visible
// frame into the slide body (question, type label, authored options, join slot, state chip), so the
// editor preview, the prerendered thumbnails and the handout stop showing an empty slide for every
// poll. The live projection replaces this same frame at runtime; nothing here asserts live state.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { POLL_STATE_LABELS, POLL_TYPE_LABELS, pollFrameRuntimeSource, renderPollFrame } from '../compiler/scripts/lib/poll-frame.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = mkdtempSync(join(tmpdir(), 'tw-poll-frame-'))

async function compile(name, source) {
  const path = join(workDir, `${name}.md`)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, name, statSync(path))
  return model
}

// Slide sections never nest, so the first closing tag after the opening one ends the slide.
function sectionFor(html, slideId) {
  const start = html.indexOf(`<section class="slide" data-id="${slideId}"`)
  assert.notEqual(start, -1, `slide ${slideId} is in the compiled deck`)
  const end = html.indexOf('</section>', start)
  return html.slice(start, end + '</section>'.length)
}

function frameFor(section, slideId) {
  const start = section.indexOf('<section class="poll-frame"')
  assert.notEqual(start, -1, `slide ${slideId} compiles a poll frame into its body`)
  const end = section.indexOf('</section>', start)
  return section.slice(start, end + '</section>'.length)
}

const countOf = (html, needle) => html.split(needle).length - 1

const OUTLINE = `# Poll Frame Fixtures

## Polls

### Which option do you prefer? {poll=single}

- Alpha
- Beta
- Gamma

### What should we build next? {poll=open}

### Pick every tool you use {poll=multiple}

- Notes
- Slides
- Email

### Rank these priorities {poll=ranking}

- Speed
- Accuracy
- Cost

### Rate each session {poll=rating}

[scale: Poor, Fair, Good]

- Morning keynote
- Afternoon workshop

### Which option do you prefer? {poll=single}

- Alpha
- Beta
- Gamma

#### A child heading

Some prose under the child heading.
`

const model = await compile('poll-frame-fixtures', OUTLINE)
const html = model.fullHtml

const JOIN_PLACEHOLDER = 'Join link appears when the session is live'

const cases = [
  { id: 'which-option-do-you-prefer', type: 'single', question: 'Which option do you prefer?', options: 3, matrixLabels: 0 },
  { id: 'what-should-we-build-next', type: 'open', question: 'What should we build next?', options: 0, matrixLabels: 0 },
  { id: 'pick-every-tool-you-use', type: 'multiple', question: 'Pick every tool you use', options: 3, matrixLabels: 0 },
  { id: 'rank-these-priorities', type: 'ranking', question: 'Rank these priorities', options: 3, matrixLabels: 0 },
  { id: 'rate-each-session', type: 'rating', question: 'Rate each session', options: 2, matrixLabels: 3 },
]

for (const testCase of cases) {
  const section = sectionFor(html, testCase.id)
  const frame = frameFor(section, testCase.id)
  assert.match(frame, /data-poll-frame/, `${testCase.id}: frame root carries data-poll-frame`)
  assert.match(frame, new RegExp(`data-poll-type="${testCase.type}"`), `${testCase.id}: frame stamps its poll type`)
  assert.match(frame, new RegExp(`data-poll-id="poll-${testCase.id}"`), `${testCase.id}: frame stamps its poll id`)
  assert(frame.includes(testCase.question), `${testCase.id}: the question reads on the frame`)
  assert(frame.includes(POLL_TYPE_LABELS[testCase.type]), `${testCase.id}: the type label reads on the frame`)
  const optionCount = countOf(frame, 'class="poll-frame-option"') + countOf(frame, 'class="poll-frame-matrix-row"')
  assert.equal(optionCount, testCase.options, `${testCase.id}: every authored option is laid out`)
  assert.equal(countOf(frame, 'class="poll-frame-matrix-label"'), testCase.matrixLabels * testCase.options,
    `${testCase.id}: every scale label is laid out against every item`)
  assert(frame.includes(JOIN_PLACEHOLDER), `${testCase.id}: the join slot is a quiet placeholder, never a fake URL`)
  assert(!/https?:\/\//.test(frame), `${testCase.id}: no invented joining URL before the session is live`)
  assert.match(frame, /data-poll-state="ready"/, `${testCase.id}: the frame's state chip defaults to ready`)
  assert(frame.includes(POLL_STATE_LABELS.ready), `${testCase.id}: the state chip reads its label`)
  assert.doesNotMatch(frame, /poll-frame-body[\s\S]*poll-frame-join is-pending/, `${testCase.id}: pending join note does not create a detached body column`)
  assert.match(frame, /poll-frame-instruction[^>]*>[^<]+<\/span><p class="poll-frame-join-note">[^<]+<\/p><span class="poll-frame-chip"/, `${testCase.id}: instruction, pending join note and state chip share one ordered column`)
  // The slide's own title is painted once, by the frame. The head keeps a nav-only sr-only h1.
  assert.equal(countOf(section, '<h1'), 1, `${testCase.id}: exactly one h1 survives on the slide`)
  assert.match(section, /<h1 class="sr-only">/, `${testCase.id}: the slide head is quiet (nav-only h1)`)
  assert.equal(countOf(frame, '<h1'), 0, `${testCase.id}: the frame never re-paints the slide h1`)
  assert(!section.includes('<h1>'), `${testCase.id}: no painted h1 alongside the frame's question`)
  // One sentence, once: every poll keeps its instruction in the footer; an open poll has no option body.
  const instruction = frame.match(/class="poll-frame-(?:instruction|prompt)">([^<]+)</)?.[1]
  assert(instruction, `${testCase.id}: the frame states what the audience does`)
  assert.equal(countOf(frame, instruction), 1, `${testCase.id}: the instruction is printed once`)
}

// A poll heading that also has child headings composes exactly as one that does not (ADR-0023 §1).
const plain = await compile('poll-frame-plain', `# Poll Frame Fixtures

## Polls

### Which option do you prefer? {poll=single}

- Alpha
- Beta
- Gamma
`)
const plainSlides = plain.slides
const parentSlide = model.slides.filter((slide) => slide.id.startsWith('which-option-do-you-prefer')).at(-1)
const plainPollSlide = plainSlides.find((slide) => slide.id === 'which-option-do-you-prefer')
assert.equal(parentSlide.layout, plainPollSlide.layout, 'a poll heading with children keeps its layout')
const parentFrame = frameFor(sectionFor(html, parentSlide.id), parentSlide.id)
const plainFrame = frameFor(sectionFor(plain.fullHtml, 'which-option-do-you-prefer'), 'which-option-do-you-prefer')
assert.equal(
  parentFrame.replace(new RegExp(parentSlide.id, 'g'), 'which-option-do-you-prefer'),
  plainFrame,
  'a poll heading with children compiles the same frame as one without',
)
if (parentSlide.role !== plainPollSlide.role) {
  console.log(`NOTE: role diverges with child headings — ${plainPollSlide.role} → ${parentSlide.role} (outside Ticket 5; see report)`)
}

// A poll whose type needs options but has none must still show a frame carrying a visible warning.
const bare = await compile('poll-frame-bare', `# Poll Frame Fixtures

## Polls

### Which option do you prefer? {poll=single}

Just a sentence, no list.
`)
const bareFrame = frameFor(sectionFor(bare.fullHtml, 'which-option-do-you-prefer'), 'which-option-do-you-prefer')
assert.match(bareFrame, /class="poll-frame-warning"/, 'an option-less choice poll renders its warning state')
assert(bareFrame.includes('Which option do you prefer?'), 'the warning state still carries the question')

const joinedFrame = renderPollFrame({
  pollId: 'poll-live-join',
  type: 'single',
  question: 'Which option do you prefer?',
  options: [{ id: 'alpha', label: 'Alpha' }],
}, { join: { shortUrl: 'https://handouts.fyi/example', qrSvg: '<svg></svg>' } })
assert.match(joinedFrame, /poll-frame-body[\s\S]*<aside class="poll-frame-join">/, 'a real join link activates the body join column')
assert.doesNotMatch(joinedFrame, /poll-frame-join-note/, 'a real join link replaces the pending note')

// The handout is built from the compiled sections, so the frame travels to the audience surface.
const slides = extractSlides(html)
const handout = buildShareHtml({
  title: 'Poll Frame Fixtures', slides, styles: extractStyles(html), includeNotes: false, slug: 'poll-frame-fixtures',
})
assert(handout.includes('data-poll-frame'), 'the handout carries the compiled poll frame')
assert(handout.includes(JOIN_PLACEHOLDER), 'the handout carries the join placeholder')

// Labels are duplicated from the registries on purpose (the compiler cannot import TypeScript);
// parity keeps the frame's vocabulary identical to the authoring surfaces and the projection.
const metadataRegistry = readFileSync(join(repo, 'src/shared/metadata-registry.ts'), 'utf8')
for (const [value, label] of Object.entries(POLL_TYPE_LABELS)) {
  assert(
    metadataRegistry.includes(`{ value: '${value}', label: '${label}'`),
    `poll type label parity: ${value} → ${label} matches the metadata registry`,
  )
}
// Ticket 23: the projection has no composition of its own. poll-display.js fills the frame's slots
// through renderPollFrame (injected ahead of it by 01-cli-utils pollDisplayRuntimeSource), so the
// instruction line, the letters and the chip cannot drift — they are the same code.
const pollDisplay = readFileSync(join(repo, 'compiler/assets/runtime/poll-display.js'), 'utf8')
assert(pollDisplay.includes('renderPollFrame('), 'the live display renders through the frame')
assert(!/poll-display-canvas|poll-display-options|<h1/.test(pollDisplay), 'no second poll composition survives in the runtime')
const runtime = pollFrameRuntimeSource()
assert(!/\bexport\b|\bimport\b/.test(runtime), 'the injected frame renderer inlines cleanly (no module syntax)')
const injected = new Function(`${runtime}; return renderPollFrame;`)()
assert.equal(
  injected({ pollId: 'poll-x', type: 'multiple', question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
  renderPollFrame({ pollId: 'poll-x', type: 'multiple', question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
  'the runtime twin renders byte-identically to the compiler',
)
const cliUtils = readFileSync(join(repo, 'compiler/scripts/lib/01-cli-utils.mjs'), 'utf8')
assert.match(cliUtils, /pollDisplayRuntimeSource = \[pollFrameRuntimeSource\(\)/, 'the deck injects the frame renderer before poll-display.js')

console.log(`poll frame: ${cases.length} poll types framed; warning state, child-heading parity, handout, label parity and runtime-twin parity hold`)
