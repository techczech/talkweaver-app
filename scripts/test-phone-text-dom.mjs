#!/usr/bin/env node
/**
 * The audience page's phone text view at 360×740 (found 2026-09-28):
 *   - the slide text never shows authoring syntax (`**`, `{icon=`, `[QR:`, `\*`) as raw text,
 *     and its bold, italic, code and links render as formatting;
 *   - a very long slide title, or a long unbroken word or URL, never makes the page wider than
 *     the phone (the shell's one grid column used to grow to the phone bar's nowrap title).
 *
 * Real pipeline: outline → prepareSource → compiled deck → extractSlides → buildShareHtml.
 * Set PHONE_TEXT_SHOTS_DIR to also write a screenshot of each checked slide.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { isPhoneHref } from '../compiler/scripts/lib/slide-script-render.mjs'

const LONG_URL = 'https://example.com/a_very_long_path_segment/with_underscores_everywhere/and-no-spaces-at-all/file_name_that_keeps_going.html'
const LONG_WORD = 'Supercalifragilisticexpialidocious'.repeat(4)
const LONG_TITLE = 'Dean W. Ball, Among the Agents, 2026, with a title long enough to run far past the width of any phone screen'

const outline = [
  '---',
  'title: Phone text probe',
  '---',
  '',
  '## Probe',
  '',
  '### Formatting on a phone {list}',
  '',
  '- A **bold** word and an *italic* one',
  '- The snake_case_word stays whole {icon=star}',
  '- Run `code_with_underscores` and `a*b*c` exactly',
  `- See ${LONG_URL} for more`,
  '- Escaped \\*not italic\\* here',
  '- Inline token {w=40} in a line',
  '- Keep {username} and {x} mid-line',
  '',
  '### Scan to follow',
  '',
  'Plain **strong** prose with a [link](https://example.com/a_b) and {icon=star} inline.',
  '',
  '[QR: https://example.com/qr_target | Scan me]',
  '',
  `One unbroken word: ${LONG_WORD}.`,
  '',
  `### ${LONG_TITLE} {quote}`,
  '',
  '> "By the end of this year, the **least important thing** you will be able to do is **chatbots**."',
  '',
  '### A **bold** title with [a link](https://example.com/t_i_tle)',
  '',
  '- body',
  '',
  '### Code keeps its characters',
  '',
  '```js',
  'const total = price*qty*rate // snake_case_name',
  '```',
  '',
  '### A diagram is named, never its source',
  '',
  '```mermaid',
  'graph TD',
  '  Alpha-->Beta',
  '```',
  '',
].join('\n')

const scratch = mkdtempSync(join(tmpdir(), 'tw-phone-text-'))
const shotsDir = process.env.PHONE_TEXT_SHOTS_DIR ? resolve(process.env.PHONE_TEXT_SHOTS_DIR) : null
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

// Payload for the hostile outline: whatever runs sets window.__pwn.
const PWN = (tag) => `[QR: https://a onfocus=window.__pwn='${tag}' autofocus tabindex=0 onmouseover=window.__pwn='${tag}-hover' style=display:block;width:100vw;height:100vh x]`
const HOSTILE_SLIDES = [
  ['Exploit in a list', [`- item [a](https://x/${PWN('li')})`, `- bare https://x/${PWN('url')} end`, `- **[b](https://x/${PWN('strong')})**`]],
  ['Exploit in prose', [`Para see https://x/${PWN('p')} ok`, '', `> quote [q](https://x/${PWN('quote')})`, '', `| h | h2 |`, '|---|---|', `| [c](https://x/${PWN('td')}) | y |`]],
  [`Title [t](https://x/${PWN('title')}) end`, ['- body']],
  ['Schemes', ['- [js](javascript:window.__pwn=1)', '- [mixed](JaVaScRiPt:window.__pwn=1)', '- [entity](&#106;avascript:window.__pwn=1)',
    '- [data](data:text/html,<script>window.__pwn=1</script>)', '- [vb](vbscript:msgbox)', '- [space]( javascript:window.__pwn=1)',
    '- [ctl](\u0001javascript:window.__pwn=1)', `[QR: javascript:window.__pwn=1 | Scan]`]],
  ['Quotes and brackets', ['- [x](https://a"onmouseover=window.__pwn=1)', '- [x"><img src=x onerror=window.__pwn=1>](https://a)',
    `- [QR: https://a" onmouseover="window.__pwn=1 | l"><b>x]`, '- see https://a"onmouseover=window.__pwn=1 now']],
  ['Raw HTML', ['- <img src=x onerror="window.__pwn=1">', '- <svg onload=window.__pwn=1></svg>', '- </script><script>window.__pwn=1</script>',
    '- `<img src=x onerror=window.__pwn=1>`', '- {icon=x"><img src=x onerror=window.__pwn=1>}']],
  ['Nesting', ['- [see https://b.example](https://a.example)', '- [QR: https://a | see [x](https://b)]',
    `- \`[QR: https://a onfocus=window.__pwn=1 autofocus x]\``, '- private 0 use [p](https://x/0)']],
]
const HOSTILE_SLIDE_COUNT = HOSTILE_SLIDES.length
const HOSTILE_OUTLINE = [
  '---', 'title: Hostile probe', '---', '', '## Hostile', '',
  ...HOSTILE_SLIDES.flatMap(([title, lines]) => [`### ${title}`, '', ...lines, '']),
].join('\n')

async function buildHandout(source, name) {
  const outlinePath = join(scratch, `${name}.md`)
  writeFileSync(outlinePath, source, 'utf8')
  const model = await prepareSource(outlinePath, source, name, statSync(outlinePath))
  const deck = await buildDeckHtmlFromModel(model)
  const handoutPath = join(scratch, `${name}.html`)
  writeFileSync(handoutPath, buildShareHtml({
    title: name,
    slides: extractSlides(deck),
    styles: extractStyles(deck),
    includeNotes: false,
    slug: name,
    license: null,
  }))
  return handoutPath
}
const handoutPath = await buildHandout(outline, 'phone-text')

const RAW = [/\*\*/, /\{icon=/i, /\[qr:/i, /\\\*/, /\{w=/]
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 740 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(pathToFileURL(handoutPath).href)
  await page.waitForTimeout(700)

  const overflow = () => page.evaluate(() => {
    const vw = window.innerWidth
    const doc = document.scrollingElement
    const offenders = []
    for (const el of document.querySelectorAll('.phone-bar, .phone-bar *, .phone-list .pslide-label, .phone-list .pslide-label *, #phoneScript, #phoneScript *')) {
      const rect = el.getBoundingClientRect()
      if (rect.width && rect.right > vw + 0.5) offenders.push(`${el.tagName.toLowerCase()}.${el.className} right=${Math.round(rect.right)}`)
    }
    return { vw, scrollWidth: doc.scrollWidth, bodyScroll: document.body.scrollWidth, offenders: offenders.slice(0, 5) }
  })
  const assertNoOverflow = (o, where) => {
    assert.ok(o.scrollWidth <= o.vw && o.bodyScroll <= o.vw,
      `${where}: the page scrolls sideways (scrollWidth ${o.scrollWidth}, body ${o.bodyScroll}, viewport ${o.vw})`)
    assert.deepEqual(o.offenders, [], `${where}: elements run past the right edge`)
  }

  assert.equal(await page.evaluate(() => document.body.classList.contains('phone-list-mode')), true,
    'a phone opens the handout on the slide list')
  assertNoOverflow(await overflow(), 'slide list')
  const listText = await page.evaluate(() => [...document.querySelectorAll('.pslide-title')].map((t) => t.textContent).join('\n'))
  assert.ok(!/\*\*|`/.test(listText), `slide list titles show no raw syntax:\n${listText}`)

  const open = async (titleStart) => {
    await page.evaluate(() => document.getElementById('phoneBack')?.click())
    await page.waitForTimeout(200)
    const found = await page.evaluate((start) => {
      const row = [...document.querySelectorAll('.pslide-row')]
        .find((r) => (r.querySelector('.pslide-title')?.textContent || '').startsWith(start))
      if (!row) return false
      row.click()
      return true
    }, titleStart)
    assert.ok(found, `the list has a row for "${titleStart}"`)
    await page.waitForTimeout(400)
    assert.equal(await page.evaluate(() => document.body.classList.contains('phone-detail-mode')), true,
      `"${titleStart}" opens in the detail view`)
  }
  const scriptText = () => page.evaluate(() => document.getElementById('phoneScript').innerText)
  const shot = async (name) => { if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}-360x740.png`) }) }

  // 1. inline formatting
  await open('Formatting on a phone')
  let text = await scriptText()
  for (const re of RAW) assert.ok(!re.test(text), `formatting slide shows raw ${re}:\n${text}`)
  const formatting = await page.evaluate(() => {
    const host = document.getElementById('phoneScript')
    return {
      strong: [...host.querySelectorAll('li strong')].map((e) => e.textContent),
      em: [...host.querySelectorAll('li em')].map((e) => e.textContent),
      code: [...host.querySelectorAll('li code')].map((e) => e.textContent),
      links: [...host.querySelectorAll('li a')].map((e) => e.getAttribute('href')),
    }
  })
  assert.deepEqual(formatting.strong, ['bold'])
  assert.deepEqual(formatting.em, ['italic'])
  assert.deepEqual(formatting.code, ['code_with_underscores', 'a*b*c'])
  assert.deepEqual(formatting.links, [LONG_URL])
  assert.match(text, /snake_case_word stays whole/)
  assert.match(text, /Escaped \*not italic\* here/)
  assert.match(text, /Inline token in a line/)
  assert.match(text, /Keep \{username\} and \{x\} mid-line/, 'prose braces stay, as on the slide')
  assertNoOverflow(await overflow(), 'formatting slide (long URL)')
  await shot('formatting')

  // 2. QR directive, inline link, long unbroken word
  await open('Scan to follow')
  text = await scriptText()
  for (const re of RAW) assert.ok(!re.test(text), `QR slide shows raw ${re}:\n${text}`)
  assert.ok(!/\[QR/i.test(text), `QR slide shows the raw directive:\n${text}`)
  assert.equal(await page.evaluate(() => document.querySelector('#phoneScript .ps-media a')?.getAttribute('href')),
    'https://example.com/qr_target', 'the QR directive becomes a link to its target')
  assertNoOverflow(await overflow(), 'QR slide (long unbroken word)')
  await shot('qr-and-long-word')

  // 3. very long title (the reported overflow) with a formatted quote
  await open('Dean W. Ball')
  text = await scriptText()
  for (const re of RAW) assert.ok(!re.test(text), `quote slide shows raw ${re}:\n${text}`)
  assert.equal(await page.evaluate(() => document.querySelectorAll('#phoneScript blockquote strong').length), 2)
  const bar = await page.evaluate(() => {
    const full = document.getElementById('phoneFull').getBoundingClientRect()
    return { right: full.right, vw: window.innerWidth }
  })
  assert.ok(bar.right <= bar.vw, `the Full screen button stays on screen (right ${bar.right} > ${bar.vw})`)
  assertNoOverflow(await overflow(), 'long-title slide')
  await shot('long-title')

  // 4. a formatted title: formatting everywhere, never a link (the slide's heading links nothing)
  await open('A bold title')
  const titles = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.pslide-title')].find((t) => t.textContent.startsWith('A bold title'))
    const read = (el) => ({ text: el.textContent, strong: el.querySelectorAll('strong').length, links: el.querySelectorAll('a').length })
    return { row: read(row), bar: read(document.getElementById('phoneBarTitle')), script: read(document.querySelector('#phoneScript .ps-title')) }
  })
  assert.deepEqual(titles.row, { text: 'A bold title with a link', strong: 1, links: 0 }, 'list row title')
  assert.deepEqual(titles.bar, { text: 'A bold title with a link', strong: 1, links: 0 }, 'phone bar title')
  assert.deepEqual(titles.script, { text: 'A bold title with a link', strong: 1, links: 0 }, 'slide text title')

  // 5. code block
  await open('Code keeps its characters')
  assert.equal(await page.evaluate(() => document.querySelector('#phoneScript pre code')?.textContent),
    'const total = price*qty*rate // snake_case_name', 'a code block keeps its characters exactly')
  assertNoOverflow(await overflow(), 'code slide')
  await shot('code')

  // 6. a diagram fence is one Diagram row, never its source
  await open('A diagram is named')
  const diagram = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('#phoneScript .ps-media b')].map((b) => b.textContent),
    code: document.querySelectorAll('#phoneScript pre').length,
    text: document.getElementById('phoneScript').innerText,
  }))
  assert.deepEqual(diagram.labels, ['Diagram'])
  assert.equal(diagram.code, 0, 'no code block for a diagram fence')
  assert.ok(!/Alpha-->Beta|graph TD/.test(diagram.text), `the diagram source is not shown:\n${diagram.text}`)

  assert.equal(errors.length, 0, `handout raised page errors: ${errors.join(' | ')}`)
  console.log('phone text at 360x740: formatting renders, no raw authoring syntax, no sideways scroll')

  // 7. Hostile outline (security review 2026-09-28): a QR directive inside a link target or bare
  //    URL once became a finished anchor inside the outer href, and its text ran as event handlers
  //    on slide open. Every slide is opened in phone detail mode, hovered and tabbed through: no
  //    element may carry an on* attribute and no handler may set window.__pwn. The desktop slide
  //    for the same outline is checked the same way, and the phone never links where the slide
  //    does not.
  const hostileHandout = await buildHandout(HOSTILE_OUTLINE, 'hostile')
  const handlerAttrs = () => page.evaluate(() => [...document.querySelectorAll('*')]
    .flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${el.tagName.toLowerCase()} ${a.name}=${a.value}`)))
  const pwn = () => page.evaluate(() => window.__pwn ?? null)
  await page.goto(pathToFileURL(hostileHandout).href)
  await page.waitForTimeout(700)
  assert.equal(await page.evaluate(() => document.body.classList.contains('phone-list-mode')), true)
  const rowCount = await page.evaluate(() => document.querySelectorAll('.pslide-row').length)
  assert.ok(rowCount >= HOSTILE_SLIDE_COUNT, `the hostile handout lists its slides (${rowCount})`)
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.pslide-title a, #phoneBarTitle a')].length), 0,
    'row titles hold no anchors')
  const phoneHrefs = []
  for (let i = 0; i < rowCount; i += 1) {
    await page.evaluate(() => document.getElementById('phoneBack')?.click())
    await page.waitForTimeout(150)
    await page.evaluate((index) => document.querySelectorAll('.pslide-row')[index].click(), i)
    await page.waitForTimeout(250)
    assert.equal(await page.evaluate(() => document.body.classList.contains('phone-detail-mode')), true, `slide ${i + 1} opens`)
    // Hover everything in the slide text, then walk focus through the page.
    const boxes = await page.evaluate(() => [...document.querySelectorAll('#phoneScript *, #phoneBarTitle *')].map((el) => {
      const r = el.getBoundingClientRect()
      return r.width && r.height ? [r.left + r.width / 2, r.top + r.height / 2] : null
    }).filter(Boolean))
    for (const [x, y] of boxes.slice(0, 60)) await page.mouse.move(Math.max(0, Math.min(359, x)), Math.max(0, Math.min(739, y)))
    for (let t = 0; t < 8; t += 1) await page.keyboard.press('Tab')
    await page.waitForTimeout(50)
    assert.deepEqual(await handlerAttrs(), [], `slide ${i + 1}: no element carries an on* attribute`)
    assert.equal(await pwn(), null, `slide ${i + 1}: no injected handler ran`)
    const slide = await page.evaluate(() => ({
      id: document.querySelector('.stage > .slide.active')?.dataset.id || '',
      hrefs: [...document.querySelectorAll('#phoneScript a, #phoneBar a')].map((a) => a.getAttribute('href')),
      titleLinks: document.querySelectorAll('#phoneScript .ps-title a, #phoneBarTitle a').length,
    }))
    assert.equal(slide.titleLinks, 0, `slide ${i + 1}: the title links nothing`)
    for (const href of slide.hrefs) assert.ok(href === '#' || isPhoneHref(href), `slide ${i + 1}: unsafe href ${JSON.stringify(href)}`)
    phoneHrefs.push(slide)
  }
  assert.ok(phoneHrefs.some((s) => s.hrefs.includes('https://x/[QR')), 'the exploit slides were opened')
  assert.equal(errors.length, 0, `hostile handout raised page errors: ${errors.join(' | ')}`)

  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    await desktop.goto(pathToFileURL(hostileHandout).href)
    await desktop.waitForTimeout(700)
    const slideHrefs = await desktop.evaluate(() => Object.fromEntries([...document.querySelectorAll('.stage > .slide')]
      .map((s) => [s.dataset.id, [...s.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))])))
    for (let i = 0; i < rowCount; i += 1) {
      await desktop.keyboard.press('ArrowRight')
      await desktop.waitForTimeout(80)
    }
    assert.deepEqual(await desktop.evaluate(() => [...document.querySelectorAll('*')]
      .flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => a.name))), [], 'the desktop slides carry no on* attribute')
    assert.equal(await desktop.evaluate(() => window.__pwn ?? null), null, 'no injected handler ran on the desktop slides')
    for (const { id, hrefs } of phoneHrefs) {
      for (const href of hrefs) {
        if (href !== '#') assert.ok((slideHrefs[id] || []).includes(href), `slide ${id}: the phone links to ${href}; the slide does not (${JSON.stringify(slideHrefs[id])})`)
      }
    }
  } finally {
    await desktop.close()
  }
  console.log(`hostile outline at 360x740: ${rowCount} slides opened, no on* attribute, no handler ran, never more links than the slide`)
} finally {
  await browser.close()
  rmSync(scratch, { recursive: true, force: true })
}
