// test:icons-on-titles-identity — plain view ticket 07: a slide that uses none of the new syntax
// (no `{icon=…}` on a heading, no `{title-icon=…}`, no paragraph ending in `{icon=…}`) compiles to
// the same slide markup as before the ticket.
//
// The identity set:
//   - the five example talks (resources/example-vault), which carry none of the new syntax;
//   - scripts/fixtures/icons-on-titles/braces-that-are-not-icons-outline.md: text that ends in
//     braces without being an icon (a URL's tail, an escaped brace, braces inside a link, an
//     autolink and a code span, on paragraphs and on headings);
//   - scripts/fixtures/icons-on-titles/nested-section-panels-outline.md: a {compare} slide whose markup
//     nests <section> panels inside the slide's own <section>; checked structurally at the end of this file,
//     not pinned to the old compiler (ticket 08 of 0.41 redrew compare on purpose);
//   - scripts/fixtures/icons-on-titles/deck-default-list-icon-style-list-outline.md: the list slide of the
//     list-icon-style deck default. Not pinned to the old compiler (ticket 09 of 0.41 redrew the box form of
//     icon lists on purpose, `ul.feature-list.fl-cards`); checked structurally at the end of this file:
//     the list still draws its item icons and its title still carries none;
//   - scripts/fixtures/icons-on-titles/deck-default-*-outline.md (fix round 2): the same talk under
//     four front-matter `triggers:` defaults: `icon=lucide:bike`, `title-icon=above`, both, and a
//     list icon style (`liststyle=icons iconlist=boxes icons=all`). The talk has no icon on any
//     heading or paragraph, and one slide whose Trigger line says `{icon=lucide:route}`. A deck
//     default and a Trigger line never drew an icon in a title before the ticket and do not now:
//     a title's icon comes only from the heading's own line.
//
// scripts/fixtures/icons-on-titles-identity.json holds, per outline, the slide count and a SHA-256
// of every slide in order. The slides are cut by the compiler's nesting-aware extractor
// (findSlideSections, 04-html-extraction.mjs), so a slide with inner <section> elements is hashed
// whole. The check at the end of this file proves that on the fixture's own nested slide.
//
// The reference is recorded FROM THE COMPILER AS IT STOOD BEFORE TICKET 07, never from the working
// tree: `--record --compiler-root=<dir>` takes a directory holding that commit's `compiler/` and
// `src/shared/` (with a `node_modules` beside them) and writes the fixture from it; `--record`
// with no root is refused. The reference in the repository was recorded from the parent of commit
// 16a372f5. A hash that changes means slides without the new syntax changed: a defect to fix.
//
// Not covered here: the stylesheet and the runtime are not hashed. The ticket's rules select only
// markup the new syntax emits (test:icons-on-titles checks every selector), but unchanged hashes
// say nothing about title sizing, alignment or print layout.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { talkNamesTitleLook, withoutLaterSlideStamps } from './lib/slide-markup-identity.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = join(REPO, 'resources', 'example-vault')
const FIXTURE = join(REPO, 'scripts', 'fixtures', 'icons-on-titles-identity.json')
const FIXTURES = join(REPO, 'scripts', 'fixtures', 'icons-on-titles')
const LITERAL = join(FIXTURES, 'braces-that-are-not-icons-outline.md')
const DECK_DEFAULTS = ['deck-default-icon', 'deck-default-title-icon-above', 'deck-default-icon-with-title-icon-above', 'deck-default-list-icon-style']
const record = process.argv.includes('--record')
const rootArg = process.argv.find((arg) => arg.startsWith('--compiler-root='))
if (record && !rootArg) {
  console.error('FAIL: --record needs --compiler-root=<a tree holding the compiler from before ticket 07>; the reference is never recorded from the working tree')
  process.exit(1)
}
const compilerRoot = rootArg ? resolve(rootArg.slice('--compiler-root='.length)) : REPO
const lib = (name) => import(pathToFileURL(join(compilerRoot, 'compiler', 'scripts', 'lib', name)).href)
const { prepareSource } = await lib('08-source-adapters.mjs')
const { findSlideSections } = await lib('04-html-extraction.mjs')

const talks = readdirSync(BUNDLE, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => entry.name)
  .sort()

const NEW_SYNTAX = /^#{1,6}\s.*\{[^}]*\bicon\s*=|\{[^}]*title-icon|^(?![-*>|#]|\d+[.)]\s).*\{\s*icon\s*=[^}]*\}\s*$/m

const sources = talks.map((slug) => ({ slug, path: join(BUNDLE, slug, `${slug}-outline.md`), example: true }))
sources.push({ slug: 'braces-that-are-not-icons', path: LITERAL, example: false })
for (const slug of DECK_DEFAULTS) sources.push({ slug, path: join(FIXTURES, `${slug}-outline.md`), example: false })

