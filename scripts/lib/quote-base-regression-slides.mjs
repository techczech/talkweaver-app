// The slides of scripts/test-quote-forms-base-regression.mjs: quote slides WITH ids and a source line, none with the
// bare-address shape of ticket 10 (the base, quote forms ticket 07, knew only the source line). Plain Node.
//
//   registry rows   every token of the layout registry beside `{quote}`, every way it can meet the slide
//                   (scripts/lib/quote-drawn-form-slides.mjs), over a `>` quotation and its bulleted source line;
//   shape rows      the other ways a source is written (inside the block, after a dash, on a quoted paragraph, a
//                   slide that is only its source line), each beside every layout and container token;
//   extra rows      what the review rounds turned on: poll and quick-check attributes, list items ending in an icon
//                   group, speaker notes, Trigger lines among the content, several quotations, pictures (with braces
//                   after them too), video and audio files, on a `{quote}` slide and on one with no layout token.
//
//   source rows     sixth round, for `set-quote-source` alone (`sourceRows`): slides the compiler reads no quotation
//                   on (a paragraph, a list, a quoted paragraph joined to an address across its notes), several
//                   quotations with and without a source, and an address already under the quotation (the bare-address
//                   shape, with speaker notes before, between and after), with no form and with `form=web`.
//
// A row is `{ id, label, kind, link, text(withLink) }`: `text(false)` is the slide before the link is typed.
import { DOI, NOTES, VARIANTS, WEB, comboSlide, comboSlides, registryLayoutTokens, registryTokens } from './quote-drawn-form-slides.mjs'

const linkOf = (index) => (index % 3 === 2 ? DOI : WEB)
const WORDS = '> Words of the quotation.'
const PARAGRAPH = '"Words of the quotation."'

/** The ways a source is written: `[name, content(link)]`, the link '' before the edit. */
const SHAPES = [
  ['a source inside the block', (link) => [WORDS, `> — Jane Example${link ? ` ${link}` : ''}`]],
  ['a source after a dash', (link) => [WORDS, '', `— Jane Example${link ? ` ${link}` : ''}`]],
  ['a quoted paragraph and its source line', (link) => [PARAGRAPH, '', `- Jane Example${link ? ` ${link}` : ''}`]],
  ['a quoted paragraph with its source after a dash', (link) => [`${PARAGRAPH} — Jane Example${link ? ` ${link}` : ''}`]],
  ['only a source line', (link) => [`- Jane Example${link ? ` ${link}` : ''}`]]
]

