// The link-edit rule over a whole outline (`setFormOnLinkEdits`, src/shared/layout-verbs.ts) passes over every slide whose
// lines read the same before and after the edit, and reads each outline once. This proves two things about that:
//   1. it returns exactly what the first, slides × talk version returned (scripts/lib/quote-link-form-edits-slow.mjs), on
//      thousands of generated (before, after) pairs: quote slides of every form, links added, removed and edited in source
//      lines, edits in other slides and in the frontmatter, slides inserted, deleted, moved and duplicated, ids removed and
//      repeated, comments, fences and notes opened and closed, CRLF;
//      The callback `compiledLayoutAt` is asked the same arguments, in the same order, as the reference asks it, for every
//      pair (a stateful callback included), and a reviewer's table case pins the one skip that once broke this;
//   2. its time grows with the talk, not with slides × talk (200 against 800 slides).
// Plain Node, no browser.
//
//   node scripts/test-quote-link-form-edits-equivalence.mjs [reference-module]
// `reference-module` (optional) is a module exporting another `setFormOnLinkEdits` to compare against as well, e.g. the
// file from an earlier commit.
import { strict as assert } from 'node:assert'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setFormOnLinkEdits } from '../src/shared/layout-verbs.ts'
import { setFormOnLinkEditsSlow } from './lib/quote-link-form-edits-slow.mjs'

const references = [['the slides × talk version', setFormOnLinkEditsSlow]]
if (process.argv[2]) references.push([process.argv[2], (await import(pathToFileURL(resolve(process.argv[2])).href)).setFormOnLinkEdits])

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = 'expertise attention language model teacher reading practice evidence pattern memory judgement tool writing student slide meaning metaphor structure question answer research system context limit example'.split(' ')
const WEB_LINKS = ['https://example.org/article', 'https://www.example.com/2026/long-read?x=1', 'https://x.com/someone', 'https://news.example.net/a/b']
const DOI_LINKS = ['https://doi.org/10.1000/xyz123', 'doi:10.1000/abc', '10.1000/plain.7', '[the paper](https://doi.org/10.5555/12345678)']
const OTHER_LINKS = ['https://x.com/sample/status/1234567890123456789', 'https://youtu.be/XXXXXXXXXXX', 'https://www.youtube.com/watch?v=XXXXXXXXXXX', 'ftp://example.org/file', '[a page](https://example.org/linked)']
const ALL_LINKS = [...WEB_LINKS, ...WEB_LINKS, ...DOI_LINKS, ...OTHER_LINKS]
const SOURCE_LINE = /^(> — |> -- |- )/

