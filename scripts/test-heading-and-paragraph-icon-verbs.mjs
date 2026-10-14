// test:heading-and-paragraph-icon-verbs — plain view ticket 07: setHeadingIcon and
// setParagraphIcon (compiler/scripts/lib/12-outline-edit.mjs) write into the person's outline, so
// each case checks two things: the one token is set or removed, and every other line and every
// other character of the edited line is byte-identical.
//
// Both verbs return { ok: true, text, changed } or a refusal { ok: false, text (as given), reason }
// (fix round 2: they verify their own result by compiling and refuse otherwise). `headText` and
// `paraText` are the verbs for a case that must succeed: they assert `ok` and give the text.
// `refused` gives the reason and asserts that the outline came back byte-identical.
// setParagraphIcon takes a 1-based line number only.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { setHeadingIcon as rawSetHeadingIcon, setParagraphIcon as rawSetParagraphIcon } from '../compiler/scripts/lib/12-outline-edit.mjs'
import { prepareSource, adaptMarkdownOutlineV2 } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { iconSvg } from '../compiler/scripts/lib/05-icons.mjs'

let checks = 0
const ok = (cond, label) => { assert.ok(cond, label); checks += 1 }
const eq = (a, b, label) => { assert.equal(a, b, label); checks += 1 }

// Only line `index` (0-based) differs between the two texts, under the given line ending.
function onlyLineChanged(before, after, index, eol = '\n') {
  const a = before.split(eol)
  const b = after.split(eol)
  eq(b.length, a.length, 'line count unchanged')
  a.forEach((line, i) => { if (i !== index) eq(b[i], line, `line ${i + 1} untouched`) })
  return b[index]
}
const ref = (heading, occurrence = 1) => ({ heading, occurrence })
const succeed = (verb) => (text, target, key) => {
  const result = verb(text, target, key)
  assert.equal(result.ok, true, `expected the edit to be made, got ${JSON.stringify(result.reason)}`)
  assert.equal(result.changed, result.text !== text, '`changed` says whether the text differs')
  return result.text
}
const setHeadingIcon = succeed(rawSetHeadingIcon)
const setParagraphIcon = succeed(rawSetParagraphIcon)
const refused = (verb, text, target, key) => {
  const result = verb(text, target, key)
  assert.equal(result.ok, false, 'expected a refusal')
  assert.equal(result.text, text, 'a refusal returns the outline byte-identical')
  assert.equal('changed' in result, false)
  return result.reason
}
const notParagraph = (text, line, key, label) => eq(refused(rawSetParagraphIcon, text, line, key), 'not-a-paragraph', label)

