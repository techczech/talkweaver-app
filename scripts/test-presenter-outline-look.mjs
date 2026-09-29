// The presenter's open outline in the locked look (ADR-0031 §5-6, presenter redesign ticket 08;
// drawn in the round-2 presenter redesign drawings, shot outline-open-1440x900.png).
// The compiled presenter window in headless Chromium at 1440x900, with the recording preload (and
// through it the live and edit bridges) bundled against a stub of electron, as the app injects it.
// Seams: the heading (list-tree icon, "Outline", the "O / Esc closes" hint, Previews with its
// icon, an × close button that closes the drawer and names itself on hover); the legend under the
// search row (Shown, Skipped, Not yet shown, each with its lucide mark and colour); every slide
// row's mark is the lucide icon of its status (no ● ⊘ ○ glyphs); the chrome type scale (14px
// heading, search and slide titles, 13px hint, Previews, Skipped only, legend and section heads).
// The outline's behaviour is test:presenter-outline-follow and test:presenter-outline-skipped.
// Usage: node scripts/test-presenter-outline-look.mjs
//   SHOTS=<dir> saves outline-open-1440x900.png and shortcuts-sheet(-end)-1440x900.png; DECK=<compiled
//   deck.html> uses that deck for the shots (SLIDES=<n> steps, skipping the fourth slide), the
//   checks always use the fixture.
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

const FIXTURE = ['---', 'title: Outline look', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  '\n## Where agents came from',
  ...[1, 2, 3, 4].map((n) => `\n### Slide ${n} {id=s${n}}\n\nText ${n}.`),
  '\n## Where they are going',
  ...[5, 6, 7, 8].map((n) => `\n### Slide ${n} {id=s${n}}\n\nText ${n}.`)].join('\n')