/** A talk of `slides` slides: frontmatter, a title, sections, quote slides of every form and other slides between them. */
function talk(slides, seed) {
  const next = rng(seed)
  const pick = (list) => list[Math.floor(next() * list.length)]
  const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ')
  const title = () => { const t = words(2 + Math.floor(next() * 3)); return t[0].toUpperCase() + t.slice(1) }
  let stamp = 0
  const id = () => { stamp += 1; return next() < 0.75 ? `{id=s${seed}x${stamp}}` : '' }
  const link = () => (next() < 0.45 ? ` ${pick(ALL_LINKS)}` : '')
  const lines = ['---', `title: "${title()}"`, 'author: Sample Author', 'colour: cobalt', 'outline_version: 2', '---', `# ${title()}`, '']
  const quote = (trigger, source) => {
    lines.push(`### ${title()}${next() < 0.1 ? ` ${id()}` : ''}`)
    const stamped = id()
    if (trigger || stamped) lines.push(next() < 0.2 && trigger && stamped ? `${trigger}` : `${trigger}${stamped}`)
    if (next() < 0.1) lines.push('{kicker="A, B"}')
    lines.push('', `> ${words(8 + Math.floor(next() * 20))}.`)
    if (next() < 0.5) lines.push(`> — ${source}${link()}`)
    else lines.push('', `- ${source}${link()}`)
    if (next() < 0.15) lines.push('', ':::notes', `${words(12)}. https://example.org/in-notes`, ':::')
    lines.push('')
  }
  const kinds = [
    () => quote('{quote}', 'Sample Author'),
    () => quote('{quote}', `Sample Author, *${title()}*`),
    () => quote('', 'Sample Author'),
    () => quote('{quote form=auto}', 'Sample Author'),
    () => quote('{quote}{form=tweet}', 'Sample Name (@samplehandle), 4 Oct 2026, 2:33 PM'),
    () => quote('{quote form=video}', `Sample Speaker, "${title()}", 12:40`),
    () => quote('{quote form=book}', `A One, *${title()}*, Sample Press, 1980, p. 5`),
    () => quote('{quote}', `A One, *${title()}*, Sample Press, 1980, p. 5`),
    () => quote('{quote form=paper}', `A One and B Two, "${title()}", *Journal of Samples*, 2020`),
    () => quote('{quote form=web}', `Sample Author, "${title()}"`),
    () => quote('{quote form=plain}', 'Sample Author'),
    // Two quotations, and a quotation beside other content: both stay plain.
    () => { lines.push(`### ${title()}`, `{quote}${id()}`, '', `> ${words(6)}.`, '', `- Sample Author${link()}`, '', `> ${words(5)}.`, '') },
    () => { lines.push(`### ${title()}`, `{quote}${id()}`, '', `> ${words(6)}.`, `> — Sample Author${link()}`, '', `- ${words(3)}`, `- ${words(4)}`, '') },
    // Not quote slides.
    () => { lines.push(`### ${title()}`, id(), ''); for (let k = 0; k < 3; k += 1) lines.push(`- ${words(4)}${link()}`); lines.push('') },
    () => { lines.push(`### ${title()}`, `{numbered}${id()}`, '', `1. ${words(4)}`, `2. ${words(5)}`, '') },
    () => { lines.push(`### ${title()}`, id(), '', `${words(30)} [${words(2)}](https://example.org/para).`, '', '```', '### not a heading', `- ${pick(WEB_LINKS)}`, '```', '') },
    () => { lines.push(`### ${title()}`, `{cards} ${id()}`, ''); for (let k = 0; k < 2; k += 1) lines.push(`#### ${title()}`, '', `${words(6)}.`, '') },
    () => { lines.push(`### ${title()}`, '', '<!--', `> ${words(4)}.`, `- Hidden ${pick(WEB_LINKS)}`, '-->', '', `> ${words(7)}.`, '', `- Sample Author${link()}`, '') }
  ]
  for (let n = 0; n < slides; n += 1) {
    if (n % 9 === 0) lines.push(`## ${title()}${next() < 0.5 ? ` ${id()}` : ''}`, '')
    if (next() < 0.55) kinds[Math.floor(next() * 11)]()
    else pick(kinds)()
  }
  return lines
}

