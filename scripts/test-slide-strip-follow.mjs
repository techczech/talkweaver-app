// Actual SlideStrip + stylesheet in bundled headless Chromium; synthetic data only.
// Reuses the sidebar research probe's esbuild/Playwright fixture approach.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
import SlideStrip from './src/renderer/src/components/SlideStrip.tsx';
let app=createRoot(document.getElementById('stage')), p;
window.draw=(over={})=>{if('activeIndex' in over)window.lastSelectionAt=performance.now();p={...p,...over};flushSync(()=>app.render(React.createElement(SlideStrip,p)))};
window.mount=()=>{flushSync(()=>app.unmount());app=createRoot(document.getElementById('stage'));
 const rows=Array.from({length:189},(_,i)=>({slide_id:'s'+i,title:'Synthetic statement '+i,nav_title:'Synthetic statement '+i,section:'Part '+Math.floor(i/30),role:'content',layout:'statement',text_excerpt:'Synthetic text',source_markdown:'### Synthetic statement '+i,source_line:4*i+1,render_hash:'r'+i,content_hash:'c'+i,warnings:[]}));
 p={talk:{slug:'synthetic',title:'Synthetic sampler',outlinePath:'/synthetic/talk-outline.md'},compiledSlides:rows,outlineContent:'synthetic source',triggerFindings:[],thumbnails:Object.fromEntries(rows.map((r,i)=>[r.render_hash,'https://fixture.test/thumb/'+i+'.png'])),activeIndex:0,onSelectSlide:i=>window.draw({activeIndex:i}),onEdit:i=>window.lastEdit=i};window.draw()};