const PICTURE = '![The page](assets/page.png)'
/** `[kind, name, content(link)]`: each is laid on `{id=… quote}` and on `{id=…}`. */
const EXTRAS = [
  ...['{zap}', '{icon=zap}', '{nonsense}', '{github}', '{icon=not-an-icon}'].flatMap((ending) => [
    ['icons', `a source line ending in ${ending}`, (link) => [WORDS, '', `- Jane Example${link ? ` ${link}` : ''} ${ending}`]],
    ['icons', `only a source line ending in ${ending}`, (link) => [`- Jane Example${link ? ` ${link}` : ''} ${ending}`]],
    ['icons', `a quoted paragraph and a source line ending in ${ending}`, (link) => [PARAGRAPH, '', `- Jane Example${link ? ` ${link}` : ''} ${ending}`]]
  ]),
  ['icons', 'a list with icons after the source line', (link) => [WORDS, '', `- Jane Example${link ? ` ${link}` : ''}`, '', '- One {zap}', '- Two {github}']],
  ['icons', 'a list with icons before the quotation', (link) => ['- One {zap}', '', WORDS, '', `- Jane Example${link ? ` ${link}` : ''}`]],
  ...[
    ['before the quotation', (q, source) => [NOTES, '', q, '', source]],
    ['between, a blank line each side', (q, source) => [q, '', NOTES, '', source]],
    ['between, no blank line', (q, source) => [q, NOTES, source]],
    ['after the source', (q, source) => [q, '', source, '', NOTES]],
    ['after the source, no blank line', (q, source) => [q, '', source, NOTES]]
  ].flatMap(([place, lay]) => [WORDS, PARAGRAPH].map((q) => ['notes', `speaker notes ${place}, ${q[0] === '>' ? 'a > quotation' : 'a quoted paragraph'}`, (link) => lay(q, `- Jane Example${link ? ` ${link}` : ''}`)])),
  ...['{reveal}', '{mode=focus}', '{form=auto}', '{form=plain}', '{quote}', '{cards}', '{carousel}', '{2col}', '{poll=open}', '{check}'].flatMap((line) => [
    ['body trigger', `${line} between the quotation and its source`, (link) => [WORDS, '', line, '', `- Jane Example${link ? ` ${link}` : ''}`]],
    ['body trigger', `${line} before the quotation`, (link) => [line, '', WORDS, '', `- Jane Example${link ? ` ${link}` : ''}`]],
    ['body trigger', `${line} straight under the quotation`, (link) => [WORDS, line, '', `- Jane Example${link ? ` ${link}` : ''}`]]
  ]),
  ['several quotations', 'two quotations, the source after the second', (link) => ['> First.', '', '> Second.', '', `- Jane Example${link ? ` ${link}` : ''}`]],
  ['several quotations', 'two quotations, the source between', (link) => ['> First.', '', `- Jane Example${link ? ` ${link}` : ''}`, '', '> Second.']],
  ['several quotations', 'a quotation and a quoted paragraph', (link) => ['> First.', '', '"Second."', '', `- Jane Example${link ? ` ${link}` : ''}`]],
  ['several quotations', 'three quotations', (link) => ['> First.', '', '> Second.', '', '> Third.', '', `- Jane Example${link ? ` ${link}` : ''}`]],
  ...[[PICTURE], ['![a](assets/a.png){w=50}'], ['![a](assets/a.png) ![b](assets/b.png)'], ['![Video](movie.mp4)'], ['![Sound](assets/sound.mp3)'], ['[Video: movie.mp4]'], ['A paragraph beside the quotation.'], ['| a | b |', '| - | - |', '| 1 | 2 |']].flatMap((beside) => [
    ['beside the quotation', `${beside[0]} above`, (link) => [...beside, '', WORDS, '', `- Jane Example${link ? ` ${link}` : ''}`]],
    ['beside the quotation', `${beside[0]} below`, (link) => [WORDS, '', `- Jane Example${link ? ` ${link}` : ''}`, '', ...beside]]
  ])
]

/** Every row of the form statement, in the order above. */
export function regressionRows() {
  const rows = comboSlides('r', registryTokens(), VARIANTS, (link) => [WORDS, '', `- Jane Example${link ? ` ${link}` : ''}`], linkOf).map((row) => ({ ...row, kind: row.variant.startsWith('among the content') ? 'body trigger' : 'registry' }))
  const tokens = [...registryLayoutTokens(), 'reveal', 'check', 'poll=open', 'cards=grid', 'cols=2']
  for (const [name, content] of SHAPES) for (const token of tokens) for (const variant of ['after quote', 'after quote, child headings']) {
    const index = rows.length
    const id = `r${index}`
    rows.push({ id, token, variant, kind: 'shape', link: linkOf(index), label: `${name}, {${token}} ${variant}`, text: (withLink) => comboSlide(id, token, variant, content(withLink ? linkOf(index) : '')) })
  }
  for (const [kind, name, content] of EXTRAS) for (const variant of ['after quote', 'alone', 'after quote, child headings']) {
    const index = rows.length
    const id = `r${index}`
    // `reveal` stands where a registry token would: it moves nothing, so the row is the extra alone.
    rows.push({ id, token: 'reveal', variant, kind, link: linkOf(index), label: `${name}, on ${variant === 'alone' ? 'a slide with no layout token' : `{quote}${variant.endsWith('child headings') ? ' over child headings' : ''}`}`, text: (withLink) => comboSlide(id, 'reveal', variant, content(withLink ? linkOf(index) : '')) })
  }
  return rows
}

