#!/usr/bin/env node
/**
 * Speaker notes never reach the audience.
 *
 * Found 2026-09-28: the phone text view of a published handout showed the slide's speaker notes.
 * The slide-script companion (ADR-0018) was parsed from each slide's full outline source, which
 * includes its `:::notes` … `:::` block, and the payload is stamped into every compiled deck, so the
 * handout, the venue page and the share page all carried the notes. Imported talks were worst hit:
 * the importer puts the slide's verbatim Markdown into a `:::notes` block wrapped in a 4-backtick
 * fence.
 *
 * Two layers:
 *   1. parseSlideScript recognises notes exactly as the compiler's outline parser does
 *      (14-outline-tree.mjs): a trimmed, case-insensitive `:::notes` line, closed by `:::`, fences
 *      (backticks or tildes) guarded, an unclosed block running to the end of the slide.
 *   2. Output guard: a fixture talk whose slides carry sentinel notes goes through the real compile,
 *      handout, share and venue builders; every output file is scanned for the sentinels. The only
 *      place notes may appear is the presenter's own `<aside class="notes">` channel (compiled deck,
 *      and the share-notes variant that exists to show them) — and they must still be there.
 *   3. Links (found 2026-09-28, second leak): the Links slide (`links_index: true`, or an authored
 *      `{links}` slide) collected every link from each slide's raw source, notes and HTML comments
 *      included. Fixtures carry sentinel link text and URLs in notes and in comments; the deck's
 *      link list and every output file are scanned, and the visible links must still be listed.
 *   4. Folded layouts (found 2026-09-28): {columns}, {compare} and {cards=grid} fold their `####`
 *      children into one slide. Child notes must reach that slide's presenter aside in source
 *      order, labelled by child, and no audience output; the phone text view must carry the
 *      children's visible text (titles included), in order.
 *   5. Folded depth (review of 4, 2026-09-28): the phone text view and the Links slide show exactly
 *      the children a folded slide draws — not a `#####` under a folded child, not the children of a
 *      fold container nested in a child (a nested {columns} excepted: it draws them), not compare's
 *      groups past the second — for {cards=rows}, {carousel}, {image-grid} and {contrast} too, and
 *      an unclosed `:::notes` in a fold's last child stays notes. Undrawn text (UNDRAWN-*) may
 *      appear in no output; its notes still reach the presenter.
 *   HTML-comment text (COMMENTLEAK-*) may appear in no output at all, notes aside included. Every
 *   notes fixture is also compiled with CRLF line endings.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSlideScript, buildSlideScriptPayload } from '../compiler/scripts/lib/slide-script.mjs'
import { prepareSource, injectPerSlideNotes } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles, extractSlideScript } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { buildVenuePageHtml } from '../compiler/scripts/lib/venue-page.mjs'

let passed = 0
let failed = 0
function check(condition, label) {
  if (condition) {
    passed += 1
    console.log(`PASS: ${label}`)
  } else {
    failed += 1
    console.error(`FAIL: ${label}`)
  }
}
const scriptText = (source) => JSON.stringify(parseSlideScript(source))

// ── 1. parseSlideScript: notes recognition ──────────────────────────────────────────────────────

{
  const out = scriptText([
    '### Plain notes',
    '',
    '- visible before',
    '',
    ':::notes',
    'SECRET-PLAIN-NOTE',
    '- SECRET-PLAIN-BULLET',
    ':::',
    '',
    '- visible after',
  ].join('\n'))
  check(!out.includes('SECRET-PLAIN'), 'a closed :::notes block is excluded from the slide script')
  check(out.includes('visible before') && out.includes('visible after'),
    'content before and after the notes block stays in the slide script')
}

{
  const out = scriptText(['### Marker case', '- shown', '   :::NOTES  ', 'SECRET-CASE', '  :::  ', '- shown too'].join('\n'))
  check(!out.includes('SECRET-CASE'), 'the notes marker is recognised trimmed and case-insensitively')
  check(out.includes('shown too'), 'a trimmed ::: closes the notes block')
}

{
  // The importer's shape: existing notes + the slide's own Markdown in a 4-backtick fence, which
  // itself contains a ``` code fence, headings and a bare ::: line.
  const out = scriptText([
    '### Imported slide',
    '',
    '- visible point',
    '',
    ':::notes',
    'SECRET-IMPORTED-NOTE',
    '',
    '**Markdown for this slide:**',
    '````md',
    '### SECRET-FENCED-HEADING',
    ':::',
    'SECRET-AFTER-INNER-CLOSER',
    '```js',
    'const SECRET_CODE = 1',
    '```',
    '````',
    'SECRET-AFTER-FENCE',
    ':::',
    '',
    '- visible tail',
  ].join('\n'))
  check(!/SECRET/.test(out), 'fenced Markdown inside notes (4-backtick, inner ```, heading, bare :::) stays notes')
  check(out.includes('visible point') && out.includes('visible tail'), 'content around a fenced notes block survives')
}

{
  const out = scriptText([
    '### Tilde fence',
    ':::notes',
    '~~~',
    ':::',
    'SECRET-TILDE',
    '~~~',
    'SECRET-TILDE-AFTER',
    ':::',
    '- after tilde',
  ].join('\n'))
  check(!out.includes('SECRET-TILDE'), 'a tilde fence inside notes guards a bare ::: line too')
  check(out.includes('after tilde'), 'the real closer after a tilde fence ends the notes block')
}

{
  const out = scriptText(['### Unclosed', '- shown', ':::notes', 'SECRET-UNCLOSED', '', '- SECRET-UNCLOSED-BULLET', '> SECRET-UNCLOSED-QUOTE'].join('\n'))
  check(!out.includes('SECRET-UNCLOSED'), 'an unclosed :::notes runs to the end of the slide')
  check(out.includes('shown'), 'content before an unclosed notes block survives')
}

{
  const out = scriptText(['### Deck-title line in notes', ':::notes', '# NOTESLEAK-HEADING-IN-NOTES', 'NOTESLEAK-HEADING-BODY', ':::', '- ok'].join('\n'))
  check(!out.includes('NOTESLEAK-HEADING'), 'a single-# heading inside notes does not end the notes block')
}

{
  // The compiler blanks HTML comments before recognising structure, so a ::: hidden in a comment
  // never closes notes there; the slide script must not close early on it either.
  const out = scriptText(['### Comment', ':::notes', '<!--', ':::', '-->', 'SECRET-PAST-COMMENT', ':::', '- ok'].join('\n'))
  check(!out.includes('SECRET-PAST-COMMENT'), 'a ::: inside an HTML comment does not close notes early')
}

{
  // A :::notes line inside an ordinary content fence is code, not a notes marker.
  const out = scriptText(['### Fence first', '```', ':::notes', '```', '- still content'].join('\n'))
  check(out.includes('still content'), 'a :::notes line inside a content fence is not a notes marker')
}

// ── 2. The compiler's own notes and the slide script never overlap ──────────────────────────────

const fixture = [
  '---',
  'title: Notes guard',
  '---',
  '',
  '# Notes guard',
  '',
  '## Section one',
  '',
  ':::notes',
  'NOTESLEAK-SECTION-7Q',
  ':::',
  '',
  '### Bullets',
  '',
  '- Visible bullet alpha',
  '- Visible bullet beta',
  '',
  ':::notes',
  'NOTESLEAK-BULLETS-3K and more',
  '',
  '- NOTESLEAK-NOTE-BULLET-5M',
  ':::',
  '',
  '### Quote',
  '',
  '> Visible quote text',
  '',
  ':::Notes',
  '> NOTESLEAK-QUOTE-9Z',
  '',
  '| NOTESLEAK-TABLE-2W | x |',
  '|---|---|',
  '| a | b |',
  ':::',
  '',
  '### Fenced notes',
  '',
  'Visible paragraph.',
  '',
  ':::notes',
  '````md',
  '### NOTESLEAK-FENCED-HEADING-4R',
  ':::',
  '```',
  'NOTESLEAK-FENCED-CODE-8T',
  '```',
  '````',
  'NOTESLEAK-AFTER-FENCE-6Y',
  ':::',
  '',
  '### Unclosed',
  '',
  '- Visible last bullet',
  '',
  ':::notes',
  'NOTESLEAK-UNCLOSED-1P',
  '',
].join('\n')
// The importer's shape (injectPerSlideNotes, 08-source-adapters.mjs): each slide's verbatim Markdown
// appended to its notes in a 4-backtick fence, merged with any notes already there.
const importedTalk = injectPerSlideNotes([
  '# Imported guard',
  '',
  '## Imported section',
  '',
  '### Imported code slide',
  '',
  '- Visible imported bullet',
  '',
  '```js',
  'const visible = true',
  '```',
  '',
  ':::notes',
  'NOTESLEAK-IMPORTED-A1',
  ':::',
  '',
  '### Imported plain slide {statement}',
  '',
  'Visible imported statement.',
  '',
  ':::notes',
  '- NOTESLEAK-IMPORTED-B2',
  ':::',
  '',
].join('\n'))

// Links (found 2026-09-28): the Links slide — `links_index: true` or an authored `{links}` slide —
// lists every `[text](https://…)` in the deck. It read each slide's raw source, so a link in the
// speaker notes or inside an HTML comment was published, text and URL, on the Links slide of the
// deck, the handout and the venue page. Sentinels sit in the link text AND the URL path.
const linksNotesAndComments = [
  '',
  '# Links guard',
  '',
  '## Links section',
  '',
  ':::notes',
  'Section note [NOTESLEAK-LINKTEXT-SEC-2H](https://notes.example/NOTESLEAK-URL-SEC-2H)',
  ':::',
  '',
  '### Reading [the heading guide](https://visible.example/heading)',
  '',
  '- Read [the visible guide](https://visible.example/guide)',
  '<!-- [COMMENTLEAK-LINKTEXT-C1](https://comments.example/COMMENTLEAK-URL-C1) -->',
  '- Visible links bullet <!-- inline COMMENTLEAK-INLINE-C2 [x](https://comments.example/COMMENTLEAK-URL-C2) -->',
  '',
  ':::notes',
  'Private reading: [NOTESLEAK-LINKTEXT-A7](https://notes.example/NOTESLEAK-URL-A7)',
  '- also [NOTESLEAK-LINKTEXT-B8](https://notes.example/NOTESLEAK-URL-B8)',
  '<!-- a comment inside notes: [COMMENTLEAK-LINKTEXT-C3](https://comments.example/COMMENTLEAK-URL-C3) -->',
  ':::',
  '',
  '<!--',
  '### COMMENTLEAK-SLIDE-C4',
  '',
  '- [COMMENTLEAK-LINKTEXT-C4](https://comments.example/COMMENTLEAK-URL-C4)',
  '-->',
  '',
  '### Second links slide',
  '',
  'See [the second visible page](https://visible.example/second).',
  '',
  ':::notes',
  '````md',
  '- [NOTESLEAK-LINKTEXT-FENCED-D9](https://notes.example/NOTESLEAK-URL-FENCED-D9)',
  '````',
  ':::',
  '',
]
const linksIndexTalk = ['---', 'title: Links guard', 'links_index: true', '---', ...linksNotesAndComments].join('\n')
const authoredLinksTalk = [
  '---', 'title: Authored links guard', '---',
  ...linksNotesAndComments,
  '### Further reading {links}',
  '',
  ':::notes',
  'On the links slide itself: [NOTESLEAK-LINKTEXT-E4](https://notes.example/NOTESLEAK-URL-E4)',
  ':::',
  '',
].join('\n')
const linksNotes = [
  'NOTESLEAK-LINKTEXT-SEC-2H', 'NOTESLEAK-URL-SEC-2H', 'NOTESLEAK-LINKTEXT-A7', 'NOTESLEAK-URL-A7',
  'NOTESLEAK-LINKTEXT-B8', 'NOTESLEAK-URL-B8', 'NOTESLEAK-LINKTEXT-FENCED-D9', 'NOTESLEAK-URL-FENCED-D9',
]
const linksVisible = [
  { text: 'the heading guide', url: 'https://visible.example/heading' },
  { text: 'the visible guide', url: 'https://visible.example/guide' },
  { text: 'the second visible page', url: 'https://visible.example/second' },
]

const SENTINEL = /NOTESLEAK-[A-Z0-9-]+/
const SENTINELS = /NOTESLEAK-[A-Z0-9-]+/g
// Comment text reaches NO output at all — not even the presenter's notes aside.
const COMMENT_SENTINEL = /COMMENTLEAK-[A-Z0-9-]+/
const COMMENT_SENTINELS = /COMMENTLEAK-[A-Z0-9-]+/g
const NOTES_ASIDE = /<aside\b[^>]*class=["'][^"']*\bnotes\b[^"']*["'][^>]*>[\s\S]*?<\/aside>/gi
const LINKS_SLIDE = /<section\b[^>]*data-layout="links"[^>]*>[\s\S]*?<\/section>/gi
const sentinelsIn = (text) => new Set(String(text).match(SENTINELS) || [])

async function compileAndGuard(label, source, { expectedNotes, visible, links = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'tw-notes-guard-'))
  const outlinePath = join(dir, `${label}-outline.md`)
  writeFileSync(outlinePath, source, 'utf8')
  const model = await prepareSource(outlinePath, source, label, statSync(outlinePath))

  // Model slides carry notes as `{ html }`, built from the outline parser's notesLines — every
  // sentinel must be a note by the compiler's own reading, or the fixture proves nothing.
  const compilerNotes = sentinelsIn(JSON.stringify(model.slides.map((slide) => slide.notes || '')))
  check(expectedNotes.every((s) => compilerNotes.has(s)),
    `${label}: the compiler reads all ${expectedNotes.length} sentinels as notes (saw ${compilerNotes.size})`)

  const payload = JSON.stringify(buildSlideScriptPayload(model.slides))
  check(!SENTINEL.test(payload), `${label}: the slide-script payload built from the compiled model carries no notes`)
  check(!COMMENT_SENTINEL.test(payload), `${label}: the slide-script payload carries no HTML-comment text`)
  check(visible.every((text) => payload.includes(text)), `${label}: the slide-script payload still carries the visible slide text`)

  const deck = model.fullHtml
  const slides = extractSlides(deck)
  const styles = extractStyles(deck)
  const presenterNotes = sentinelsIn((deck.match(NOTES_ASIDE) || []).join(''))
  check(expectedNotes.every((s) => presenterNotes.has(s)),
    `${label}: the compiled deck still holds every note in <aside class="notes"> for the presenter window`)
  check(slides.some((slide) => SENTINEL.test(slide.notes || '')), `${label}: extractSlides still hands notes to the notes channel`)
  check(slides.every((slide) => !SENTINEL.test(JSON.stringify(slide.script || null))),
    `${label}: no extracted slide carries notes in its script`)
  check(!SENTINEL.test(JSON.stringify(extractSlideScript(deck))), `${label}: the twSlideScript tag in the compiled deck carries no notes`)

  if (links) {
    const deckLinks = JSON.stringify(model.deckLinks || [])
    const leaked = [...new Set([...(deckLinks.match(SENTINELS) || []), ...(deckLinks.match(COMMENT_SENTINELS) || [])])]
    check(leaked.length === 0,
      `${label}: the deck's link list carries no link from notes or comments${leaked.length ? ` (leaked: ${leaked.join(', ')})` : ''}`)
    check(links.visible.every(({ text, url }) => (model.deckLinks || []).some((l) => l.text === text && l.url === url)),
      `${label}: the deck's link list still holds every visible link (${links.visible.length}), heading links included`)
    const linksSlides = deck.match(LINKS_SLIDE) || []
    check(linksSlides.length === 1 && links.visible.every(({ url }) => linksSlides[0].includes(`href="${url}"`)),
      `${label}: the compiled deck has one Links slide listing every visible link`)
  }

  const common = { title: model.title, slides, styles, slug: label, license: null }
  const outputs = {
    'deck-full.html': { html: deck, presenterNotesAllowed: true },
    'handout.html': { html: buildShareHtml({ ...common, includeNotes: false }) },
    'handout-live.html': {
      html: buildShareHtml({ ...common, includeNotes: false, workerBaseUrl: 'https://live.example', liveTalkSlug: label }),
    },
    'share-notes.html': { html: buildShareHtml({ ...common, includeNotes: true }), presenterNotesAllowed: true },
    'venue.html': {
      html: buildVenuePageHtml({
        ...common, workerBaseUrl: 'https://live.example', qr: '<svg></svg>', handoutUrl: `https://handouts.example/${label}`,
      }),
    },
  }
  for (const [name, { html }] of Object.entries(outputs)) writeFileSync(join(dir, name), html, 'utf8')

  // Scan what is on disk, not the strings in hand: every file in the output directory.
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), 'utf8')
    if (name === `${label}-outline.md`) continue
    const allowed = outputs[name]?.presenterNotesAllowed
    const leaks = [...sentinelsIn(allowed ? text.replace(NOTES_ASIDE, '') : text)]
    check(leaks.length === 0,
      `${label}/${name}: no notes text ${allowed ? 'outside the presenter notes aside' : 'anywhere'}${leaks.length ? ` (leaked: ${leaks.join(', ')})` : ''}`)
    const commentLeaks = [...new Set(text.match(COMMENT_SENTINELS) || [])]
    check(commentLeaks.length === 0,
      `${label}/${name}: no HTML-comment text anywhere${commentLeaks.length ? ` (leaked: ${commentLeaks.join(', ')})` : ''}`)
  }
  if (links) {
    const handoutLinks = (outputs['handout.html'].html.match(LINKS_SLIDE) || []).join('')
    check(links.visible.every(({ url }) => handoutLinks.includes(`href="${url}"`)),
      `${label}: the handout's Links slide still lists every visible link`)
  }
  check(SENTINEL.test((outputs['share-notes.html'].html.match(NOTES_ASIDE) || []).join('')),
    `${label}: the share-notes variant still shows notes in its notes aside`)
  return { model, slides }
}

await compileAndGuard('authored', fixture, {
  expectedNotes: [...sentinelsIn(fixture)],
  visible: ['Visible bullet alpha', 'Visible quote text', 'Visible paragraph.', 'Visible last bullet'],
})
await compileAndGuard('imported', importedTalk, {
  expectedNotes: ['NOTESLEAK-IMPORTED-A1', 'NOTESLEAK-IMPORTED-B2'],
  visible: ['Visible imported bullet', 'Visible imported statement.'],
})
await compileAndGuard('links-index', linksIndexTalk, {
  expectedNotes: linksNotes,
  visible: ['the visible guide', 'Visible links bullet', 'the second visible page'],
  links: { visible: linksVisible },
})
await compileAndGuard('links-authored', authoredLinksTalk, {
  expectedNotes: [...linksNotes, 'NOTESLEAK-LINKTEXT-E4', 'NOTESLEAK-URL-E4'],
  visible: ['the visible guide', 'Visible links bullet', 'the second visible page'],
  links: { visible: linksVisible },
})

// Folded layouts (found 2026-09-28, roadmap idea notes-in-folded-layouts): {columns}, {compare} and
// {cards=grid} (and the other absorbing containers) fold their `####` children into ONE slide. The
// fold kept each child's visible lines and dropped its `:::notes`, so child notes reached neither the
// presenter nor anything else; and the slide's source slice stopped at the first child, so the
// children's visible text was missing from the phone's text view. Child notes must reach the parent
// slide's presenter aside in source order, each labelled by its child's title, and still no
// audience output; the children's visible text (titles included) must reach the phone, in order.
const foldedTalk = [
  '---',
  'title: Folded guard',
  '---',
  '',
  '# Folded guard',
  '',
  '## Folded section',
  '',
  '### Columns slide {columns}',
  '',
  'Visible columns intro.',
  '',
  ':::notes',
  'NOTESLEAK-COLS-PARENT-1A',
  ':::',
  '',
  '#### Left column',
  '',
  '- Visible left point',
  '',
  ':::notes',
  'NOTESLEAK-COLS-LEFT-2B',
  '- NOTESLEAK-COLS-LEFT-BULLET-2C',
  ':::',
  '',
  '#### Right column',
  '',
  '- Visible right point',
  '',
  ':::notes',
  'NOTESLEAK-COLS-RIGHT-3D',
  ':::',
  '',
  '### Compare slide {compare}',
  '',
  '#### Before state',
  '',
  '- Visible before point',
  '',
  ':::notes',
  'NOTESLEAK-CMP-BEFORE-4E',
  ':::',
  '',
  '#### After state',
  '',
  '- Visible after point',
  '',
  ':::notes',
  '````md',
  '### NOTESLEAK-CMP-FENCED-5F',
  ':::',
  '````',
  'NOTESLEAK-CMP-AFTER-6G',
  ':::',
  '',
  '### Cards slide {cards=grid}',
  '',
  '#### First card',
  '',
  'Visible first card text.',
  '',
  ':::notes',
  'NOTESLEAK-CARD-FIRST-7H',
  ':::',
  '',
  '#### Second card',
  '',
  'Visible second card text.',
  '',
  '#### Third card',
  '',
  'Visible third card text.',
  '',
  ':::notes',
  'NOTESLEAK-CARD-THIRD-8J',
  '',
  '### After the folds',
  '',
  '- Visible trailing bullet',
  '',
  ':::notes',
  'NOTESLEAK-TRAILING-9K',
  ':::',
  '',
].join('\n')
// Per folded slide: its notes in source order (a child label before each child's notes), and its
// visible text in order on the phone. `slide` is the heading title (nav title).
const foldedSlides = [
  {
    slide: 'Columns slide',
    notes: [
      'NOTESLEAK-COLS-PARENT-1A', 'Left column', 'NOTESLEAK-COLS-LEFT-2B', 'NOTESLEAK-COLS-LEFT-BULLET-2C',
      'Right column', 'NOTESLEAK-COLS-RIGHT-3D',
    ],
    labels: ['Left column', 'Right column'],
    phone: ['Visible columns intro.', 'Left column', 'Visible left point', 'Right column', 'Visible right point'],
  },
  {
    slide: 'Compare slide',
    notes: ['Before state', 'NOTESLEAK-CMP-BEFORE-4E', 'After state', 'NOTESLEAK-CMP-FENCED-5F', 'NOTESLEAK-CMP-AFTER-6G'],
    labels: ['Before state', 'After state'],
    phone: ['Before state', 'Visible before point', 'After state', 'Visible after point'],
  },
  {
    slide: 'Cards slide',
    notes: ['First card', 'NOTESLEAK-CARD-FIRST-7H', 'Third card', 'NOTESLEAK-CARD-THIRD-8J'],
    labels: ['First card', 'Third card'],
    unlabelled: ['Second card'],
    phone: [
      'First card', 'Visible first card text.', 'Second card', 'Visible second card text.',
      'Third card', 'Visible third card text.',
    ],
  },
]
const foldedVisible = [...new Set(foldedSlides.flatMap(({ phone }) => phone)), 'Visible trailing bullet']
const inOrder = (text, needles) => {
  let at = 0
  for (const needle of needles) {
    const found = text.indexOf(needle, at)
    if (found < 0) return false
    at = found + needle.length
  }
  return true
}
const LABEL = (title) => new RegExp(`<strong>${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</strong>`)

async function guardFolded(label, source) {
  const { model, slides } = await compileAndGuard(label, source, {
    expectedNotes: [...sentinelsIn(source)],
    visible: foldedVisible,
  })
  const payload = buildSlideScriptPayload(model.slides)
  for (const { slide: title, notes, labels, unlabelled = [], phone } of foldedSlides) {
    const extracted = slides.find((s) => s.title === title)
    const modelSlide = model.slides.find((s) => s.title === title)
    check(Boolean(extracted && modelSlide), `${label}: the compiled deck has the folded slide "${title}"`)
    if (!extracted || !modelSlide) continue
    const aside = extracted.notes || ''
    check(inOrder(aside, notes),
      `${label}/${title}: the presenter notes aside holds the folded children's notes in source order`)
    check(labels.every((childTitle) => LABEL(childTitle).test(aside)),
      `${label}/${title}: each folded child's notes are labelled by its title`)
    check(unlabelled.every((childTitle) => !aside.includes(childTitle)),
      `${label}/${title}: a folded child without notes adds no label`)
    const script = JSON.stringify(payload[modelSlide.id] || [])
    check(!SENTINEL.test(script), `${label}/${title}: the phone text view carries no folded child's notes`)
    check(inOrder(script, phone),
      `${label}/${title}: the phone text view carries the folded children's visible text, in order`)
  }
  const trailing = slides.find((s) => s.title === 'After the folds')
  check(Boolean(trailing) && trailing.notes.includes('NOTESLEAK-TRAILING-9K') && !/NOTESLEAK-CARD/.test(trailing.notes),
    `${label}: the slide after the folds keeps its own notes and none of the folded ones`)
  const trailingScript = JSON.stringify(payload[model.slides.find((s) => s.title === 'After the folds')?.id] || [])
  check(!/Visible third card text/.test(trailingScript), `${label}: the slide after the folds carries no folded child's text`)
}

await guardFolded('folded', foldedTalk)

// Folded depth (found in review of the fold fix, 2026-09-28): the phone text view and the Links
// slide must show exactly the children a folded slide DRAWS. A fold draws each child's own content;
// a `#####` under a folded child is not drawn, nor are the children of a fold container nested in a
// child (only a nested {columns} merges its children into the child's own content, so those are
// drawn), nor compare's groups past the second. Their notes still reach the presenter. The other
// absorbing containers ({cards=rows}, {carousel}, {image-grid}, {contrast}) get the same guarantees,
// and an unclosed `:::notes` in a fold's last child (closed by the next slide's heading, and at the
// end of the file) stays notes. UNDRAWN-* is visible-looking text the slide never draws: it may
// appear in no output at all.
const foldedDepthTalk = [
  '---',
  'title: Folded depth guard',
  'links_index: true',
  '---',
  '',
  '# Folded depth guard',
  '',
  '## Depth section',
  '',
  '### Rows slide {cards=rows}',
  '',
  '#### Row one',
  '',
  'Visible row one, see [the row guide](https://visible.example/row).',
  '',
  ':::notes',
  'NOTESLEAK-ROWS-ONE-1L',
  ':::',
  '',
  '##### Row one detail',
  '',
  'UNDRAWN-GRANDCHILD-2M, see [UNDRAWN-LINKTEXT-GC-2M](https://undrawn.example/UNDRAWN-URL-GC-2M).',
  '',
  ':::notes',
  'NOTESLEAK-ROWS-GRANDCHILD-2N and [NOTESLEAK-LINKTEXT-GC-2N](https://notes.example/NOTESLEAK-URL-GC-2N)',
  ':::',
  '',
  '#### Row two',
  '',
  'Visible row two.',
  '',
  ':::notes',
  'NOTESLEAK-ROWS-TWO-UNCLOSED-3P',
  '[NOTESLEAK-LINKTEXT-UNCLOSED-3P](https://notes.example/NOTESLEAK-URL-UNCLOSED-3P)',
  '',
  '### Carousel slide {carousel}',
  '',
  '#### First frame {columns}',
  '',
  'Visible first frame.',
  '',
  ':::notes',
  'NOTESLEAK-CAROUSEL-FIRST-4Q',
  ':::',
  '',
  '##### Frame left',
  '',
  'Visible frame left.',
  '',
  '##### Frame right',
  '',
  'Visible frame right.',
  '',
  ':::notes',
  'NOTESLEAK-CAROUSEL-FRAME-RIGHT-4S',
  ':::',
  '',
  '#### Second frame',
  '',
  'Visible second frame, see [the frame guide](https://visible.example/frame).',
  '',
  ':::notes',
  'NOTESLEAK-CAROUSEL-SECOND-5R',
  ':::',
  '',
  '### Image grid slide {image-grid}',
  '',
  '#### Grid picture one',
  '',
  '![Visible grid alt one](one.png)',
  '',
  ':::notes',
  'NOTESLEAK-GRID-ONE-6S',
  ':::',
  '',
  '#### Grid picture two',
  '',
  '![Visible grid alt two](two.png)',
  '',
  '### Contrast slide {contrast}',
  '',
  '#### Old way',
  '',
  'Visible old way.',
  '',
  ':::notes',
  'NOTESLEAK-CONTRAST-OLD-7T',
  ':::',
  '',
  '#### New way {cards=grid}',
  '',
  'Visible new way.',
  '',
  '##### Nested card in new way',
  '',
  'UNDRAWN-NESTED-FOLD-8U [UNDRAWN-LINKTEXT-NESTED-8U](https://undrawn.example/UNDRAWN-URL-NESTED-8U)',
  '',
  ':::notes',
  'NOTESLEAK-CONTRAST-NESTED-8V',
  ':::',
  '',
  '### Compare three groups {compare}',
  '',
  '#### Group one',
  '',
  'Visible group one.',
  '',
  '#### Group two',
  '',
  'Visible group two.',
  '',
  '#### Group three',
  '',
  'UNDRAWN-THIRD-GROUP-9W [UNDRAWN-LINKTEXT-THIRD-9W](https://undrawn.example/UNDRAWN-URL-THIRD-9W)',
  '',
  ':::notes',
  'NOTESLEAK-CMP-THIRD-9X [NOTESLEAK-LINKTEXT-THIRD-9X](https://notes.example/NOTESLEAK-URL-THIRD-9X)',
  ':::',
  '',
  '### Closing columns {columns}',
  '',
  '#### Last left',
  '',
  'Visible last left.',
  '',
  '#### Last right',
  '',
  'Visible last right, see [the last guide](https://visible.example/last).',
  '',
  ':::notes',
  'NOTESLEAK-COLS-LAST-UNCLOSED-0Y',
  '[NOTESLEAK-LINKTEXT-LAST-0Y](https://notes.example/NOTESLEAK-URL-LAST-0Y)',
  '',
].join('\n')
// Per folded slide: the phone text view's exact text, in order (child titles as paragraphs, image
// alt text for media), and the notes the presenter aside must hold, in source order.
const foldedDepthSlides = [
  {
    slide: 'Rows slide',
    phone: ['Row one', 'Visible row one, see [the row guide](https://visible.example/row).', 'Row two', 'Visible row two.'],
    notes: ['NOTESLEAK-ROWS-ONE-1L', 'NOTESLEAK-ROWS-GRANDCHILD-2N', 'NOTESLEAK-ROWS-TWO-UNCLOSED-3P'],
  },
  {
    slide: 'Carousel slide',
    phone: [
      'First frame', 'Visible first frame.', 'Frame left', 'Visible frame left.', 'Frame right', 'Visible frame right.',
      'Second frame', 'Visible second frame, see [the frame guide](https://visible.example/frame).',
    ],
    notes: ['NOTESLEAK-CAROUSEL-FIRST-4Q', 'NOTESLEAK-CAROUSEL-FRAME-RIGHT-4S', 'NOTESLEAK-CAROUSEL-SECOND-5R'],
  },
  {
    slide: 'Image grid slide',
    phone: ['Grid picture one', 'Visible grid alt one', 'Grid picture two', 'Visible grid alt two'],
    notes: ['NOTESLEAK-GRID-ONE-6S'],
  },
  {
    slide: 'Contrast slide',
    phone: ['Old way', 'Visible old way.', 'New way', 'Visible new way.'],
    notes: ['NOTESLEAK-CONTRAST-OLD-7T', 'NOTESLEAK-CONTRAST-NESTED-8V'],
  },
  {
    slide: 'Compare three groups',
    phone: ['Group one', 'Visible group one.', 'Group two', 'Visible group two.'],
    notes: ['NOTESLEAK-CMP-THIRD-9X'],
  },
  {
    slide: 'Closing columns',
    phone: ['Last left', 'Visible last left.', 'Last right', 'Visible last right, see [the last guide](https://visible.example/last).'],
    notes: ['NOTESLEAK-COLS-LAST-UNCLOSED-0Y'],
  },
]
const foldedDepthLinks = [
  { text: 'the row guide', url: 'https://visible.example/row' },
  { text: 'the frame guide', url: 'https://visible.example/frame' },
  { text: 'the last guide', url: 'https://visible.example/last' },
]
const UNDRAWN_SENTINELS = /UNDRAWN-[A-Z0-9-]+/g
// The phone view's text, one string per paragraph, list item, quote, image alt or table cell.
const scriptStrings = (blocks) => (blocks || []).flatMap((block) => {
  if (block.type === 'list') return block.items.map((item) => item.text)
  if (block.type === 'media') return [block.alt]
  if (block.type === 'table') return block.rows.flat()
  return [block.text]
})

async function guardFoldedDepth(label, source) {
  const { model, slides } = await compileAndGuard(label, source, {
    expectedNotes: [...sentinelsIn(source)],
    visible: foldedDepthSlides.flatMap(({ phone }) => phone),
    links: { visible: foldedDepthLinks },
  })
  const payload = buildSlideScriptPayload(model.slides)
  for (const { slide: title, phone, notes } of foldedDepthSlides) {
    const extracted = slides.find((s) => s.title === title)
    const modelSlide = model.slides.find((s) => s.title === title)
    check(Boolean(extracted && modelSlide), `${label}: the compiled deck has the folded slide "${title}"`)
    if (!extracted || !modelSlide) continue
    const shown = scriptStrings(payload[modelSlide.id])
    check(JSON.stringify(shown) === JSON.stringify(phone),
      `${label}/${title}: the phone text view shows exactly the children the slide draws${
        JSON.stringify(shown) === JSON.stringify(phone) ? '' : ` (got ${JSON.stringify(shown)})`}`)
    check(inOrder(extracted.notes || '', notes),
      `${label}/${title}: the presenter notes aside holds the folded notes, undrawn descendants' included, in order`)
  }
  const listed = JSON.stringify((model.deckLinks || []).map(({ text, url }) => ({ text, url })))
  check(listed === JSON.stringify(foldedDepthLinks),
    `${label}: the deck's link list is exactly the drawn visible links, folded children's included${
      listed === JSON.stringify(foldedDepthLinks) ? '' : ` (got ${listed})`}`)
  const linksSlide = (model.fullHtml.match(LINKS_SLIDE) || []).join('')
  const hrefs = [...linksSlide.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
  check(JSON.stringify(hrefs) === JSON.stringify(foldedDepthLinks.map(({ url }) => url)),
    `${label}: the Links slide lists exactly the drawn visible links${hrefs.length ? '' : ' (none listed)'}`)
  // Undrawn text reaches no output: not the phone payload, not the Links slide, not any file.
  const outputs = {
    'deck-full.html': model.fullHtml,
    'handout.html': buildShareHtml({ title: model.title, slides, styles: extractStyles(model.fullHtml), slug: label, license: null, includeNotes: false }),
  }
  for (const [name, html] of Object.entries(outputs)) {
    const undrawn = [...new Set(String(html).match(UNDRAWN_SENTINELS) || [])]
    check(undrawn.length === 0,
      `${label}/${name}: no text a folded slide never draws${undrawn.length ? ` (found: ${undrawn.join(', ')})` : ''}`)
  }
}

await guardFoldedDepth('folded-depth', foldedDepthTalk)

// CRLF line endings (a Windows-saved or pasted outline): the same notes and comments, the same
// guarantees. Both the notes fixture and the links fixture, every line ending `\r\n`.
const crlf = (text) => text.replace(/\r?\n/g, '\r\n')
await compileAndGuard('authored-crlf', crlf(fixture), {
  expectedNotes: [...sentinelsIn(fixture)],
  visible: ['Visible bullet alpha', 'Visible quote text', 'Visible paragraph.', 'Visible last bullet'],
})
await compileAndGuard('links-index-crlf', crlf(linksIndexTalk), {
  expectedNotes: linksNotes,
  visible: ['the visible guide', 'Visible links bullet', 'the second visible page'],
  links: { visible: linksVisible },
})

await guardFolded('folded-crlf', crlf(foldedTalk))
await guardFoldedDepth('folded-depth-crlf', crlf(foldedDepthTalk))

console.log(`\ntest-notes-never-published: ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