// ── setHeadingIcon ───────────────────────────────────────────────────────────
{
  // No tokens: the token is appended after the title; removing it restores the bytes.
  const src = '# Talk\n\n## Section\n\n### What riders ask for\n\nRiders ask.\n'
  const set = setHeadingIcon(src, ref('### What riders ask for'), 'lucide:bike')
  eq(onlyLineChanged(src, set, 4), '### What riders ask for {icon=lucide:bike}', 'heading with no tokens gains the token')
  eq(setHeadingIcon(set, ref('### What riders ask for {icon=lucide:bike}'), null), src, 'removing restores the outline byte for byte')
  eq(setHeadingIcon(src, ref('### What riders ask for'), null), src, 'removing where there is none changes nothing')
  assert.deepEqual(rawSetHeadingIcon(src, ref('### What riders ask for'), 'lucide:bike'), { ok: true, text: set, changed: true }); checks += 1
  assert.deepEqual(rawSetHeadingIcon(src, ref('### What riders ask for'), null), { ok: true, text: src, changed: false }, 'nothing to change is not a refusal'); checks += 1
}
{
  // With {id=…}: the id group stays last and verbatim; the icon goes before it.
  const src = '### What riders ask for {id=ab12}\n\n- one\n'
  const set = setHeadingIcon(src, ref('### What riders ask for {id=ab12}'), 'lucide:bike')
  eq(onlyLineChanged(src, set, 0), '### What riders ask for {icon=lucide:bike} {id=ab12}', 'icon written before the id group')
  const swapped = setHeadingIcon(set, ref('### What riders ask for {icon=lucide:bike} {id=ab12}'), 'lucide:route')
  eq(swapped.split('\n')[0], '### What riders ask for {icon=lucide:route} {id=ab12}', 'an existing icon is replaced in place')
  eq(setHeadingIcon(swapped, ref('### What riders ask for {icon=lucide:route} {id=ab12}'), null), src, 'removal leaves {id=…} and its spacing')
}
{
  // A layout token and an option token on the same line, with uneven spacing: all kept verbatim.
  const src = '### How it works  {iconlist}{reveal}   {title-icon=above} {id=x9}\nbody\n'
  const heading = src.split('\n')[0]
  const set = setHeadingIcon(src, ref(heading), 'lucide:route')
  eq(onlyLineChanged(src, set, 0), '### How it works {icon=lucide:route}  {iconlist}{reveal}   {title-icon=above} {id=x9}', 'other tokens and their spacing are untouched')
  eq(setHeadingIcon(set, ref(set.split('\n')[0]), null), src, 'round trip is exact')
}
{
  // The icon shares a brace group with other tokens (the drawing's written form).
  const src = '## How it works {icon=lucide:route title-icon=above}\n'
  const heading = src.split('\n')[0]
  eq(setHeadingIcon(src, ref(heading), 'lucide:bike'), '## How it works {icon=lucide:bike title-icon=above}\n', 'token replaced inside a shared group')
  eq(setHeadingIcon(src, ref(heading), null), '## How it works {title-icon=above}\n', 'token removed, its neighbour kept')
  const mid = '## T {titletop icon=lucide:route title-icon=above} {id=a1}\n'
  eq(setHeadingIcon(mid, ref(mid.split('\n')[0]), null), '## T {titletop title-icon=above} {id=a1}\n', 'token removed from the middle of a group')
}
{
  // Braces inside the title text are title, not tokens.
  const src = '### The set {a, b} explained\n\n- x\n'
  const set = setHeadingIcon(src, ref('### The set {a, b} explained'), 'lucide:bike')
  eq(set.split('\n')[0], '### The set {a, b} explained {icon=lucide:bike}', 'braces in the title are left alone')
}
{
  // CRLF: every line keeps its \r, the edited one included. The ref comes from an LF buffer.
  const src = '# Talk\r\n\r\n### What riders ask for {id=ab12}\r\n\r\n- one\r\n'
  const set = setHeadingIcon(src, ref('### What riders ask for {id=ab12}'), 'lucide:bike')
  eq(onlyLineChanged(src, set, 2, '\r\n'), '### What riders ask for {icon=lucide:bike} {id=ab12}', 'CRLF heading edited')
  ok(!/[^\r]\n/.test(set), 'no line lost its \\r')
  eq(setHeadingIcon(set, ref('### What riders ask for {icon=lucide:bike} {id=ab12}'), null), src, 'CRLF round trip is exact')
}
{
  // The second of two identical headings; a heading inside a code fence is not a slide.
  const src = '### Same\n\n```\n### Same\n```\n\n### Same\n\ntext\n'
  const set = setHeadingIcon(src, ref('### Same', 2), 'lucide:bike')
  eq(onlyLineChanged(src, set, 6), '### Same {icon=lucide:bike}', 'occurrence 2 is the second real heading')
}
eq(refused(rawSetHeadingIcon, '### A\n', ref('### Missing'), 'lucide:bike'), 'slide-not-found', 'no such slide: refused')
eq(refused(rawSetHeadingIcon, '### A\n', ref('### A'), 'no-such-icon-name-anywhere'), 'unknown-icon', 'a key that resolves to no icon is refused')
eq(refused(rawSetParagraphIcon, '### A\n\ntext\n', 3, 'no-such-icon-name-anywhere'), 'unknown-icon')
for (const bad of [{ line: 3 }, { heading: '### A' }, '3', null, undefined, 2.5]) {
  assert.throws(() => rawSetParagraphIcon('### A\n\ntext\n', bad, 'lucide:bike'), /takes a 1-based line number/, `target ${JSON.stringify(bad)}: only a line number is a target`); checks += 1
}
for (const bad of ['a}{id=zz', 'a b', 'x\ny', '', 'a}\n### New slide']) {
  assert.throws(() => rawSetHeadingIcon('### A\n', ref('### A'), bad), /not an icon key/, `key ${JSON.stringify(bad)} is refused`); checks += 1
  assert.throws(() => rawSetParagraphIcon('### A\n\ntext\n', 3, bad), /not an icon key/); checks += 1
}

// ── setParagraphIcon ─────────────────────────────────────────────────────────
{
  // A two-line paragraph addressed by either of its lines: the token goes on the last line.
  const src = '### A safe lane\n\nA safe lane for the whole trip is the request riders make most often,\nahead of price and dock position.\n\n- a list item\n'
  for (const line of [3, 4]) {
    const set = setParagraphIcon(src, line, 'lucide:route')
    eq(onlyLineChanged(src, set, 3), 'ahead of price and dock position. {icon=lucide:route}', 'token at the end of the paragraph')
    eq(setParagraphIcon(set, line, null), src, 'removal restores the outline')
  }
  for (const line of [6, 1, 2, 5, 7, 8, 0, -1, 99]) notParagraph(src, line, 'lucide:route', `line ${line} is not in a paragraph`)
}
{
  // Text that itself contains braces, including a trailing ordinary brace group.
  const src = '### Sets\n\nWrite the set {a, b} and the map {k: v}.\n\nIt ends in braces {a, b}\n'
  const one = setParagraphIcon(src, 3, 'lucide:bike')
  eq(onlyLineChanged(src, one, 2), 'Write the set {a, b} and the map {k: v}. {icon=lucide:bike}', 'braces in the text are untouched')
  eq(setParagraphIcon(one, 3, 'lucide:route').split('\n')[2], 'Write the set {a, b} and the map {k: v}. {icon=lucide:route}', 'existing icon replaced, braces kept')
  eq(setParagraphIcon(one, 3, null), src, 'removal keeps the text braces')
  const two = setParagraphIcon(src, 5, 'lucide:bike')
  eq(onlyLineChanged(src, two, 4), 'It ends in braces {a, b} {icon=lucide:bike}', 'a trailing ordinary brace group is not taken for the icon')
  eq(setParagraphIcon(src, 5, null), src, 'removing where there is no icon leaves trailing braces alone')
}
{
  // Not paragraphs: quote, list, table, image, fenced code, comment, Trigger line.
  const src = ['### Mixed', '{list}', '> a quote', '', '| a | b |', '|---|---|', '', '![alt](x.png)', '', '```js', 'const a = {icon=1}', '```', '', '<!-- note', 'hidden text', '-->', '', 'The real paragraph.', ''].join('\n')
  for (const line of [2, 3, 5, 8, 11, 15]) {
    notParagraph(src, line, 'lucide:bike', `line ${line} is not a paragraph`)
  }
  const set = setParagraphIcon(src, 18, 'lucide:bike')
  eq(onlyLineChanged(src, set, 17), 'The real paragraph. {icon=lucide:bike}', 'the real paragraph past the other blocks is edited')
}
{
  // CRLF.
  const src = '### A\r\n\r\nOne line.\r\nTwo line.\r\n'
  const set = setParagraphIcon(src, 3, 'lucide:bike')
  eq(onlyLineChanged(src, set, 3, '\r\n'), 'Two line. {icon=lucide:bike}', 'CRLF paragraph edited')
  eq(setParagraphIcon(set, 4, null), src, 'CRLF round trip is exact')
}

