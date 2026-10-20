// The image drawer in a real browser (ticket 11): the actual ImageDrawer component, bundled with esbuild and
// run in headless Chromium against a fake window.tw.images (invented names). Covers: results with captions and
// "used in N talks"; ⌘⏎ inserts the highlighted image and the drawer stays open; arrows move the highlight and
// ⌘⏎ follows it; Esc closes; the drag payload carries only the drawer's own type (the editor never pastes it
// as text); no results; the SlideWell-not-installed state (quiet line, groups, no error styling); the Old slides
// tab shell; a failed search reads as a quiet line.
// Usage: node scripts/test-image-drawer-dom.mjs     SHOTS=<dir> saves the three states.
import { build } from 'esbuild'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = process.env.SHOTS
if (shots) await mkdir(shots, { recursive: true })

const bundle = await build({
  stdin: {
    contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import ImageDrawer, { DropHint, IMAGE_DRAG_TYPE } from './src/renderer/src/components/ImageDrawer.tsx'
      window.__dragType = IMAGE_DRAG_TYPE
      window.mountHint = (kind) => {
        window.__hostHint ??= createRoot(document.getElementById('hint'))
        window.__hostHint.render(React.createElement(DropHint, { kind }))
      }
      window.mountDrawer = () => {
        window.__events = []
        const host = document.getElementById('host')
        window.__root?.unmount()
        window.__root = createRoot(host)
        window.__root.render(React.createElement(ImageDrawer, {
          currentTalkPath: '/vault/talks/staff-briefing/staff-briefing.md',
          onInsert: async (hit) => { window.__events.push('insert:' + hit.key); return !window.__insertFails },
          onInsertOldSlide: async (hit) => { window.__events.push('editable:' + hit.key); return true },
          currentSlide: 3,
          onClose: () => window.__events.push('close')
        }))
      }`,
    resolveDir: root, loader: 'tsx', sourcefile: 'harness.tsx'
  },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"development"' }
})
const css = await readFile(join(root, 'src/renderer/src/image-drawer.css'), 'utf8')

const thumb = (a, b) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><defs><linearGradient id="g"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="200" height="120" fill="url(#g)"/></svg>`)
const TALK = '/vault/talks/staff-briefing/staff-briefing.md'
const H = (key, source, title, extra = {}) => ({ key, source, thumbUrl: thumb('#c9d6e8', '#8fa8c8'), title, detail: '', ocrText: '', match: 'words', score: 1, usedIn: [], ...extra })
const WITH_SLIDEWELL = {
  provider: 'slidewell', meaning: 'used',
  hits: [
    H('well:1', 'screenshot', 'Transcript pane with speaker labels', { app: 'Chrome', date: '2026-10-08', usedIn: [{ talkTitle: 'Staff briefing', talkPath: TALK, slide: 8 }] }),
    H('triage:2', 'screenshot', 'parakeet run in Terminal', { app: 'Terminal', date: '2026-10-08' }),
    H('well:3', 'screenshot', 'Claude cleaning a parakeet transcript', { app: 'Claude', date: '2026-09-27', match: 'meaning', usedIn: [{ talkTitle: 'A', talkPath: '/a.md', slide: 1 }, { talkTitle: 'B', talkPath: '/b.md', slide: 4 }] }),
    H('archive:4', 'archive-image', 'Digital Skills Forum 2024', { presentationTitle: 'Digital Skills Forum 2024' })
  ]
}
const WITHOUT_SLIDEWELL = {
  provider: 'archive', meaning: 'off',
  hits: [
    H('archive:5', 'archive-image', 'Accessible lectures 2023', { presentationTitle: 'Accessible lectures 2023' }),
    H('well:6', 'talk-image', 'Raw transcript, before cleaning', { usedIn: [{ talkTitle: 'Staff briefing', talkPath: TALK, slide: 8 }] }),
    H('archive:7', 'archive-image', 'Oxford AI Day 2025', { presentationTitle: 'Oxford AI Day 2025' })
  ]
}

const failures = []
const check = (ok, label) => { if (!ok) { failures.push(label); console.error('FAIL ' + label) } else console.log('ok   ' + label) }

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.setContent(`<!doctype html><html><head><style>
  :root{--paper:#f7f3ea;--panel:#fffdf8;--hover:#ede8dc;--active:#e4ddd0;--line:#d9d0c1;--ink:#17202a;--muted:#5d6875;--faint:#8a9099;--oxford:#0b3a6b;--font-ui:-apple-system,sans-serif;--font-mono:Menlo,monospace}
  *{box-sizing:border-box} body{margin:0;height:900px;display:flex;background:var(--paper);font:14px var(--font-ui)}
  #editor{flex:1} ${css}
</style></head><body><div id="editor"><textarea id="ed" style="width:90%;height:300px;margin:30px"></textarea></div><div id="hint" style="pointer-events:none;position:fixed;left:0;top:0;width:600px;height:400px"></div><div id="host" style="display:flex"></div></body></html>`)
await page.addScriptTag({ content: bundle.outputFiles[0].text })

async function setup({ provider, answers, failSearch = false, archive = true }) {
  await page.evaluate(({ provider, answers, failSearch, archive }) => {
    window.__calls = []
    window.tw = { images: {
      status: async () => ({ provider, archive }),
      search: async (q, opts) => { window.__calls.push(['search', q, opts]); if (failSearch) return null; return q === 'zzz' ? { provider: provider ?? 'archive', hits: [], meaning: 'off' } : answers },
      importImage: async () => null
    } }
    window.__insertFails = false
    window.mountDrawer()
  }, { provider, answers, failSearch, archive })
}
const drawer = page.locator('[data-image-drawer]')
const cards = page.locator('.image-drawer__card')
const focused = async () => page.evaluate(() => document.querySelector('.image-drawer__card.is-focus')?.getAttribute('data-key') ?? null)
const events = () => page.evaluate(() => window.__events)

// ── 1 · SlideWell present ───────────────────────────────────────────────────────
await setup({ provider: 'slidewell', answers: WITH_SLIDEWELL })
await page.waitForTimeout(150)
check(await page.evaluate(() => document.activeElement?.closest('[data-image-drawer]') !== null && document.activeElement.tagName === 'INPUT'), 'opening puts the cursor in the search box')
check((await drawer.locator('.image-drawer__head').innerText()).includes('Find images') && (await drawer.locator('.image-drawer__head').innerText()).includes('⌘⇧I'), 'header names the drawer and its shortcut')
check((await page.locator('[data-quiet]').innerText()) === 'From your SlideWell library: screenshots, added images and the pictures in your talks, plus images from your old PowerPoints', 'source line for SlideWell')
check((await drawer.locator('.image-drawer__grid').innerText()).includes('Type to search'), 'nothing typed: says what to do')
await page.keyboard.type('parakeet transcript')
await cards.first().waitFor()
check(await cards.count() === 4, 'four results')
check((await drawer.locator('.image-drawer__count').innerText()) === '4', 'result count at the right of the search box')
const lastSearch = await page.evaluate(() => window.__calls.at(-1))
check(lastSearch[1] === 'parakeet transcript' && lastSearch[2].match === 'both', 'searches words and pictures')
const texts = await cards.allInnerTexts()
check(texts[0].includes('Transcript pane with speaker labels') && texts[0].includes('Chrome · 8 Oct 2026') && texts[0].includes('Used in 1 talk'), 'caption: title, app · date, used in 1 talk')
check(texts[1].includes('Terminal · 8 Oct 2026') && !texts[1].includes('Used in'), 'unused image has no used-in line')
check(texts[2].includes('Used in 2 talks'), 'used in 2 talks')
check(texts[3].includes('Digital Skills Forum 2024') && texts[3].includes('Old PowerPoint'), 'old-PowerPoint caption')
check((await focused()) === 'well:1', 'first result highlighted')
check((await drawer.locator('.image-drawer__foot').innerText()).replace(/\s+/g, ' ').includes('Drag onto the slide · ⌘⏎ insert at caret · Esc close'), 'footer hints')
if (shots) await page.screenshot({ path: join(shots, 'drawer-1-results.png') })

await page.keyboard.press('ArrowDown')
check((await focused()) === 'well:3', 'down moves a row')
await page.keyboard.press('ArrowRight')
check((await focused()) === 'archive:4', 'right at the end of the words moves one image')
await page.keyboard.press('Meta+Enter')
await page.waitForFunction(() => window.__events.length > 0)
check((await events()).join() === 'insert:archive:4', '⌘⏎ inserts the highlighted image')
check(await drawer.count() === 1 && (await cards.nth(3).innerText()).includes('Inserted'), 'the drawer stays open and marks the image Inserted')
await page.keyboard.press('ArrowUp')
await page.keyboard.press('Meta+Enter')
await page.waitForFunction(() => window.__events.length > 1)
check((await events()).join() === 'insert:archive:4,insert:triage:2', 'arrows then ⌘⏎ insert another')

// text cursor keeps its arrows inside the words
await page.locator('.image-drawer__search input').press('Home')
const before = await focused()
await page.keyboard.press('ArrowRight')
check((await focused()) === before, 'right inside the words moves the text cursor, not the highlight')

// drag payload
const payload = await page.evaluate(() => {
  const card = document.querySelector('.image-drawer__card[data-key="triage:2"]')
  const dt = new DataTransfer()
  card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
  return { types: [...dt.types], data: dt.getData(window.__dragType), draggable: card.draggable }
})
await page.waitForFunction(() => document.querySelector('.image-drawer__card[data-key="triage:2"]')?.classList.contains('is-dragging'))
check(payload.draggable && payload.types.length === 1 && payload.types[0] === 'application/x-talkweaver-image', 'drag sets only the drawer’s own type')
check(JSON.parse(payload.data).key === 'triage:2' && JSON.parse(payload.data).thumbUrl.startsWith('data:'), 'drag payload names the image')
check(true, 'the dragged card dims')

// failed insert is not marked
await page.evaluate(() => { window.__insertFails = true; window.__events = [] })
await page.keyboard.press('ArrowUp'); await page.keyboard.press('Meta+Enter')
await page.waitForFunction(() => window.__events.length > 0)
check(!(await page.locator('.image-drawer__card[data-key="well:1"]').innerText()).includes('Inserted'), 'an insert that failed is not marked Inserted')

// Esc closes
await page.evaluate(() => { window.__events = [] })
await page.keyboard.press('Escape')
check((await events()).join() === 'close', 'Esc closes')
await page.locator('.image-drawer__close').click()
check((await events()).join() === 'close,close', 'the × closes')
// Esc while the editor has the cursor is not the drawer's
await page.locator('#ed').focus(); await page.evaluate(() => { window.__events = [] })
await page.keyboard.press('Escape'); await page.keyboard.press('Meta+Enter')
check((await events()).length === 0, 'the editor keeps its own keys while it has the cursor')

// ── 2 · no results ──────────────────────────────────────────────────────────────
await setup({ provider: 'slidewell', answers: WITH_SLIDEWELL })
await page.locator('.image-drawer__search input').fill('zzz')
await page.waitForFunction(() => document.querySelector('.image-drawer__message')?.textContent?.includes('No images match'))
check((await drawer.locator('.image-drawer__message').innerText()) === 'No images match “zzz”.', 'no results: plain line naming the words')
check(await page.evaluate(() => { window.__events = []; return true }), '')
await page.keyboard.press('Meta+Enter')
check((await events()).length === 0, '⌘⏎ with nothing to insert does nothing')
if (shots) await page.screenshot({ path: join(shots, 'drawer-2-no-results.png') })

// ── 3 · Old slides tab: the inline choice (ticket 12) ───────────────────────────
const SLIDE = (key, title, oldSlide) => H(key, 'old-slide', title, { presentationTitle: 'Oxford AI Day 2025', ...(oldSlide ? { oldSlide } : {}) })
const OLD = {
  provider: 'slidewell', meaning: 'used',
  hits: [
    H('well:1', 'screenshot', 'Transcript pane with speaker labels'),
    SLIDE('old-slide:a', 'What AI literacy is not', { title: 'What AI literacy is not', paragraphs: ['Not prompt tricks'], images: [], slideNumber: 4 }),
    SLIDE('old-slide:b', 'Cover only', { title: 'Cover only', paragraphs: ['Cover only'], images: [], slideNumber: 1 }),
    SLIDE('old-slide:c', 'No record from the provider')
  ]
}
await setup({ provider: 'slidewell', answers: OLD })
await page.getByRole('tab', { name: 'PowerPoint Imports' }).click()
await page.locator('.image-drawer__search input').fill('literacy')
await cards.first().waitFor()
check(await cards.count() === 3, 'the Old slides tab lists only slides')
check((await page.locator('[data-quiet]').innerText()) === 'Slides from your old PowerPoints, from the archive folder chosen in Settings. SlideWell is not needed.','source line for old slides')
check((await cards.first().innerText()).includes('What AI literacy is not') && (await cards.first().innerText()).includes('Oxford AI Day 2025'), 'old slide caption: title, presentation')
const choice = page.locator('[data-old-slide-choice]')
await page.keyboard.press('Meta+Enter')
await choice.waitFor()
check((await events()).length === 0, 'inserting an old slide asks first; nothing is inserted yet')
const ct = (await choice.innerText()).replace(/\s+/g, ' ')
check(ct.includes('USE THIS SLIDE AS') || ct.toLowerCase().includes('use this slide as'), 'choice heading')
check(ct.includes('Editable slide') && ct.includes('Added after slide 3; text and images stay editable') && ct.includes('Enter'), 'Editable slide (Enter), after the current slide')
check(ct.includes('Picture of the slide') && ct.includes('Placed on this slide as one image, as it looked') && ct.includes('Esc cancels'), 'Picture of the slide (P), Esc cancels')
if (shots) await page.screenshot({ path: join(shots, 'drawer-4-old-slide-choice.png') })
// Esc cancels, inserts nothing, drawer stays open, focus back at the search box on the same result
await page.keyboard.press('Escape')
check(await choice.count() === 0 && (await events()).length === 0, 'Esc cancels the choice and inserts nothing')
check(await drawer.count() === 1, 'the first Esc does not close the drawer')
check(await page.evaluate(() => document.activeElement?.tagName === 'INPUT' && document.activeElement.closest('[data-image-drawer]') !== null), 'focus is back in the drawer')
check((await focused()) === 'old-slide:a', 'the highlight is still on the same result')
// Enter and P belong to the choice only
await page.keyboard.press('Enter'); await page.keyboard.press('p')
check((await events()).length === 0 && (await page.locator('.image-drawer__search input').inputValue()) === 'literacyp', 'Enter and P do nothing outside the choice (P types into the search box)')
await page.locator('.image-drawer__search input').fill('literacy')
// Enter: editable
await page.keyboard.press('Meta+Enter'); await choice.waitFor()
await page.keyboard.press('Enter')
await page.waitForFunction(() => window.__events.length > 0)
check((await events()).join() === 'editable:old-slide:a', 'Enter adds it as an editable slide')
check(await choice.count() === 0, 'the choice closes once answered')
// P: picture, through the picture path
await page.evaluate(() => { window.__events = [] })
await page.keyboard.press('Meta+Enter'); await choice.waitFor()
await page.keyboard.press('p')
await page.waitForFunction(() => window.__events.length > 0)
check((await events()).join() === 'insert:old-slide:a', 'P places the slide’s picture, as a picture result is inserted')
// other keys are swallowed while the choice shows
await page.evaluate(() => { window.__events = [] })
await page.keyboard.press('Meta+Enter'); await choice.waitFor()
await page.keyboard.press('x')
check((await page.locator('.image-drawer__search input').inputValue()) === 'literacy' && await choice.count() === 1, 'other keys do not type into the search while the choice shows')
await page.keyboard.press('Escape')
// the picture-only cases
await page.keyboard.press('ArrowRight'); await page.keyboard.press('Meta+Enter'); await choice.waitFor()
const only = (await choice.innerText()).replace(/\s+/g, ' ')
check(!only.includes('Editable slide') && only.includes('Picture of the slide') && only.includes('This slide has no text or pictures to edit, so it can only go in as a picture.'), 'nothing to edit: only the picture is offered, with one plain sentence why')
await page.keyboard.press('Enter')
check(await choice.count() === 1 && (await events()).length === 0, 'Enter does nothing when only the picture is offered')
await page.keyboard.press('p')
await page.waitForFunction(() => window.__events.length > 0)
check((await events()).join() === 'insert:old-slide:b', 'P still places the picture')
await page.keyboard.press('ArrowRight'); await page.keyboard.press('Meta+Enter'); await choice.waitFor()
check(!(await choice.innerText()).includes('Editable slide'), 'a slide the provider gave no record for is picture-only')
await page.keyboard.press('Escape')
// a click answers too
await page.keyboard.press('ArrowUp'); await page.keyboard.press('Meta+Enter'); await choice.waitFor()
await page.evaluate(() => { window.__events = [] })
await page.locator('[data-choice="editable"]').click()
await page.waitForFunction(() => window.__events.length > 0)
check((await events()).join() === 'editable:old-slide:a', 'clicking Editable slide answers it')
// a drop on the slide asks the same question
await page.evaluate(() => { window.__events = []; window.dispatchEvent(new CustomEvent('tw-image-drawer-old-slide-drop', { detail: { key: 'old-slide:a' } })) })
await choice.waitFor()
check((await events()).length === 0, 'dropping an old slide asks first as well')
const dragData = await page.evaluate(() => {
  const dt = new DataTransfer()
  document.querySelector('.image-drawer__card[data-key="old-slide:a"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
  return JSON.parse(dt.getData(window.__dragType))
})
check(dragData.oldSlide === true && dragData.key === 'old-slide:a', 'an old slide’s drag payload says it is an old slide')
await page.keyboard.press('Escape')
// S5: a new search between drag start and drop does not lose the dragged slide
await page.locator('.image-drawer__search input').fill('zzz')
await page.waitForFunction(() => document.querySelectorAll('.image-drawer__card').length === 0)
await page.evaluate(() => { window.__events = []; window.dispatchEvent(new CustomEvent('tw-image-drawer-old-slide-drop', { detail: { key: 'old-slide:a' } })) })
await choice.waitFor()
check(await page.locator('[data-drop-note]').count() === 0, 'a drop after a new search still opens the choice for the dragged slide')
await page.keyboard.press('Meta+Enter').catch(() => {})
await page.keyboard.press('Escape')
// a key the drawer never saw dragged is not trusted: one plain line, nothing inserted
await page.evaluate(() => window.dispatchEvent(new CustomEvent('tw-image-drawer-old-slide-drop', { detail: { key: 'old-slide:nope' } })))
await page.locator('[data-drop-note]').waitFor()
check((await page.locator('[data-drop-note]').innerText()).includes('Nothing was inserted') && await choice.count() === 0 && (await events()).length === 0, 'a drop that cannot be matched says so in the drawer')
await page.locator('.image-drawer__search input').fill('literacy')
await cards.first().waitFor()
// S6: the drop hint, worded for what is dragged, gone when not dragging
await page.evaluate(() => window.mountHint('picture'))
check((await page.locator('[data-drop-hint]').innerText()).replace(/\s+/g, ' ') === 'Drop a picture here or ⌘⏎ to insert at the caret', 'the hint reads as in the mockup while a picture is dragged')
await page.evaluate(() => window.mountHint('slide'))
check((await page.locator('[data-drop-hint]').innerText()).startsWith('Drop a slide here'), 'the hint says slide for an old slide')
await page.evaluate(() => window.mountHint(null))
check(await page.locator('[data-drop-hint]').count() === 0, 'the hint is gone once the drag ends')
// the choice owns the keyboard however it was opened (fix round 1, defect 4)
const inChoice = () => page.evaluate(() => document.activeElement?.closest('[data-old-slide-choice]') !== null)
await page.keyboard.press('Meta+Enter'); await choice.waitFor()
check(await inChoice(), '⌘⏎ on an old slide puts the keyboard in the choice')
await page.keyboard.press('Escape')
// dropped while the editor has the cursor: Enter, P and Esc are the choice's, and the editor sees none of them
await page.evaluate(() => {
  const ed = document.getElementById('ed')
  ed.value = 'draft'
  window.__edKeys = []
  ed.addEventListener('keydown', (e) => window.__edKeys.push(e.key))
})
const dropWithEditorFocused = async () => {
  await page.locator('#ed').focus()
  await page.evaluate(() => { window.__events = []; window.__edKeys = []; window.dispatchEvent(new CustomEvent('tw-image-drawer-old-slide-drop', { detail: { key: 'old-slide:a' } })) })
  await choice.waitFor()
}
const editorUntouched = () => page.evaluate(() => window.__edKeys.length === 0 && document.getElementById('ed').value === 'draft')
await dropWithEditorFocused()
check(await inChoice(), 'a drop with the cursor in the editor moves the keyboard to the choice')
await page.keyboard.press('Enter')
await page.waitForTimeout(80)
check((await events()).join() === 'editable:old-slide:a' && await choice.count() === 0, 'after a drop, Enter answers the choice')
check(await editorUntouched(), 'after a drop, Enter does not reach the editor')
await dropWithEditorFocused()
await page.keyboard.press('p')
await page.waitForTimeout(80)
check((await events()).join() === 'insert:old-slide:a' && await choice.count() === 0, 'after a drop, P answers the choice')
check(await editorUntouched(), 'after a drop, P does not reach the editor')
await dropWithEditorFocused()
await page.keyboard.press('Escape')
await page.waitForTimeout(80)
check(await choice.count() === 0 && (await events()).length === 0 && await drawer.count() === 1, 'after a drop, Esc cancels the choice and inserts nothing')
check(await editorUntouched(), 'after a drop, Esc does not reach the editor')
// the same slide dropped again while the choice shows and the editor has the cursor: the choice takes the keys back
await dropWithEditorFocused()
await page.evaluate(() => {
  // the editor takes focus and the same slide is dropped again in one step, before the dismissal a blur schedules can run
  document.getElementById('ed').focus()
  window.__edKeys = []
  window.dispatchEvent(new CustomEvent('tw-image-drawer-old-slide-drop', { detail: { key: 'old-slide:a' } }))
})
await page.waitForTimeout(80)
check(await choice.count() === 1 && await inChoice(), 'a repeat drop of the same slide with the cursor in the editor puts the keyboard back in the choice')
await page.keyboard.press('Enter')
await page.waitForTimeout(80)
check((await events()).join() === 'editable:old-slide:a' && await choice.count() === 0, 'after a repeat drop, Enter answers the choice')
check(await editorUntouched(), 'after a repeat drop, Enter does not reach the editor')
// focus leaving the drawer dismisses the choice: the keys are the editor's again and nothing is inserted
await dropWithEditorFocused()
await page.locator('#ed').click()
await page.waitForFunction(() => document.querySelector('[data-old-slide-choice]') === null, null, { timeout: 2000 }).catch(() => {})
check(await choice.count() === 0, 'the choice goes away when focus leaves the drawer')
await page.keyboard.press('Enter'); await page.keyboard.press('p')
check((await events()).length === 0, 'nothing is inserted once the choice has gone')
check(await page.evaluate(() => document.getElementById('ed').value.includes('p') && window.__edKeys.join() === 'Enter,p'), 'the editor has its keys back')
// moving within the drawer keeps the choice
await page.keyboard.press('Escape')
await page.locator('.image-drawer__search input').focus()
await page.keyboard.press('Meta+Enter'); await choice.waitFor()
await page.locator('.image-drawer__search input').focus()
await page.waitForTimeout(80)
check(await choice.count() === 1, 'focus moving inside the drawer keeps the choice')
await page.keyboard.press('Escape')
await page.getByRole('tab', { name: 'SlideWell' }).click()

// ── 4 · SlideWell not installed ─────────────────────────────────────────────────
await setup({ provider: 'archive', answers: WITHOUT_SLIDEWELL })
await page.locator('[data-quiet]').waitFor()
await page.waitForTimeout(150)
check((await page.locator('[data-quiet]').innerText()).endsWith('SlideWell is not set up, so screenshots and the pictures in your talks cannot be found here. Only images from your old PowerPoints can.'), 'quiet line: says SlideWell is not set up and what does not work')
const quietColor = await page.locator('[data-quiet]').evaluate((el) => getComputedStyle(el).color)
check(quietColor === 'rgb(93, 104, 117)', 'the line is in the muted ink, not an error colour')
await page.keyboard.type('transcript')
await cards.first().waitFor()
const groups = await drawer.locator('.image-drawer__group').allInnerTexts()
check(groups.join('|').toUpperCase() === 'IN THIS TALK|FROM OLD POWERPOINTS', 'groups: In this talk, From old PowerPoints')
const t2 = await cards.allInnerTexts()
check(t2[0].includes('Raw transcript, before cleaning') && t2[0].includes('This talk · slide 8'), 'this talk’s own picture first, captioned with its slide')
check(t2[1].includes('Accessible lectures 2023') && !t2[1].includes('Old PowerPoint'), 'old-PowerPoint image under its group, named by presentation')
check((await focused()) === 'well:6', 'the highlight starts on the first drawn image, not the first returned')
await page.keyboard.press('Meta+Enter')
await page.waitForFunction(() => window.__events.length > 0)
check((await events()).join() === 'insert:well:6', '⌘⏎ inserts in the fallback state too')
if (shots) await page.screenshot({ path: join(shots, 'drawer-3-no-slidewell.png') })

// ── 5 · the search itself fails ─────────────────────────────────────────────────
await setup({ provider: 'slidewell', answers: null, failSearch: true })
await page.waitForTimeout(150)
await page.keyboard.type('parakeet')
await page.waitForFunction(() => document.querySelector('.image-drawer__message')?.textContent?.includes('not available'))
check((await drawer.locator('.image-drawer__message').innerText()) === 'Image search is not available right now.', 'a failed search is one plain line')

// ── 6 · a tab change starts the highlight again (review P2) ─────────────────────
// The highlight was kept across tabs: ⌘⏎ then inserted a stale index that no card showed as highlighted.
await setup({ provider: 'slidewell', answers: OLD })
await page.getByRole('tab', { name: 'PowerPoint Imports' }).click()
await page.locator('.image-drawer__search input').fill('literacy')
await cards.first().waitFor()
await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight')
check((await focused()) === 'old-slide:c', 'old slides: the highlight moved to the third slide')
await page.getByRole('tab', { name: 'SlideWell' }).click()
await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes('SlideWell'))
const firstShown = await cards.first().getAttribute('data-key')
check((await focused()) === firstShown, 'after a tab change the first result is highlighted')
await page.evaluate(() => { window.__events = [] })
await page.locator('.image-drawer__search input').focus()
await page.keyboard.press('Meta+Enter')
await page.waitForFunction(() => window.__events.length > 0)
check((await events()).join() === 'insert:' + firstShown, '⌘⏎ after a tab change inserts the result shown highlighted')
await page.getByRole('tab', { name: 'PowerPoint Imports' }).click()
await cards.first().waitFor()
check((await focused()) === 'old-slide:a', 'switching back starts on the first old slide')

// ── 7 · ⌘⇧I closes through the drawer's own close (review P2) ───────────────────
// The ⌘⇧I branch lives in WorkspaceLayout's window keydown listener, which this harness does not mount:
// this reads that its closing half is the same handler the drawer's onClose uses, and that it focuses the editor.
{
  const layout = await readFile(join(root, 'src/renderer/src/components/WorkspaceLayout.tsx'), 'utf8')
  const branch = layout.match(/\) && e\.shiftKey && \(e\.key === 'i' \|\| e\.key === 'I'\)\) \{([\s\S]*?)\n {6}\}/)
  check(!!branch && branch[1].includes('toggleImageDrawerRef.current()') && !branch[1].includes('setImageDrawerOpen'), '⌘⇧I goes through the drawer toggle, not a bare state flip')
  const toggle = layout.match(/toggleImageDrawerRef\.current = \(\) => \{([\s\S]*?)\n {2}\}/)
  check(!!toggle && /if \(imageDrawerOpen\) closeImageDrawer\(\)/.test(toggle[1]), 'the closing half of ⌘⇧I is closeImageDrawer')
  const close = layout.match(/function closeImageDrawer\(\): void \{([\s\S]*?)\n {2}\}/)
  check(!!close && close[1].includes('setImageDrawerOpen(false)') && close[1].includes('focusEditor()'), 'closeImageDrawer closes the drawer and gives the editor the keyboard')
  check(/<ImageDrawer[\s\S]*?onClose=\{closeImageDrawer\}/.test(layout), 'the drawer’s own Esc and × use the same closeImageDrawer')
}