// (The two `notes` rows are one paragraph to the compiler, the notes dropped: no quotation with no form, and with
// `form=web` a form waiting for words whose source is that whole paragraph.)
/** `[kind, name, content]`: each is laid on `{quote}`, on a slide with no layout token and over child headings, with no form and with `form=web`. */
const SOURCE_EXTRAS = [
  ['no quotation', 'a paragraph only', ['A paragraph of the slide.']],
  ['no quotation', 'a paragraph of two lines and a list', ['A paragraph of the slide', 'on two lines.', '', '- One', '- Two']],
  ['no quotation', 'a list of two items', ['- One', '- Two']],
  ['notes', 'a quoted paragraph, its notes and an address straight under them', [PARAGRAPH, NOTES, WEB]],
  ['notes', 'a quoted paragraph with words after it, its notes and an address', [`${PARAGRAPH} and more`, NOTES, WEB]],
  ['several quotations', 'two quotations and no source', ['> First.', '', '> Second.']],
  ['several quotations', 'a quoted paragraph with its source after a dash, then a quotation', ['"First." — Jane Example', '', '> Second.']],
  ['several quotations', 'a quotation with its source inside the block, then a quoted paragraph', ['> First.', '> — Jane Example', '', '"Second."']],
  ['several quotations', 'two quoted paragraphs', ['"First."', '', '"Second."']],
  ...[WORDS, PARAGRAPH].flatMap((q) => [
    ['under the quotation', [q, '', WEB]],
    ['under the quotation, speaker notes before the quotation', [NOTES, '', q, '', WEB]],
    ['under the quotation, speaker notes between with a blank line each side', [q, '', NOTES, '', WEB]],
    ['under the quotation, speaker notes between with no blank line', [q, NOTES, WEB]],
    ['under the quotation, speaker notes after the address', [q, '', WEB, '', NOTES]],
    ['under the quotation, speaker notes after the address with no blank line', [q, '', WEB, NOTES]],
    ['under the quotation and its source line', [q, '', '- Jane Example', '', WEB]],
    ['above the quotation', [WEB, '', q]]
  ].map(([place, content]) => ['bare address', `an address ${place}, ${q[0] === '>' ? 'a > quotation' : 'a quoted paragraph'}`, content]))
]

/** The slides `set-quote-source` is compared on: every row above before its link is typed, a quotation with no source line beside every layout and container token, and the source rows. */
export function sourceRows() {
  const rows = regressionRows().map((row) => ({ ...row, text: () => row.text(false) }))
  const bare = comboSlides('q', [...registryLayoutTokens(), 'reveal', 'check', 'poll=open', 'cards=grid', 'cols=2'], VARIANTS, () => [WORDS], linkOf).map((row) => ({ ...row, kind: 'no source line', label: `no source line, ${row.label}` }))
  const extras = []
  for (const [kind, name, content] of SOURCE_EXTRAS) for (const token of ['reveal', 'form=web']) for (const variant of ['after quote', 'alone', 'after quote, child headings']) {
    const id = `x${extras.length}`
    extras.push({ id, token, variant, kind, link: WEB, label: `${name}, on ${variant === 'alone' ? 'a slide with no layout token' : `{quote}${variant.endsWith('child headings') ? ' over child headings' : ''}`}${token === 'form=web' ? ', form=web' : ''}`, text: () => comboSlide(id, token, variant, content) })
  }
  return [...rows, ...bare, ...extras]
}

/** The lines of one row's section (`## Part <id>` to the next) in an outline. */
export function sectionOf(outline, id) {
  const lines = outline.split('\n')
  const start = lines.indexOf(`## Part ${id}`)
  if (start < 0) return ''
  let end = start + 1
  while (end < lines.length && !/^## Part /.test(lines[end])) end += 1
  return lines.slice(start, end).join('\n').replace(/\n+$/, '')
}