// ── Review round 1 ───────────────────────────────────────────────────────────
// The compiled deck, to check an edit against what the compiler then draws.
const compile = async (text) => {
  const model = await prepareSource('/nowhere/t-outline.md', text, 't', { isDirectory: () => false })
  const doc = new JSDOM(model.fullHtml).window.document
  const norm = (html) => { const el = doc.createElement('div'); el.innerHTML = html; return el.innerHTML }
  return { doc, has: (el, key) => !!el && el.innerHTML.includes(norm(iconSvg(key))) }
}
const K = 'lucide:bike'
const TOKEN = ` {icon=${K}}`

{
  // B1: speaker notes and their markers are not the slide's content.
  const src = '### A\n\n:::notes\nPrivate note.\n:::\n\nVisible.\n'
  const set = setParagraphIcon(src, 7, K)
  eq(set, '### A\n\n:::notes\nPrivate note.\n:::\n\nVisible. {icon=lucide:bike}\n', 'B1: the visible paragraph past the notes; the `:::` marker is untouched')
  for (const line of [3, 4, 5]) notParagraph(src, line, K, `B1: line ${line} is notes`)
  // (Front matter makes this a v2 outline; the legacy adapter draws no paragraph icon.)
  const { doc, has } = await compile(`---\ntitle: T\n---\n\n${set}`)
  const p = doc.querySelector('section.slide[data-nav-title="A"] p.content-p[data-para-icon]')
  ok(p && p.textContent.includes('Visible.') && has(p, K), 'B1: the slide body still holds the paragraph, with its icon')
  // Nothing visible: nothing to change.
  const only = '### A\n\n:::notes\nPrivate note.\n:::\n'
  for (const line of [1, 2, 3, 4, 5, 6]) notParagraph(only, line, K, `B1: a slide with notes only has no paragraph (line ${line})`)
  const open = '### A\n\n:::notes\nA note with no closing marker.\n\n### B\n\nBody of B.\n'
  for (const line of [3, 4, 5]) notParagraph(open, line, K, 'B1: unclosed notes run to the next heading')
  eq(setParagraphIcon(open, 8, K), open.replace('Body of B.', 'Body of B. {icon=lucide:bike}'), 'B1: the next slide is its own')
  // Notes in the middle of the content; fenced code inside notes.
  const mid = '### A\n\n:::notes\n```\n:::\n```\nstill a note\n:::\n\nAfter.\n'
  eq(setParagraphIcon(mid, 10, K), mid.replace('After.', 'After. {icon=lucide:bike}'), 'B1: a `:::` inside a fence inside notes does not end the notes')
  for (const line of [3, 4, 5, 6, 7, 8]) notParagraph(mid, line, K, `B1: line ${line} is inside the notes`)
}
{
  // The first VISIBLE CONTENT paragraph: not a claim, a bare-URL embed, a promoted quotation or a Trigger line.
  const src = '### A\n{list}\n\n**A wholly bold line is a claim.**\n\nhttps://example.org/page\n\n"A quoted statement is a quotation."\n\nThe real paragraph.\n\nA second one.\n'
  eq(setParagraphIcon(src, 10, K), src.replace('The real paragraph.', 'The real paragraph. {icon=lucide:bike}'), 'the paragraph the compiler renders as a paragraph')
  for (const line of [2, 4, 6, 8]) notParagraph(src, line, K, `line ${line} is not a content paragraph`)
  const none = '### A\n\n- only a list\n\n> and a quotation\n'
  for (const line of [3, 5]) { notParagraph(none, line, K, 'a list item and a quotation are not paragraphs'); notParagraph(none, line, null, 'nor for a removal') }
}
{
  // B5: a `###` line in the front matter (a YAML comment) or in an HTML comment is not a slide.
  const src = '---\ntitle: Talk\n### Same\n---\n### Same\n\nBody.\n'
  eq(setHeadingIcon(src, ref('### Same'), K), '---\ntitle: Talk\n### Same\n---\n### Same {icon=lucide:bike}\n\nBody.\n', 'B5: the heading edited is the slide, not the front-matter line')
  eq(setParagraphIcon(src, 7, K), '---\ntitle: Talk\n### Same\n---\n### Same\n\nBody. {icon=lucide:bike}\n', 'B5: the paragraph verb edits the slide body')
  eq(refused(rawSetHeadingIcon, src, ref('### Same', 2), K), 'slide-not-found', 'B5: there is one such slide')
  for (const line of [1, 2, 3, 4]) notParagraph(src, line, K, 'B5: a front-matter line is not a paragraph')
  const { doc, has } = await compile(setHeadingIcon(src, ref('### Same'), K))
  ok(has(doc.querySelector('section.slide[data-nav-title="Same"] h1 .title-icon'), K), 'B5: the edited outline compiles to the icon on that slide')
  const commented = '# T\n\n<!--\n### Hidden\n\nold text\n-->\n\n### Hidden\n\nReal.\n'
  eq(setHeadingIcon(commented, ref('### Hidden'), K), commented.replace('-->\n\n### Hidden', '-->\n\n### Hidden {icon=lucide:bike}'), 'B5: a commented-out heading is not a slide')
  eq(setParagraphIcon(commented, 11, K), commented.replace('Real.', 'Real. {icon=lucide:bike}'), 'B5: the real slide\'s paragraph is edited')
  for (const line of [3, 4, 5, 6, 7]) notParagraph(commented, line, K, 'B5: nor is the commented-out text a paragraph')
}
{
  // B4: the verbs splice. set → remove returns the original bytes; replace changes the key only.
  const paragraphs = [
    'Hello.', 'Hello.   ', 'Hello.\t', 'Hello. \t ', '  Indented text.  ', 'Hello {a, b}', 'Hello {a, b}  ',
    'See https://example.org/{icon=lucide:route}', 'Literal \\{icon=lucide:route}', 'Hello {icon=lucide:route} {b}',
    'Mid {icon=lucide:route} sentence.', 'Code `x {icon=lucide:route}`', 'Link [a](https://example.org/{icon=lucide:route})'
  ]
  for (const eol of ['\n', '\r\n']) {
    for (const line of paragraphs) {
      const src = ['# T', '', '### A', '', line, '', '- x', ''].join(eol)
      const set = setParagraphIcon(src, 5, K)
      const textEnd = line.trimEnd().length
      eq(set.split(eol)[4], line.slice(0, textEnd) + TOKEN + line.slice(textEnd), `B4 paragraph ${JSON.stringify(line)}: one space and the token after the last non-space character, the rest kept`)
      onlyLineChanged(src, set, 4, eol)
      eq(setParagraphIcon(set, 5, null), src, `B4 paragraph ${JSON.stringify(line)}: set then remove is the original`)
      eq(setParagraphIcon(set, 5, 'lucide:star'), set.split(TOKEN).join(' {icon=lucide:star}'), `B4 paragraph ${JSON.stringify(line)}: replacing changes the key only`)
      eq(setParagraphIcon(setParagraphIcon(set, 5, 'lucide:star'), 5, null), src, 'B4: set, replace, remove is the original')
    }
  }
  // A token written by hand with its own spacing: only the key, or the token and one space, change.
  const hand = '### A\n\nHello.   {  icon = lucide:route }  \n'
  eq(setParagraphIcon(hand, 3, K), '### A\n\nHello.   {  icon = lucide:bike }  \n', 'B4: replacing keeps the spacing around and inside an existing token')
  eq(setParagraphIcon(hand, 3, null), '### A\n\nHello.    \n', 'B4: removing deletes the token and one space before it, nothing else')
  eq(setParagraphIcon('### A\n\nHello.\t{icon=lucide:route}\n', 3, null), '### A\n\nHello.\t\n', 'B4: a tab before the token is not the token\'s space')

  const headings = [
    '### A', '### A   ', '### A\t', '### A {id=x1}  ', '### A  {iconlist}{reveal}   {title-icon=above} {id=x9}',
    '### The set {a, b} explained', '### See https://example.org/{icon=lucide:route}', '### Literal \\{icon=lucide:route}',
    '### A {id=x1} then text', '### A {id=x1}\t{reveal} \t'
  ]
  for (const eol of ['\n', '\r\n']) {
    for (const line of headings) {
      const src = ['# T', '', line, '', 'Body.', ''].join(eol)
      const set = setHeadingIcon(src, ref(line), K)
      const after = onlyLineChanged(src, set, 2, eol)
      eq(after.length, line.length + TOKEN.length, `B4 heading ${JSON.stringify(line)}: only the token is added`)
      eq(after.split(TOKEN).join(''), line, `B4 heading ${JSON.stringify(line)}: every other character is where it was`)
      eq(setHeadingIcon(set, ref(after), null), src, `B4 heading ${JSON.stringify(line)}: set then remove is the original`)
      const swapped = setHeadingIcon(set, ref(after), 'lucide:star')
      eq(swapped, set.split(TOKEN).join(' {icon=lucide:star}'), `B4 heading ${JSON.stringify(line)}: replacing changes the key only`)
      eq(setHeadingIcon(swapped, ref(swapped.split(eol)[2]), null), src, 'B4: set, replace, remove is the original')
    }
  }
  eq(setHeadingIcon('### A   {icon=lucide:route}  {id=x1}\n', ref('### A   {icon=lucide:route}  {id=x1}'), null), '### A    {id=x1}\n', 'B4: removing deletes the group and one space before it')
  // Braces glued to the title's text are text: the verb adds its own group and never edits them.
  for (const line of ['### See https://example.org/{icon=lucide:route}', '### Literal \\{icon=lucide:route}']) {
    const set = setHeadingIcon(`# T\n\n${line}\n\nBody.\n`, ref(line), K)
    eq(set.split('\n')[2], `${line} {icon=lucide:bike}`, 'B3/B4: a glued group is left as written')
    const { doc, has } = await compile(set)
    const icons = [...doc.querySelectorAll('section.slide h1 .title-icon')]
    ok(icons.length === 1 && has(icons[0], K), 'the edited heading compiles to the icon asked for')
  }
}
{
  // S10: several icon tokens on one heading. Set leaves one (the first, with the new key); remove deletes all.
  const cases = [
    ['### A {icon=lucide:bike icon=lucide:route}', '### A {icon=lucide:star}', '### A'],
    ['### A {icon=lucide:bike} {id=x1} {icon=lucide:route}', '### A {icon=lucide:star} {id=x1}', '### A {id=x1}'],
    ['### A {icon=lucide:bike icon=lucide:route titletop}', '### A {icon=lucide:star titletop}', '### A {titletop}'],
    ['### A {titletop icon=lucide:bike, icon=lucide:route}  {icon=lucide:zap title-icon=above}', '### A {titletop icon=lucide:star}  {title-icon=above}', '### A {titletop}  {title-icon=above}']
  ]
  for (const [line, afterSet, afterRemove] of cases) {
    const src = `# T\n\n${line}\n\nBody.\n`
    const set = setHeadingIcon(src, ref(line), 'lucide:star')
    eq(set.split('\n')[2], afterSet, `S10 ${line}: set leaves exactly one icon token, in the first one's place`)
    eq(setHeadingIcon(src, ref(line), null).split('\n')[2], afterRemove, `S10 ${line}: remove deletes every icon token`)
    const { doc, has } = await compile(set)
    ok(has(doc.querySelector('section.slide[data-nav-title="A"] h1 .title-icon'), 'lucide:star'), `S10 ${line}: the result compiles to the icon asked for`)
    const gone = await compile(setHeadingIcon(src, ref(line), null))
    ok(!gone.doc.querySelector('section.slide[data-nav-title="A"] .title-with-icon'), `S10 ${line}: after remove no icon is drawn`)
  }
}