// ── 8 · no archive chosen: the Old slides tab says so; nothing to search at all ─────────────
await setup({ provider: 'slidewell', answers: WITH_SLIDEWELL, archive: false })
await page.locator('[data-quiet]').waitFor()
check((await page.locator('[data-quiet]').innerText()).endsWith('and the pictures in your talks') , 'without an archive the first tab does not claim old PowerPoints')
await page.getByRole('tab', { name: 'PowerPoint Imports' }).click()
check((await page.locator('[data-quiet]').innerText()).endsWith('No old-PowerPoint archive is chosen, so there are no old slides to search. Choose the archive folder in Settings.'), 'old slides tab says no archive is chosen')
await setup({ provider: null, answers: null, archive: false })
await page.locator('[data-quiet]').waitFor()
check((await page.locator('[data-quiet]').innerText()).endsWith('there is nothing to search. Screenshots and images need SlideWell; the archive folder is chosen in Settings.'), 'neither source: says there is nothing to search')

// ── 8b · In your talks: pictures of the open vaults, no SlideWell needed ───────────────────
{
  const V = (id, title, extra = {}) => H('vault:v1:' + id, 'vault-image', title, { detail: 'harbour, map', ...extra })
  const VAULT = { vaults: 1, hits: [
    V('img-aaaaaaa', 'Harbour lights at dusk', { usedIn: [{ talkTitle: 'Staff briefing', talkPath: TALK, slide: 0 }, { talkTitle: 'Oxford AI Day', talkPath: '/vault/talks/ai-day/ai-day.md', slide: 0 }] }),
    V('img-bbbbbbb', 'Map of the estuary')
  ] }
  const mountVault = async (answer, status = { provider: null, archive: false }) => {
    await page.evaluate(({ answer, status }) => {
      window.__vcalls = []
      window.tw = { images: {
        status: async () => status,
        search: async () => null,
        searchVault: async (q) => { window.__vcalls.push(q); return window.__vaultFails ? null : answer },
        importImage: async () => null
      } }
      window.__vaultFails = false
      window.__insertFails = false
      window.mountDrawer()
    }, { answer, status })
  }
  // the tab is there with SlideWell absent and nothing in the archive
  await mountVault(VAULT)
  const tabs = await page.locator('.image-drawer__tabs [role=tab]').allInnerTexts()
  check(tabs.join('|') === 'SlideWell|PowerPoint Imports|TalkWeaver Vaults', 'the third tab comes after the two others')
  await page.getByRole('tab', { name: 'TalkWeaver Vaults' }).click()
  await cards.first().waitFor()
  check((await page.locator('[data-quiet]').innerText()) === 'Pictures already in your talks, from your open vaults. SlideWell is not needed.', 'In your talks: its quiet line')
  check(await page.evaluate(() => window.__vcalls[0] === ''), 'opening the tab lists the pictures with an empty query')
  const vt = await cards.allInnerTexts()
  check(vt.length === 2 && vt[0].includes('Harbour lights at dusk') && vt[0].includes('Used in 2 talks') && vt[0].includes('This talk'), 'caption, this talk and used-in count')
  check(await page.evaluate(() => document.querySelector('.image-drawer__card img').getAttribute('src') !== null), 'a thumbnail is drawn')
  await page.locator('.image-drawer__search input').fill('harbour')
  await page.waitForFunction(() => window.__vcalls.at(-1) === 'harbour')
  check(true, 'typing searches the vaults')
  await page.keyboard.press('ArrowDown')
  check((await focused()) === 'vault:v1:img-bbbbbbb', 'arrows move through the vault pictures')
  await page.evaluate(() => { window.__events = [] })
  await page.keyboard.press('Meta+Enter')
  await page.waitForFunction(() => window.__events.length > 0)
  check((await events()).join() === 'insert:vault:v1:img-bbbbbbb', '⌘⏎ inserts through the same insert callback')
  const vp = await page.evaluate(() => {
    const card = document.querySelector('.image-drawer__card[data-key="vault:v1:img-aaaaaaa"]')
    const dt = new DataTransfer()
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    return { types: [...dt.types], data: JSON.parse(dt.getData(window.__dragType)) }
  })
  check(vp.types.length === 1 && vp.data.thumbUrl && !('vault' in vp.data), 'the drag carries the picture’s address only; the drop imports it')
  await page.getByRole('tab', { name: 'PowerPoint Imports' }).click()
  await page.getByRole('tab', { name: 'TalkWeaver Vaults' }).click()
  check(await page.evaluate(() => document.querySelector('.image-drawer__card[data-index="0"]')?.getAttribute('data-active') === 'true'), 'a tab change puts the highlight back on the first picture')
  await page.evaluate(() => { window.__events = [] })
  await page.keyboard.press('Escape')
  check((await events()).join() === 'close', 'Esc closes from this tab')

  // nothing matches
  await mountVault({ vaults: 1, hits: [] })
  await page.getByRole('tab', { name: 'TalkWeaver Vaults' }).click()
  await page.waitForFunction(() => document.querySelector('.image-drawer__message')?.textContent?.includes('No pictures'))
  check((await drawer.locator('.image-drawer__message').innerText()) === 'No pictures in your talks match that.', 'empty result line')
  // no vault open
  await mountVault({ vaults: 0, hits: [] })
  await page.getByRole('tab', { name: 'TalkWeaver Vaults' }).click()
  await page.waitForFunction(() => document.querySelector('[data-quiet]')?.textContent?.includes('Open a vault'))
  check((await page.locator('[data-quiet]').innerText()).endsWith('Open a vault to see the pictures in its talks.'), 'no vault open line')
  check(await cards.count() === 0, 'no cards without a vault')
  // a failed read is a quiet line, not a crash
  await mountVault(VAULT)
  await page.evaluate(() => { window.__vaultFails = true })
  await page.getByRole('tab', { name: 'TalkWeaver Vaults' }).click()
  await page.waitForFunction(() => document.querySelector('.image-drawer__message')?.textContent?.includes('not available'))
  check(true, 'a failed read reads as a quiet line')
}

