// A generator of large, realistic talks for the plain view's time-budget test
// (scripts/test-plain-view-edit-time-budget.mjs). Deterministic: the same seed and slide count
// give the same text.
//
// A talk has sections and nested sections, list slides (plain, icon, numbered, nested rows), long
// paragraphs, pictures (long URLs, one data URI), carousel and cards slides with `####` items,
// quotes, tables, fenced code, speaker notes, layout lines under headings and in the content,
// title icons and `{id=…}` stamps.
//
//   largeTalk(slides, seed)  ->  { text, headings, carouselHeadingLine, listHeadingLine }
// `headings` are the 0-based lines of every `##`–`####` heading; the two named lines are a heading
// with `####` sub-headings and no layout written, and a list slide with no layout written.

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = 'expertise attention language model teacher reading practice evidence pattern memory judgement tool writing student slide meaning metaphor structure question answer research system context limit example habit choice plan result'.split(' ')
const ICONS = ['lucide:brain', 'lucide:boxes', 'lucide:terminal', 'lucide:image', 'lucide:puzzle', 'lucide:languages', 'lucide:hammer', 'lucide:pen-line']
const DATA_URI = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg'.repeat(40)}`

export function largeTalk(slides = 200, seed = 1) {
  const next = rng(seed)
  const pick = (list) => list[Math.floor(next() * list.length)]
  const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ')
  const title = () => { const t = words(3 + Math.floor(next() * 4)); return t[0].toUpperCase() + t.slice(1) }
  const id = () => `{id=${Math.floor(next() * 36 ** 5).toString(36).padStart(5, '0')}}`
  const lines = [
    '---', 'title: "A long talk with **pictures**"', 'subtitle: "Generated for the time budget."', 'author: TalkWeaver',
    'date: 13 October 2026', 'colour: cobalt', 'outline_version: 2', '---', '# A long talk with pictures {icon=lucide:presentation}', '',
    '<!--', 'A comment before the first section.', '-->', ''
  ]
  const headings = []
  let carouselHeadingLine = -1
  let listHeadingLine = -1
  const heading = (marks, text, tail = '') => { headings.push(lines.length); lines.push(`${marks} ${text}${tail}`) }
  const picture = (n) => `![${words(3)}](https://images.example.org/talks/2026/long-talk/${words(6).replace(/ /g, '-')}/picture-${n}-${'x'.repeat(120)}.jpg?width=1920&height=1080&fit=cover)`
  const list = (n, icon) => { for (let k = 0; k < n; k += 1) lines.push(`- ${words(4 + Math.floor(next() * 6))}${icon ? ` {icon=${pick(ICONS)}}` : ''}`) }
  const notes = () => { if (next() < 0.3) lines.push('', ':::notes', `${words(30)}.`, `- ${words(8)}`, ':::') }

  const body = [
    // 0: a list slide, no layout written
    (n) => { heading('###', title()); if (listHeadingLine < 0 && n > 3) listHeadingLine = headings[headings.length - 1]; lines.push(id(), ''); list(4 + Math.floor(next() * 4), false) },
    // 1: an icon list with a layout line and a title icon
    () => { heading('###', title(), ` {icon=${pick(ICONS)}}`); lines.push(`{iconlist} ${id()}`, ''); list(5, true) },
    // 2: a numbered list with nested rows
    () => { heading('###', title()); lines.push(`{numbered}${id()}`, ''); for (let k = 1; k <= 4; k += 1) { lines.push(`${k}. ${words(6)}`); lines.push(`   - ${words(5)}`, `     - ${words(4)} {icon=${pick(ICONS)}}`) } },
    // 3: long paragraphs
    () => { heading('###', title()); lines.push(id(), '', `${words(140)}.`, '', `${words(220)} **${words(3)}** [${words(2)}](https://example.org/${words(3).replace(/ /g, '/')}).`, '', `${words(40)} {icon=${pick(ICONS)}}`) },
    // 4: a picture with a claim
    (n) => { heading('###', title()); lines.push(`{image=right} ${id()}`, '', picture(n), '', `${words(18)}.`) },
    // 5: a carousel written on the heading, with `####` items
    (n) => { heading('###', title()); lines.push(`{carousel} ${id()}`, ''); for (let k = 0; k < 4; k += 1) { heading('####', title()); lines.push('', picture(n * 10 + k), '', `${words(12)}.`, '') } },
    // 6: `####` items under a heading with no layout written
    (n) => { heading('###', title()); if (carouselHeadingLine < 0 && n > 3) carouselHeadingLine = headings[headings.length - 1]; lines.push(id(), ''); for (let k = 0; k < 3; k += 1) { heading('####', title()); lines.push('', `- ${words(5)}`, `- ${words(6)}`, '') } },
    // 7: cards
    () => { heading('###', title()); lines.push(`{cards} ${id()}`, ''); for (let k = 0; k < 3; k += 1) { heading('####', title(), ` {icon=${pick(ICONS)}}`); lines.push('', `${words(14)}.`, '') } },
    // 8: a quote
    () => { heading('###', title()); lines.push(`{quote} ${id()}`, '', `> ${words(30)}.`, `> ${words(12)}.`, '>', `> — ${words(2)}, *${words(4)}*`) },
    // 9: a table
    () => { heading('###', title()); lines.push(id(), '', `| ${words(1)} | ${words(1)} | ${words(1)} |`, '| --- | --- | --- |'); for (let k = 0; k < 5; k += 1) lines.push(`| ${words(2)} | ${words(3)} | ${words(2)} |`) },
    // 10: fenced code
    () => { heading('###', title()); lines.push(id(), '', '```python', '## not a heading', 'def read(path):', '    {cards}', `    return open(path).read()  # ${words(6)}`, '```', '', `${words(16)}.`) },
    // 11: a statement, the layout line written in the content (old style)
    () => { heading('###', title()); lines.push('', `${words(9)}.`, '', `{statement=tint} ${id()}`) },
    // 12: an image grid, one picture a data URI
    (n) => { heading('###', title()); lines.push(`{image-grid} ${id()}`, '', picture(n), picture(n + 1), n % 40 === 12 ? `![inline](${DATA_URI})` : picture(n + 2), picture(n + 3)) }
  ]

  let made = 0
  let section = 0
  while (made < slides) {
    section += 1
    heading('##', `Section ${section}: ${title()}`, section % 3 === 0 ? ' {icon=lucide:folder}' : '')
    lines.push(id(), '')
    const inSection = 6 + Math.floor(next() * 8)
    for (let k = 0; k < inSection && made < slides; k += 1) {
      // A nested section now and then: a `###` divider with `####` slides under it.
      if (next() < 0.08) {
        heading('###', `Part: ${title()}`); lines.push(id(), '')
        for (let j = 0; j < 3 && made < slides; j += 1) { heading('####', title()); lines.push(id(), ''); list(3, false); lines.push(''); made += 1 }
        continue
      }
      body[made % body.length](made)
      notes()
      lines.push('')
      made += 1
    }
  }
  return { text: lines.join('\n') + '\n', headings, carouselHeadingLine, listHeadingLine }
}