// ── Review round 2: the verbs verify their own result by compiling ───────────
// What the full adapter then reports for an outline: per slide its title, title icon, notes and blocks.
const slidesOf = (text) => adaptMarkdownOutlineV2(text, 't', {}).slides.map((slide) => ({
  title: slide.title, titleIcon: slide.titleIcon || '', notes: slide.notes, blocks: slide.blocks
}))
const paragraphs = (text) => {
  const out = []
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== 'object') return
    if (value.type === 'paragraph') out.push([value.text, value.icon || ''])
    Object.values(value).forEach(walk)
  }
  walk(slidesOf(text).map((slide) => slide.blocks))
  return out
}
const visible = (text) => JSON.stringify(slidesOf(text), (key, value) => (key === 'icon' || key === 'titleIcon' || key === 'titleIconAt' ? undefined : value))
const rawTokens = (text) => (visible(text).match(/\{\s*icon\s*=/g) || []).length
{
  // F1: a stray Trigger line inside the paragraph. The compiler takes that line out, so the
  // paragraph is `One Two.` and the token belongs after `Two.`, whichever line is named.
  const src = '### A\n\nOne\n{reveal}\nTwo.'
  for (const line of [3, 5]) {
    const set = setParagraphIcon(src, line, 'lucide:star')
    eq(set, '### A\n\nOne\n{reveal}\nTwo. {icon=lucide:star}', `F1: the token goes after the paragraph's last line (line ${line} named)`)
    assert.deepEqual(paragraphs(`# T\n\n${set}`), [['One Two.', 'lucide:star']], 'F1: it compiles to one paragraph with the icon and no raw token'); checks += 1
    eq(setParagraphIcon(set, line, null), src, 'F1: removal restores the outline')
  }
  notParagraph(src, 4, 'lucide:star', 'F1: the Trigger line itself is not a paragraph line')
  const two = '### A\n\nOne\n{reveal}\n{icons}\nTwo.\n:::notes\nN\n:::\nThree.\n'
  eq(setParagraphIcon(two, 3, K), two.replace('Three.', 'Three. {icon=lucide:bike}'), 'F1: Trigger lines and notes between its lines do not end the paragraph')
}
{
  // F2: a trailing HTML comment. An existing token before it is replaced and removed in place;
  // a new token is not written on a line that carries a comment.
  const src = '### A\n\nHello. {icon=lucide:bike} <!-- trailing comment -->'
  const set = setParagraphIcon(src, 3, 'lucide:star')
  eq(set, '### A\n\nHello. {icon=lucide:star} <!-- trailing comment -->', 'F2: the existing token is replaced, before the comment')
  assert.deepEqual(paragraphs(`# T\n\n${set}`), [['Hello.', 'lucide:star']], 'F2: one icon, no raw token'); checks += 1
  eq(rawTokens(`# T\n\n${set}`), 0, 'F2: no raw token is visible')
  eq(setParagraphIcon(src, 3, null), '### A\n\nHello. <!-- trailing comment -->', 'F2: removal takes the token out and leaves the comment')
  assert.deepEqual(paragraphs(`# T\n\n${setParagraphIcon(src, 3, null)}`), [['Hello.', '']]); checks += 1
  for (const bare of ['### A\n\nHello. <!-- trailing comment -->', '### A\n\n<!-- leading --> Hello.', '### A\n\nHello <!-- mid --> there.', '### A\n\nHello. <!-- opens\nand closes --> tail']) {
    eq(refused(rawSetParagraphIcon, bare, 3, 'lucide:star'), 'cannot-place-here', `F2: no new token beside a comment: ${JSON.stringify(bare)}`)
  }
  // A comment inside the token: only the characters the compiler read are replaced, the comment stays.
  const inside = '### A\n\nHello. {icon=lucide:<!-- x -->bike}'
  const through = setParagraphIcon(inside, 3, 'lucide:star')
  ok(through.includes('<!-- x -->') && through.replace('<!-- x -->', '') === '### A\n\nHello. {icon=lucide:star}', 'F2: a comment inside the token is kept; the key around it is replaced')
  assert.deepEqual(paragraphs(`# T\n\n${through}`), [['Hello.', 'lucide:star']]); checks += 1
  // The heading verb maps through a comment as well.
  const head = '### A {icon=lucide:bike} <!-- c --> {id=x1}\n\nBody.\n'
  eq(setHeadingIcon(head, ref(head.split('\n')[0]), 'lucide:star'), head.replace('lucide:bike', 'lucide:star'), 'F2: heading token beside a comment is replaced in place')
  eq(setHeadingIcon(head, ref(head.split('\n')[0]), null), '### A <!-- c --> {id=x1}\n\nBody.\n', 'F2: and removed in place')
  const plain = '### A <!-- c -->\n\nBody.\n'
  const withIcon = setHeadingIcon(plain, ref('### A <!-- c -->'), K)
  eq(withIcon, '### A {icon=lucide:bike} <!-- c -->\n\nBody.\n', 'F2: a new heading token goes after the title text, before the comment')
  eq(slidesOf(`# T\n\n${withIcon}`).find((slide) => slide.title === 'A').titleIcon, K, 'F2: and compiles to the title icon')
}
{
  // F4: a line inside speaker notes is refused, also when a visible paragraph spans the notes.
  const src = '### A\nOne\n:::notes\nSecret\n:::\nTwo.'
  for (const line of [3, 4, 5]) notParagraph(src, line, 'lucide:star', `F4: line ${line} is notes`)
  eq(setParagraphIcon(src, 2, 'lucide:star'), '### A\nOne\n:::notes\nSecret\n:::\nTwo. {icon=lucide:star}', 'F4: the visible paragraph is `One Two.`; its token goes after `Two.`')
  assert.deepEqual(paragraphs('# T\n\n### A\nOne\n:::notes\nSecret\n:::\nTwo. {icon=lucide:star}'), [['One Two.', 'lucide:star']]); checks += 1
  // Other places that are not a visible paragraph of a slide.
  const places = ['---', 'title: T', '---', 'Before any slide.', '', '# T', '', '### A', '', '```', 'code line', '```', '', '[Embed: https://example.org]', '', '1. numbered', '', '| a |', '|---|', '', '**A claim.**', ''].join('\n')
  for (const line of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 14, 16, 18, 19, 21]) notParagraph(places, line, K, `F4: line ${line} of the places outline is not a paragraph`)
}
{
  // F5: an `icon=` on the slide's Trigger line does not decide the title's icon (it never drew
  // anything), so the heading verb's edit is what the compiler then reports.
  const src = '### A {icon=lucide:bike}\n{icon=lucide:route}\n\nBody.'
  const set = setHeadingIcon(src, ref('### A {icon=lucide:bike}'), 'lucide:star')
  eq(set, '### A {icon=lucide:star}\n{icon=lucide:route}\n\nBody.', 'F5: the heading token is replaced; the Trigger line is untouched')
  eq(slidesOf(`# T\n\n${set}`).find((slide) => slide.title === 'A').titleIcon, 'lucide:star', 'F5: the compiler reports the icon asked for')
  const removed = setHeadingIcon(src, ref('### A {icon=lucide:bike}'), null)
  eq(removed, '### A\n{icon=lucide:route}\n\nBody.', 'F5: removal takes the heading token only')
  eq(slidesOf(`# T\n\n${removed}`).find((slide) => slide.title === 'A').titleIcon, '', 'F5: and no title icon is drawn')
}
{
  // The handlers hand the verb's result to the renderer as it is, refusal included, and take a line.
  const main = readFileSync(fileURLToPath(new URL('../src/main/index.ts', import.meta.url)), 'utf8')
  ok(/'outline:set-heading-icon'[\s\S]{0,1100}?return setHeadingIcon\(content, \{ heading: slideHeading, occurrence: slideOccurrence \|\| 1 \}, iconKey\)/.test(main), 'the heading handler returns the verb result')
  ok(/'outline:set-paragraph-icon'[\s\S]{0,400}?line: number[\s\S]{0,400}?return setParagraphIcon\(content, line, iconKey\)/.test(main), 'the paragraph handler takes a line and returns the verb result')
}