// Lucide marks and their colours (the drawing's green, amber and grey).
const MARKS = { 'tw-shown': ['lucide-circle', 'rgb(63, 185, 80)'], 'tw-skipped': ['lucide-circle-slash', 'rgb(210, 153, 34)'], 'tw-unseen': ['lucide-circle-dashed', 'rgb(110, 118, 129)'] }

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-outline-look-'))
let browser
try {
  const sourcePath = join(scratch, 'outline-look.md')
  await writeFile(sourcePath, FIXTURE)
  const model = await prepareSource(sourcePath, FIXTURE, 'Outline look', statSync(sourcePath))
  const fixturePath = join(scratch, 'outline-look.html')
  await writeFile(fixturePath, model.fullHtml)
  const stubPath = join(scratch, 'electron-stub.mjs')
  await writeFile(stubPath, `export const ipcRenderer = { invoke: async (channel) => (channel === 'recording:context' ? { testMode: true, talkSlug: 'look', talkTitle: 'Look', discardThresholdMs: 0 } : channel === 'live:status' ? 'ended' : {}), on() {}, send() {}, removeListener() {} }
export const contextBridge = { exposeInMainWorld: (name, api) => { window[name] = api } }
export const clipboard = { writeText() {}, readText() { return '' }, readImage() { return { isEmpty: () => true } } }
`)
  const bundle = await build({ entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', alias: { electron: stubPath }, logLevel: 'silent' })
  const preload = bundle.outputFiles[0].text

  browser = await chromium.launch({ headless: true })
  // Opens the presenter on the first slide, steps forward with → and skips the fourth slide with S
  // (slides 1-3 shown, 4 skipped, then shown up to the current one, as drawn), then opens the
  // outline with O.
  const openOutline = async (htmlPath, steps) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    context.setDefaultTimeout(5000)
    await context.addInitScript({ content: `if (window === window.top) {\n${preload}\n}` })
    const page = await context.newPage()
    page.errors = []
    page.on('pageerror', (error) => page.errors.push(error.message))
    await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => failures.push('the REC cluster did not mount'))
    if (await page.isVisible('#twResume')) await page.click('#twResumeNo').catch(() => {})
    await page.mouse.move(5, 500)
    for (let i = 0; i < steps; i += 1) {
      await page.keyboard.press(i === 2 ? 's' : 'ArrowRight')
      await page.waitForTimeout(80)
    }
    await page.keyboard.press('o')
    await page.waitForTimeout(400)
    return { page, context }
  }

  const { page, context } = await openOutline(fixturePath, 5)
  const look = await page.evaluate(() => {
    const drawer = document.getElementById('presenterOutlineDrawer')
    const h2 = drawer.querySelector('h2')
    const px = (el) => (el ? getComputedStyle(el).fontSize : null)
    const weight = (el) => (el ? getComputedStyle(el).fontWeight : null)
    const icon = (el) => [...(el?.querySelector('svg.tw-ico')?.classList || [])].find((c) => c.startsWith('lucide-')) || null
    const rect = (el) => { const r = el?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height } : null }
    const title = h2.querySelector('.presenter-outline-title')
    const hint = h2.querySelector('.presenter-outline-hint')
    const expand = document.getElementById('presenterOutlineExpand')
    const close = document.getElementById('presenterOutlineClose')
    const legend = document.getElementById('presenterOutlineLegend')
    const rows = [...drawer.querySelectorAll('#presenterOutline .slide-link:not(.slide-sublink)')]
    return {
      open: drawer.classList.contains('open'),
      drawer: rect(drawer),
      h2: { text: title?.textContent.trim(), icon: icon(title), size: px(h2), weight: weight(h2), transform: getComputedStyle(h2).textTransform, height: rect(h2).height },
      hint: { text: hint?.textContent.trim(), size: px(hint) },
      expand: { text: expand?.textContent.trim(), icon: icon(expand), size: px(expand), rect: rect(expand) },
      close: { icon: icon(close), name: close?.getAttribute('aria-label'), tip: close?.dataset.tip, key: close?.dataset.key, text: close?.textContent.trim(), rect: rect(close) },
      search: px(document.getElementById('presenterSearch')),
      filter: px(drawer.querySelector('.presenter-outline-filter')),
      controls: rect(drawer.querySelector('.presenter-outline-controls')),
      legend: legend && { size: px(legend), rect: rect(legend), items: [...legend.children].map((s) => ({ cls: s.className, text: s.textContent.trim(), icon: icon(s), color: getComputedStyle(s.querySelector('svg') || s).color })) },
      list: rect(document.getElementById('presenterOutline')),
      sectionSize: px(drawer.querySelector('#presenterOutline .section-head')),
      rows: rows.map((row) => {
        const mark = row.querySelector('.tw-status')
        return {
          title: row.querySelector('.slide-link-title > span:last-child')?.textContent,
          status: ['tw-shown', 'tw-skipped', 'tw-unseen'].find((c) => row.classList.contains(c)) || null,
          current: row.classList.contains('current'),
          icon: icon(mark), markText: mark ? [...mark.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('') : null,
          color: mark ? getComputedStyle(mark).color : null, size: px(row)
        }
      })
    }
  })

  // Heading
  check(look.open, 'O opens the outline')
  check(look.h2.text === 'Outline' && look.h2.icon === 'lucide-list-tree', `the heading is the list-tree icon and "Outline" (${look.h2.icon} "${look.h2.text}")`)
  check(look.h2.size === '14px' && look.h2.weight === '600' && look.h2.transform === 'none', `the heading is 14px semibold, not upper case (${look.h2.size} ${look.h2.weight} ${look.h2.transform})`)
  check(look.hint.text === 'O / Esc closes' && look.hint.size === '13px', `the hint reads "O / Esc closes" at 13px ("${look.hint.text}" ${look.hint.size})`)
  check(look.expand.text === 'Previews' && look.expand.icon === 'lucide-layout-grid' && look.expand.size === '13px', `Previews has its layout-grid icon at 13px ("${look.expand.text}" ${look.expand.icon} ${look.expand.size})`)
  check(look.close.icon === 'lucide-x' && look.close.name === 'Close outline' && look.close.text === '', `the close button is a lucide × named "Close outline" (${look.close.icon} "${look.close.name}" "${look.close.text}")`)
  check(look.close.tip === 'Close outline' && look.close.key === 'O', `the close button's tooltip reads "Close outline  O" (${look.close.tip} ${look.close.key})`)
  check(look.h2.height <= 30, `the heading is one row (${look.h2.height}px tall)`)
  check(look.close.rect && look.expand.rect && look.close.rect.left >= look.expand.rect.right && look.close.rect.right <= look.drawer.right, 'the close button sits after Previews, inside the drawer')
  // Search row and legend
  check(look.search === '14px' && look.filter === '13px', `search 14px, Skipped only 13px (${look.search} ${look.filter})`)
  check(look.legend && look.legend.rect.top >= look.controls.bottom && look.legend.rect.bottom <= look.list.top + 1, 'the legend sits between the search row and the slide list')
  check(look.legend?.size === '13px', `the legend is 13px (${look.legend?.size})`)
  const legendWant = [['tw-shown', 'Shown'], ['tw-skipped', 'Skipped'], ['tw-unseen', 'Not yet shown']]
  legendWant.forEach(([cls, text], i) => {
    const item = look.legend?.items[i]
    check(item && item.cls === cls && item.text === text && item.icon === MARKS[cls][0] && item.color === MARKS[cls][1], `legend ${i + 1}: "${text}" with ${MARKS[cls][0]} in ${MARKS[cls][1]} (${item && `${item.text} ${item.icon} ${item.color}`})`)
  })
  // Slide rows and their marks
  check(look.sectionSize === '13px', `section heads are 13px (${look.sectionSize})`)
  // Each section opens with its own section slide: ten rows.
  check(look.rows.length === 10, `ten slide rows (${look.rows.length})`)
  const statuses = look.rows.map((r) => r.status).join(' ')
  check(statuses === 'tw-shown tw-shown tw-shown tw-skipped tw-shown tw-shown tw-shown tw-unseen tw-unseen tw-unseen', `session marks: shown ×3, skipped, shown ×3, unseen ×3 (${statuses})`)
  check(look.rows[6]?.current, 'the seventh row is the current slide')
  for (const row of look.rows) {
    const [icon, color] = MARKS[row.status] || []
    check(row.icon === icon && row.color === color, `${row.title}: ${row.status} mark is ${icon} in ${color} (${row.icon} ${row.color})`)
    check(row.markText === '', `${row.title}: the mark is an icon, not the glyph "${row.markText}"`)
    check(row.size === '14px', `${row.title}: 14px (${row.size})`)
  }
  // The × closes the drawer.
  await page.click('#presenterOutlineClose', { timeout: 2000 }).catch(() => failures.push('there is no × button to click'))
  await page.waitForTimeout(250)
  check(!(await page.evaluate(() => document.getElementById('presenterOutlineDrawer').classList.contains('open'))), 'the × button closes the outline')
  check(page.errors.length === 0, `no page errors (${page.errors.join('; ')})`)
  await context.close()

  if (SHOTS) {
    await mkdir(SHOTS, { recursive: true })
    const deck = process.env.DECK ? resolve(process.env.DECK) : fixturePath
    const shot = await openOutline(deck, Number(process.env.SLIDES || 5))
    await shot.page.screenshot({ path: join(SHOTS, 'outline-open-1440x900.png') })
    await shot.page.keyboard.press('Escape')
    await shot.page.waitForTimeout(250)
    await shot.page.keyboard.press('?')
    await shot.page.waitForTimeout(200)
    await shot.page.screenshot({ path: join(SHOTS, 'shortcuts-sheet-1440x900.png') })
    // The sheet's end: the Audience, Editor (⌘R / ⇧F5) and Help sections.
    await shot.page.evaluate(() => { const b = document.getElementById('twShortcutsBody'); for (let n = b; n; n = n.parentElement) n.scrollTop = n.scrollHeight })
    await shot.page.waitForTimeout(150)
    await shot.page.screenshot({ path: join(SHOTS, 'shortcuts-sheet-end-1440x900.png') })
    await shot.context.close()
  }
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`test-presenter-outline-look: ${failures.length} failure(s):`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log('test-presenter-outline-look: heading with list-tree, hint, Previews and ×; legend; lucide marks by status; chrome type scale; × closes.')