const actual = {}
const sectionsOf = {}
for (const { slug, path, example } of sources) {
  const text = readFileSync(path, 'utf8')
  // (The braces fixture is written to LOOK like the new syntax without being it, so it is not screened.)
  if (example && NEW_SYNTAX.test(text)) {
    console.error(`FAIL: ${slug} uses the title or paragraph icon syntax, so it cannot be an identity reference`)
    process.exit(1)
  }
  const model = await prepareSource(path, text, slug, statSync(path))
  // Stamps a later ticket added to every slide are left out (scripts/lib/slide-markup-identity.mjs).
  const sections = findSlideSections(model.fullHtml).map((span) => withoutLaterSlideStamps(span.html, { talkNamesTitleLook: talkNamesTitleLook(text) }))
  sectionsOf[slug] = sections
  actual[slug] = {
    slides: sections.length,
    sha256: createHash('sha256').update(sections.join('\n')).digest('hex')
  }
}

if (record) {
  writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`)
  console.log(`recorded ${sources.length} outlines to ${FIXTURE} from the compiler in ${compilerRoot}`)
  process.exit(0)
}

const expected = JSON.parse(readFileSync(FIXTURE, 'utf8'))
let failures = 0
for (const slug of Object.keys(expected)) {
  const got = actual[slug]
  const want = expected[slug]
  if (!got) { console.error(`FAIL: ${slug} is in the fixture but not in the identity set`); failures += 1; continue }
  if (got.slides !== want.slides || got.sha256 !== want.sha256) {
    console.error(`FAIL: ${slug} slide markup changed (slides ${want.slides} → ${got.slides}, sha ${want.sha256.slice(0, 12)} → ${got.sha256.slice(0, 12)})`)
    failures += 1
  }
}
for (const { slug } of sources) if (!expected[slug]) { console.error(`FAIL: ${slug} has no recorded reference`); failures += 1 }

// The extractor takes a slide whole. A compare slide nests two <section class="compare-half vs-panel">
// panels (the 5+-pair contrast used to; ticket 08 of 0.41 moved that to compare): its span must hold
// both and end with the slide's own close, and changing a word in the SECOND panel must change the
// hash (a cut at the first inner </section> would hide that change). This slide is not pinned to
// the pre-ticket compiler (compare was redrawn on purpose); it is checked structurally, here.
{
  const nestedPath = join(FIXTURES, 'nested-section-panels-outline.md')
  const nestedText = readFileSync(nestedPath, 'utf8')
  const nestedModel = await prepareSource(nestedPath, nestedText, 'nested-section-panels', statSync(nestedPath))
  const nested = findSlideSections(nestedModel.fullHtml).map((span) => span.html).find((html) => html.includes('vs-panel'))
  const sha = (html) => createHash('sha256').update(html).digest('hex')
  if (!nested) { console.error('FAIL: the fixture has no slide with nested <section> panels'); failures += 1 }
  else {
    const opens = (nested.match(/<section\b/g) ?? []).length
    const closes = (nested.match(/<\/section>/g) ?? []).length
    if (opens !== 3 || closes !== 3) { console.error(`FAIL: the nested slide was not cut whole (${opens} <section>, ${closes} </section>)`); failures += 1 }
    if (!nested.includes('Card and cash')) { console.error('FAIL: the nested slide lost its second panel'); failures += 1 }
    if (sha(nested.replace('Card and cash', 'Card only')) === sha(nested)) { console.error('FAIL: a change in the second panel does not change the hash'); failures += 1 }
  }
}
// The list slide under the list-icon-style deck default (not pinned; see the header): items keep
// their icons, the title has none.
{
  const listPath = join(FIXTURES, 'deck-default-list-icon-style-list-outline.md')
  const listModel = await prepareSource(listPath, readFileSync(listPath, 'utf8'), 'deck-default-list-icon-style-list', statSync(listPath))
  const list = findSlideSections(listModel.fullHtml).map((span) => span.html).find((html) => html.includes('data-id="d-list"'))
  if (!list) { console.error('FAIL: the list-icon-style list fixture has no list slide'); failures += 1 }
  else {
    if ((list.match(/class="fl-icon"/g) ?? []).length !== 3) { console.error('FAIL: the list slide does not draw an icon on each of its three items'); failures += 1 }
    if (/title-with-icon|class="fl-icon title-icon"|data-para-icon/.test(list)) { console.error('FAIL: the list slide draws a title or paragraph icon nothing in the talk asks for'); failures += 1 }
  }
}
// Fix round 2: under a deck default, and under a Trigger line that names an icon, no title carries
// an icon (stated directly as well as by the recorded hashes).
if (!record) {
  for (const slug of DECK_DEFAULTS) {
    const withIcon = sectionsOf[slug].filter((html) => /title-with-icon|class="fl-icon title-icon"|data-para-icon/.test(html))
    if (withIcon.length) { console.error(`FAIL: ${slug}: ${withIcon.length} slide(s) draw a title or paragraph icon nothing in the talk asks for`); failures += 1 }
    if (sectionsOf[slug].length < 7) { console.error(`FAIL: ${slug}: expected the fixture's slides, got ${sectionsOf[slug].length}`); failures += 1 }
  }
}
if (failures) process.exit(1)
console.log(`test:icons-on-titles-identity — ${sources.length} outlines without the new syntax compile to the slide markup recorded before the ticket`)