// Property: over the repository's example outlines, for EVERY line, setParagraphIcon either refuses
// and returns the text byte-identical, or succeeds and then (checked here through the full
// adapter, not the verb's own check): no visible text changed, at most one more paragraph icon is
// reported and it is the one asked for, no raw `{icon=` became visible, exactly one line changed,
// and removing gives back the outline as it was without that paragraph's icon (byte for byte the
// original when the paragraph had none). The same for setHeadingIcon over every heading line.
{
  const REPO = fileURLToPath(new URL('..', import.meta.url))
  const vault = join(REPO, 'resources', 'example-vault')
  const files = readdirSync(vault, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => join(vault, entry.name, `${entry.name}-outline.md`))
  const fixtures = join(REPO, 'scripts', 'fixtures', 'icons-on-titles')
  for (const name of readdirSync(fixtures).filter((entry) => entry.endsWith('-outline.md')).sort()) files.push(join(fixtures, name))
  ok(files.length >= 7, 'the five example talks and the icons-on-titles fixtures are all read')
  const PROBE = 'lucide:sailboat'
  let made = 0
  let refusals = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    ok(!text.includes(PROBE), `${file} does not use the probe icon`)
    const lines = text.split('\n')
    const wasVisible = visible(text)
    const wasTokens = rawTokens(text)
    const wasIcons = paragraphs(text).filter(([, icon]) => icon).length
    const check = (result, label, { title = false } = {}) => {
      if (!result.ok) { assert.equal(result.text, text, `${label}: a refusal returns the text byte-identical`); assert.ok(typeof result.reason === 'string' && result.reason); refusals += 1; return false }
      assert.equal(result.changed, true, `${label}: the probe icon is new, so a success is a change`)
      const after = result.text.split('\n')
      assert.equal(after.length, lines.length, `${label}: line count`)
      assert.equal(after.filter((line, i) => line !== lines[i]).length, 1, `${label}: exactly one line changed`)
      assert.equal(visible(result.text), wasVisible, `${label}: no visible text changed`)
      assert.ok(rawTokens(result.text) <= wasTokens, `${label}: no raw {icon= became visible`)
      const nowParagraphs = paragraphs(result.text)
      const nowIcons = nowParagraphs.filter(([, icon]) => icon).length
      if (title) assert.equal(nowIcons, wasIcons, `${label}: a title edit moves no paragraph icon`)
      else {
        assert.ok(nowIcons === wasIcons || nowIcons === wasIcons + 1, `${label}: at most one more paragraph icon (${wasIcons} → ${nowIcons})`)
        assert.ok(nowParagraphs.filter(([, icon]) => icon === PROBE).length <= 1, `${label}: one paragraph at most carries the probe`)
      }
      made += 1
      return true
    }
    lines.forEach((_, i) => {
      const label = `${file}:${i + 1}`
      const set = rawSetParagraphIcon(text, i + 1, PROBE)
      const bare = rawSetParagraphIcon(text, i + 1, null)
      if (!check(set, label)) { assert.equal(bare.text, text, `${label}: a line that refuses a set is not changed by a remove either`); return }
      assert.equal(bare.ok, true, `${label}: a paragraph line accepts a remove`)
      if (!bare.changed) assert.equal(bare.text, text)
      const back = rawSetParagraphIcon(set.text, i + 1, null)
      assert.deepEqual(back, { ok: true, text: bare.text, changed: true }, `${label}: set then remove is the outline without that paragraph's icon`)
      if (!bare.changed) assert.equal(back.text, text, `${label}: byte for byte the original`)
    })
    const seen = new Map()
    lines.forEach((line, i) => {
      if (!/^#{2,6}\s/.test(line)) return
      seen.set(line, (seen.get(line) || 0) + 1)
      const label = `${file}:${i + 1} (heading)`
      const target = ref(line, seen.get(line))
      const set = rawSetHeadingIcon(text, target, PROBE)
      if (!check(set, label, { title: true })) return
      const bare = rawSetHeadingIcon(text, target, null)
      const back = rawSetHeadingIcon(set.text, ref(set.text.split('\n').find((entry, k) => entry !== lines[k]), seen.get(line)), null)
      assert.equal(back.ok, true, `${label}: the set heading accepts a remove`)
      assert.equal(back.text, bare.text, `${label}: set then remove is the outline without that title's icon`)
      if (!bare.changed) assert.equal(back.text, text, `${label}: byte for byte the original`)
    })
  }
  ok(made > 100 && refusals > 100, `the property loop both made edits (${made}) and refused lines (${refusals})`)
  checks += made + refusals
}