window.carousel=()=>window.draw({thumbnails:{...p.thumbnails,r4__0:'https://fixture.test/thumb/4.png'}});
window.dispose=()=>flushSync(()=>app.unmount());
window.position=()=>{const l=document.querySelector('[data-place-region="strip"]').lastElementChild,c=document.querySelector('[data-active="true"]');return {at:performance.now(),sinceSelectionMs:performance.now()-window.lastSelectionAt,top:l.scrollTop,offset:c?.parentElement.getBoundingClientRect().top-l.getBoundingClientRect().top,active:Number(c?.dataset.slideIndex)}};
`
const bundled = await build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error' })
const png = await sharp(Buffer.from('<svg width="1280" height="720"><rect width="1280" height="720" fill="#ccddee"/><text x="90" y="200" font-size="42">Synthetic statement</text></svg>')).png().toBuffer()
const result = { runs: [], errors: [] }
let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.TW_STRIP_CHROMIUM ? { executablePath: process.env.TW_STRIP_CHROMIUM } : {}) })
  const page = await browser.newPage({ viewport: { width: 1910, height: 1310 } })
  page.on('pageerror', e => result.errors.push(e.message))
  await page.route('https://fixture.test/**', r => r.fulfill({ contentType: 'image/png', body: png }))
  await page.setContent('<div id="stage" style="position:absolute;left:1010px;top:110px;width:900px;height:1200px"></div>')
  await page.addStyleTag({ content: readFileSync(resolve(root, 'src/renderer/src/styles.css'), 'utf8') })
  await page.addScriptTag({ content: bundled.outputFiles[0].text })
  const position = () => page.evaluate(() => window.position())
  const click = i => page.evaluate(i => document.querySelector('[data-slide-index="'+i+'"]').click(), i)
  async function mount() {
    await page.evaluate(() => window.mount())
    await page.waitForFunction(() => document.images.length === 189 && [...document.images].every(i => i.complete && i.naturalWidth))
    await page.waitForTimeout(100)
  }
  async function settled(name) {
    const frames = await page.evaluate(async () => {
      const frames = []
      for (let i = 0; i < 8; i++) { await new Promise(requestAnimationFrame); frames.push(window.position()) }
      return frames
    })
    await page.waitForTimeout(1400)
    const later = await position()
    assert.equal(later.top, frames.at(-1).top, name + ' stays settled beyond the former 1.3s tail')
    result.runs.push({ name, frames, later })
    console.log(JSON.stringify({ name, frames }))
    assert.ok(frames.every(f => Math.abs(f.offset) < 1), name + ' aligns by next frame and stays at top')
    assert.ok(Math.max(...frames.map(f => f.top)) - Math.min(...frames.map(f => f.top)) < 1, name + ' has no animation tail')
  }
  await mount()
  await page.locator('[data-place-region="strip"]').focus()
  for (let i = 0; i < 12; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(35) }
  await settled('12 rapid keyboard changes')
  assert.equal((await position()).active, 12)
  await mount()
  await page.evaluate(async () => { for (let i = 1; i <= 12; i++) { window.draw({ activeIndex: i }); await new Promise(r => setTimeout(r, 35)) } })
  await settled('12 external active changes')
  assert.equal((await position()).active, 12)
  await mount()
  await click(4)
  await page.waitForTimeout(50)
  const during = await position()
  await page.waitForTimeout(1200)
  const after = await position()
  result.runs.push({ name: 'single click', during, after })
  assert.ok(Math.abs(during.offset) > 10, 'single click still animates')
  assert.ok(Math.abs(after.offset) < 1, 'single click ends at top')
  await page.evaluate(() => { document.querySelector('[data-place-region="strip"]').lastElementChild.style.scrollBehavior = 'smooth' })
  await click(20)
  await page.waitForTimeout(50)
  await page.evaluate(() => window.draw({ activeIndex: 25 }))
  await settled('editor interrupts click with CSS smooth')
  await click(25)
  await page.evaluate(() => window.draw({ activeIndex: 30 }))
  await settled('same-index click intent consumed')
  await page.evaluate(() => { const l = document.querySelector('[data-place-region="strip"]').lastElementChild; l.scrollTo({ top: l.scrollTop + 200, behavior: 'instant' }) })
  const manual = await position()
  await page.waitForTimeout(300)
  assert.equal((await position()).top, manual.top, 'ordinary scrolling remains free')
  // Hidden section cards remain absent and keyboard navigation skips to the next visible section.
  await mount()
  await page.locator('.strip-section button').first().click()
  await page.locator('[data-place-region="strip"]').focus()
  await page.keyboard.press('ArrowDown')
  assert.equal((await position()).active, 30)
  await settled('keyboard skips collapsed section')
  await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => window.lastEdit), 30)
  assert.equal(await page.locator('[data-place-region="strip"]').evaluate(e => e === document.activeElement), true)
  await mount()
  await page.evaluate(() => window.carousel())
  await page.locator('[data-subslide]').evaluate(e => e.click())
  await page.waitForTimeout(50)
  assert.equal((await position()).active, 4, 'carousel selects parent')
  assert.ok(Math.abs((await position()).offset) > 10, 'carousel click animates')
  await page.evaluate(() => window.draw({ activeIndex: 8 }))
  await settled('editor interrupts carousel click')
  // A memoised card must still call the latest parent callback.
  await page.evaluate(() => window.draw({ onSelectSlide: i => { window.latestSelection = i; window.draw({ activeIndex: i }) } }))
  await click(20)
  assert.equal(await page.evaluate(() => window.latestSelection), 20)
  await page.waitForTimeout(50)
  await page.evaluate(() => window.draw({ talk: { slug: 'other', title: 'Other', outlinePath: '/synthetic/other-outline.md' } }))
  await settled('talk replacement cancels click')
  await click(40)
  await page.waitForTimeout(50)
  await page.evaluate(() => { window.oldList = document.querySelector('[data-place-region="strip"]').lastElementChild; window.dispose(); window.oldTop = window.oldList.scrollTop })
  await page.waitForTimeout(150)
  assert.equal(await page.evaluate(() => window.oldList.scrollTop), await page.evaluate(() => window.oldTop), 'unmount cancels follow work')
  assert.deepEqual(result.errors, [])
  console.log('PASS sidebar follow: actual frame settling, click animation, cancellation, collapse, carousel, focus and current callbacks')
} finally {
  await browser?.close()
  if (process.env.TW_STRIP_RESULTS) writeFileSync(process.env.TW_STRIP_RESULTS, JSON.stringify(result, null, 2) + '\n')
}