// ── 9 · opening the drawer closes the Inspector (read from WorkspaceLayout, which this harness does not mount) ──
{
  const layout = await readFile(join(root, 'src/renderer/src/components/WorkspaceLayout.tsx'), 'utf8')
  const show = layout.match(/function showImageDrawer\(\): void \{([\s\S]*?)\n {2}\}/)
  check(!!show && show[1].includes('setInspectorMode(false)') && show[1].includes('setImageDrawerOpen(true)'), 'showImageDrawer closes the Inspector and opens the drawer')
  const open = layout.match(/function openImageDrawer\(\): void \{([\s\S]*?)\n {2}\}/)
  check(!!open && open[1].includes('showImageDrawer()') && !open[1].includes('setImageDrawerOpen(true)'), 'the menu and palette entry open the drawer through showImageDrawer')
  const toggle = layout.match(/toggleImageDrawerRef\.current = \(\) => \{([\s\S]*?)\n {2}\}/)
  check(!!toggle && toggle[1].includes('showImageDrawer()') && !toggle[1].includes('setImageDrawerOpen(true)'), '⌘⇧I opens the drawer through showImageDrawer')
  const close = layout.match(/function closeImageDrawer\(\): void \{([\s\S]*?)\n {2}\}/)
  check(!!close && !close[1].includes('setInspectorMode'), 'closing the drawer does not reopen the Inspector')
}

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''))
await browser.close()
if (failures.length) { console.error(`${failures.length} check(s) failed`); process.exit(1) }
console.log('image drawer (browser): all checks passed')