/** The blocks of a talk: [start, end) line ranges, each from one `##`–`####` heading to the next. */
function blocks(lines) {
  const starts = lines.map((line, index) => (/^#{2,4} /.test(line) ? index : -1)).filter((index) => index >= 0)
  return starts.map((start, k) => [start, starts[k + 1] ?? lines.length])
}

/** One to three edits to a talk's lines. */
function edit(source, next) {
  const lines = [...source]
  const pick = (list) => list[Math.floor(next() * list.length)]
  const count = 1 + Math.floor(next() * 3)
  for (let k = 0; k < count; k += 1) {
    const sources = lines.map((line, index) => (SOURCE_LINE.test(line) ? index : -1)).filter((index) => index >= 0)
    const any = Math.floor(next() * lines.length)
    const kind = Math.floor(next() * 20)
    if (kind <= 4 && sources.length) {
      // A link added to a source line, or the one it has changed.
      const at = pick(sources)
      const bare = lines[at].replace(/\s+(\[[^\]]*\]\([^)]*\)|\S*(https?:|ftp:|doi:|10\.)\S*)\s*$/, '')
      lines[at] = `${bare} ${pick(ALL_LINKS)}`
    } else if (kind === 5 && sources.length) {
      const at = pick(sources)
      lines[at] = lines[at].replace(/\s+(\[[^\]]*\]\([^)]*\)|\S*(https?:|ftp:|doi:|10\.)\S*)\s*$/, '')
    } else if (kind === 6 && sources.length) {
      const at = pick(sources)
      lines[at] = lines[at].replace(/(https?:\/\/[^\s)]+)/, (url) => `${url}${pick(['/changed', '1', '?page=2'])}`)
    } else if (kind === 7 && sources.length) {
      // The rest of the source line edited, the link kept.
      const at = pick(sources)
      lines[at] = lines[at].replace(/^(> — |> -- |- )/, (mark) => `${mark}Edited `)
    } else if (kind === 8) lines[any] += ' typed'
    else if (kind === 9) {
      lines.splice(any, 0, pick(['', 'new line', '### New heading', '## New section', '<!--', '-->', ':::notes', ':::', '```', '{quote}', '{quote}{form=auto}', '{form=web}', '{id=dup1}', '> quoted words.', `> — A ${pick(ALL_LINKS)}`, `- B ${pick(ALL_LINKS)}`, '![alt](pic.png)', '---']))
    } else if (kind === 10) lines.splice(any, 1)
    else if (kind === 11) {
      // An id removed, or made the same as another.
      const ids = lines.map((line, index) => (/\{id=[^}]*\}/.test(line) ? index : -1)).filter((index) => index >= 0)
      if (ids.length) {
        const at = pick(ids)
        const other = lines[pick(ids)].match(/\{id=[^}]*\}/)[0]
        lines[at] = lines[at].replace(/\{id=[^}]*\}/, pick(['', other, other, '{id=dup1}']))
      }
    } else if (kind === 12) {
      // The frontmatter: a value edited, a key added, the closing fence removed.
      const end = lines.indexOf('---', 1)
      const choice = Math.floor(next() * 4)
      if (choice === 0) lines[1] = `title: "Edited ${Math.floor(next() * 100)}"`
      else if (choice === 1) lines.splice(1, 0, pick(['layout: quote', 'quote-form: web', 'form: web', 'theme: dark', `source: ${pick(WEB_LINKS)}`]))
      else if (choice === 2 && end > 0) lines.splice(end, 1)
      else lines.splice(0, 0, '---', 'extra: 1', '---')
    } else if (kind <= 16) {
      // A slide deleted, moved, duplicated, or a new one inserted.
      const all = blocks(lines)
      if (all.length > 2) {
        const [start, end] = pick(all)
        const block = lines.slice(start, end)
        if (kind === 13) lines.splice(start, end - start)
        else if (kind === 14) { lines.splice(start, end - start); const rest = blocks(lines); lines.splice(pick(rest)[0], 0, ...block) }
        else if (kind === 15) lines.splice(pick(all)[0], 0, ...block)
        else lines.splice(start, 0, '### Inserted', pick(['{quote}', '{quote}{id=new1}', '']), '', '> New words.', '', `- New Author ${pick(ALL_LINKS)}`, '')
      }
    } else if (kind === 17) {
      // A layout line edited: a form set or cleared, a second line added to the block.
      const triggers = lines.map((line, index) => (/^\{.*\}\s*$/.test(line) ? index : -1)).filter((index) => index >= 0)
      if (triggers.length) {
        const at = pick(triggers)
        const choice = Math.floor(next() * 4)
        if (choice === 0) lines[at] = lines[at].replace(/\{form=[^}]*\}| form=[a-z]+/, '')
        else if (choice === 1) lines[at] = `${lines[at]}{form=${pick(['auto', 'plain', 'web', 'tweet', 'nonsense'])}}`
        else if (choice === 2) lines.splice(at + 1, 0, pick(['{kicker="x"}', '{id=second}', '{quote}', '']))
        else lines[at] = lines[at].replace(/\{quote[^}]*\}/, pick(['', '{list}', '{quote}']))
      }
    } else if (kind === 18) {
      // A heading edited (a slide with no id is paired only when nothing outside it changed; its own heading may).
      const headings = lines.map((line, index) => (/^#{2,4} /.test(line) ? index : -1)).filter((index) => index >= 0)
      if (headings.length) { const at = pick(headings); lines[at] = pick([`${lines[at]} edited`, lines[at].replace(/^#+/, '##'), lines[at].replace(/^#+ /, '')]) }
    } else {
      // Words typed into a quotation, or a second quotation added to a slide.
      const quoted = lines.map((line, index) => (/^> (?!—)/.test(line) ? index : -1)).filter((index) => index >= 0)
      if (quoted.length) { const at = pick(quoted); if (next() < 0.7) lines[at] += ' more words'; else lines.splice(at + 1, 0, '', '> A second quotation.') }
    }
  }
  return lines
}

const outcome = (run) => {
  try {
    const written = run()
    return JSON.stringify([written.outline, written.set, written.form])
  } catch (error) {
    return `threw ${error?.name}: ${error?.message}`
  }
}

// ── 0. The reviewer's reproduction: a stateful callback must see the same calls as the old loop ────────────────────
// The old loop asked `compiledLayoutAt` for every slide the rule is asked about, skipped or not; a skip that did not ask
// too changed which call got which answer. `recording` logs the arguments each implementation passes the callback.

/** Wrap a callback so the arguments it is called with are logged to `log` (no callback: no wrapper, nothing to log). */
function recording(callback, log) {
  if (callback == null) return undefined
  return (line) => { log.push(line); return callback(line) }
}

const REPRODUCTION_BEFORE = '### A\n{id=a}\n\n> Words.\n\n- Author\n\n### B\n{id=b}\n\n> Other words.\n\n- Other author'
const REPRODUCTION_AFTER = REPRODUCTION_BEFORE.replace('- Author', '- Author https://example.org/a')
/** A fresh stateful callback: 'list' the first time it is asked, 'quote' after. */
const firstListThenQuote = () => { let calls = 0; return () => (++calls === 1 ? 'list' : 'quote') }

{
  const oldLog = []
  const newLog = []
  const old = outcome(() => setFormOnLinkEditsSlow(REPRODUCTION_BEFORE, REPRODUCTION_AFTER, recording(firstListThenQuote(), oldLog)))
  const got = outcome(() => setFormOnLinkEdits(REPRODUCTION_BEFORE, REPRODUCTION_AFTER, recording(firstListThenQuote(), newLog)))
  assert.equal(JSON.parse(old)[1], true, 'the old loop sets a form in the reproduction')
  assert.equal(JSON.parse(old)[2], 'web', 'the old loop sets web in the reproduction')
  assert.equal(got, old, 'reproduction: the new output equals the old loop')
  assert.deepEqual(newLog, oldLog, 'reproduction: the callback is asked with the same arguments, in the same order, as the old loop')
  console.log(`reproduction: old loop asked the callback for headings ${JSON.stringify(oldLog)}, new ${JSON.stringify(newLog)}`)
}

// ── 1. The same answer as before, pair by pair ─────────────────────────────────────────────────────────────────────

const LAYOUTS_AT = [
  ['no compiled layouts', () => undefined],
  ['every slide compiled as a quote', () => () => 'quote'],
  ['some slides compiled as quotes', () => (line) => (line % 3 === 0 ? 'quote' : line % 3 === 1 ? 'list' : undefined)],
  // Stateful: the answer depends on how many times it has been asked, so the order and count of calls are visible.
  ['a stateful layout: quote on every second call', () => { let calls = 0; return () => ((calls += 1) % 2 === 0 ? 'quote' : 'list') }]
]
const counts = { pairs: 0, set: 0, web: 0, paper: 0, severalSet: 0, unchanged: 0, crlf: 0, threw: 0, callbackCalls: 0 }
const next = rng(20261013)
for (const [slides, rounds] of [[4, 500], [12, 700], [30, 500], [70, 120]]) {
  for (let round = 0; round < rounds; round += 1) {
    const base = talk(slides, slides * 10000 + round)
    const beforeLines = next() < 0.3 ? edit(base, next) : base
    const afterLines = next() < 0.03 ? beforeLines : edit(beforeLines, next)
    const crlf = next() < 0.2
    // CRLF: the whole text, or (a text half converted) only its first half.
    const half = crlf && next() < 0.3
    const join = (lines) => (!crlf ? lines.join('\n') : half ? `${lines.slice(0, lines.length >> 1).join('\r\n')}\r\n${lines.slice(lines.length >> 1).join('\n')}` : lines.join('\r\n'))
    const before = join(beforeLines)
    const after = join(afterLines)
    for (const [name, layoutAt] of LAYOUTS_AT) {
      const gotLog = []
      const got = outcome(() => setFormOnLinkEdits(before, after, recording(layoutAt(), gotLog)))
      for (const [reference, old] of references) {
        const expectedLog = []
        const expected = outcome(() => old(before, after, recording(layoutAt(), expectedLog)))
        if (got !== expected) {
          console.error(`DIFFERENT from ${reference} (${slides} slides, round ${round}, ${name}, crlf ${crlf})`)
          console.error('--- before\n' + before + '\n--- after\n' + after + '\n--- expected\n' + expected + '\n--- got\n' + got)
          assert.fail(`setFormOnLinkEdits differs from ${reference}`)
        }
        if (JSON.stringify(gotLog) !== JSON.stringify(expectedLog)) {
          console.error(`CALLBACK SEQUENCE DIFFERENT from ${reference} (${slides} slides, round ${round}, ${name}, crlf ${crlf})`)
          console.error(`expected ${JSON.stringify(expectedLog)}\ngot      ${JSON.stringify(gotLog)}`)
          assert.fail(`setFormOnLinkEdits asks compiledLayoutAt differently from ${reference}`)
        }
        counts.callbackCalls += gotLog.length
      }
      counts.pairs += 1
      if (crlf) counts.crlf += 1
      if (got.startsWith('threw')) { counts.threw += 1; continue }
      const [outline, set, form] = JSON.parse(got)
      if (!set) { counts.unchanged += 1; assert.equal(outline, after, 'nothing set: the outline is the edited one') ; continue }
      counts.set += 1
      counts[form] += 1
      if ((outline.match(/form=(web|paper)/g) ?? []).length - (after.match(/form=(web|paper)/g) ?? []).length > 1) counts.severalSet += 1
    }
  }
}
console.log(`pairs ${counts.pairs} (CRLF ${counts.crlf}), identical to ${references.length} reference(s): a form was set in ${counts.set} (web ${counts.web}, paper ${counts.paper}; several slides at once in ${counts.severalSet}), nothing set in ${counts.unchanged}, threw in ${counts.threw}; compiledLayoutAt calls compared in sequence: ${counts.callbackCalls}`)
assert(counts.pairs >= 5000, 'thousands of pairs were compared')
assert(counts.set > 0, 'no pair set a form: the comparison proved nothing')
assert(counts.web > 0 && counts.paper > 0, 'both forms were set somewhere')
assert(counts.severalSet > 0, 'some pair set a form on several slides (the outline is read again after a write)')
assert(counts.crlf > 0 && counts.unchanged > 0)

// ── 2. The time grows with the talk, not with slides × talk ────────────────────────────────────────────────────────

function typedLineTime(slides) {
  const lines = talk(slides, 7)
  const before = lines.join('\n')
  const at = blocks(lines)[Math.floor(slides / 2)][0] + 3
  const typed = [...lines]
  typed[at] += ' typed'
  const after = typed.join('\n')
  let best = Infinity
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now()
    setFormOnLinkEdits(before, after, () => undefined)
    best = Math.min(best, performance.now() - started)
  }
  return best
}
typedLineTime(50) // warm the parser before timing
const at200 = typedLineTime(200)
const at800 = typedLineTime(800)
console.log(`a typed line: ${at200.toFixed(1)} ms at 200 slides, ${at800.toFixed(1)} ms at 800 (×${(at800 / at200).toFixed(1)})`)
// Four times the talk: linear is ×4, the old slides × talk shape was ×16 or more (941 ms and 17 s were measured).
assert(at800 / at200 < 10, `the time grew ×${(at800 / at200).toFixed(1)} from 200 to 800 slides: more than the talk did (×4, with slack to ×10)`)
assert(at800 < 2000, `an 800-slide talk took ${at800.toFixed(0)} ms (ceiling 2000 ms; the old shape took 17 s)`)

console.log('quote link form edits equivalence: OK')