// ── Third fix round: a title that is not shown, and a talk in the older outline format ────────
{
  const V2 = '---\noutline_version: 2\n---\n'
  const adapterOf = async (text) => (await prepareSource('legacy-format-outline.md', text, 'legacy-format')).adapter
  // The first code on a talk in the older outline format moves it to the current format, as
  // setting a layout does. The verb makes the edit; which format a talk is read in is the talk's.
  const v1 = '# Talk\n\n### A\n\nHello.\n\n### B\n\nBody.\n'
  eq(await adapterOf(v1), 'markdown-outline-v1', 'the talk is in the older outline format before the edit')
  const set = rawSetHeadingIcon(v1, ref('### A'), 'lucide:star')
  assert.deepEqual(set, { ok: true, text: v1.replace('### A', '### A {icon=lucide:star}'), changed: true }, 'the verb sets the icon on a talk in the older format'); checks += 1
  eq(await adapterOf(set.text), 'markdown-outline-v2', 'and the talk is in the current format after it')

  // A slide whose title is not painted cannot show a title icon: refused, outline unchanged.
  for (const [label, heading] of [['{quote}', '### A {quote}'], ['{notitle}', '### A {notitle}'], ['{title=off}', '### A {title=off}']]) {
    const src = `${V2}# Talk\n\n${heading}\n\nHello.\n`
    eq(refused(rawSetHeadingIcon, src, ref(heading), 'lucide:star'), 'title-not-shown', `${label}: the title is not shown, so the icon is refused`)
  }
  // A statement slide with no body shows its title as the statement, icon and all: accepted.
  {
    const src = `${V2}# Talk\n\n### A {statement}\n\n### B\n\nBody.\n`
    const made = rawSetHeadingIcon(src, ref('### A {statement}'), 'lucide:star')
    assert.deepEqual(made, { ok: true, text: src.replace('### A {statement}', '### A {icon=lucide:star} {statement}'), changed: true }, 'a bodyless statement draws the title with its icon'); checks += 1
  }
  // Removing an icon from a title that is not shown is never refused.
  {
    const src = `${V2}# Talk\n\n### A {icon=lucide:star} {quote}\n\nHello.\n`
    const bare = rawSetHeadingIcon(src, ref('### A {icon=lucide:star} {quote}'), null)
    assert.deepEqual(bare, { ok: true, text: src.replace(' {icon=lucide:star}', ''), changed: true }, 'remove on a hidden title'); checks += 1
  }
  // A title that is shown still takes its icon when another slide's title is hidden.
  {
    const src = `${V2}# Talk\n\n### A {quote}\n\nHello.\n\n### B\n\nBody.\n`
    eq(rawSetHeadingIcon(src, ref('### B'), 'lucide:star').ok, true, 'a shown title on the same talk is accepted')
  }
  // Fourth review, Spec 1: a set of the icon the title already holds is checked like any other
  // set. The slide does not paint its title, so it is refused, with the bytes unchanged.
  {
    const src = '### A {quote} {icon=lucide:star}\n\nHello.\n'
    assert.deepEqual(rawSetHeadingIcon(src, ref('### A {quote} {icon=lucide:star}'), 'lucide:star'), { ok: false, text: src, reason: 'title-not-shown' }, 'an unchanged set on a hidden title is refused'); checks += 1
    // The same icon on a title that is shown: nothing to change, and accepted.
    const shown = `${V2}# Talk\n\n### A {icon=lucide:star}\n\nHello.\n`
    assert.deepEqual(rawSetHeadingIcon(shown, ref('### A {icon=lucide:star}'), 'lucide:star'), { ok: true, text: shown, changed: false }, 'an unchanged set on a shown title'); checks += 1
    // Remove is never refused for visibility, on the hidden title either.
    eq(rawSetHeadingIcon(src, ref('### A {quote} {icon=lucide:star}'), null).ok, true, 'remove on the hidden title that holds the icon')
  }
  // Fourth review, Spec 2: a heading folded into its parent's layout (a card, a column, a carousel
  // or compare panel, an image-grid cell) has no painted title icon, so a set is refused.
  for (const layout of ['cards=grid', 'cards=rows', 'carousel', 'columns', 'compare', 'image-grid']) {
    const src = `${V2}# Talk\n\n### A {${layout}}\n\n#### B\n\nBody B.\n\n#### C\n\nBody C.\n`
    assert.deepEqual(rawSetHeadingIcon(src, ref('#### B'), 'lucide:star'), { ok: false, text: src, reason: 'title-not-shown' }, `{${layout}}: an icon on a folded child heading is refused`); checks += 1
    // An icon already written there by hand: the same set is refused too; a remove takes it out.
    const held = src.replace('#### B', '#### B {icon=lucide:star}')
    assert.deepEqual(rawSetHeadingIcon(held, ref('#### B {icon=lucide:star}'), 'lucide:star'), { ok: false, text: held, reason: 'title-not-shown' }, `{${layout}}: an unchanged set on a folded child is refused`); checks += 1
    assert.deepEqual(rawSetHeadingIcon(held, ref('#### B {icon=lucide:star}'), null), { ok: true, text: src, changed: true }, `{${layout}}: remove on a folded child`); checks += 1
  }
  // A normal slide, and a normal sub-slide, still take their icon, and the compiled slide shows it.
  {
    const src = `${V2}# Talk\n\n## Part\n\n### A\n\nBody.\n\n#### Detail\n\nMore.\n`
    for (const heading of ['### A', '## Part']) {
      const made = rawSetHeadingIcon(src, ref(heading), 'lucide:star')
      assert.deepEqual(made, { ok: true, text: src.replace(`${heading}\n`, `${heading} {icon=lucide:star}\n`), changed: true }, `${heading}: a title that is painted takes the icon`); checks += 1
    }
  }
}

console.log(`test:heading-and-paragraph-icon-verbs — ${checks} checks passed`)
