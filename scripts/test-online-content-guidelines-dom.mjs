import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { buildHandoutHomePageHtml } from '../compiler/scripts/lib/handout-home-page.mjs'
import { ONLINE_CONTENT_REPORT_URL } from '../compiler/scripts/lib/online-content-guidelines.mjs'

const root = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(root, '.tw-content-policy-dom-'))
const arg = process.argv.indexOf('--screenshots')
const screenshots = arg >= 0 ? resolve(process.argv[arg + 1]) : null
if (screenshots) mkdirSync(screenshots, { recursive: true })
let browser
try {
  await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import GuidePane from './src/renderer/src/components/GuidePane.tsx'; const noop=()=>{}; const learn={version:1,ran:[],opened:[],finished:{},read:[]}; window.reportCalls=[]; window.tw={guide:{openLink:async(...args)=>{window.reportCalls.push(args);return true;}}}; createRoot(document.getElementById('root')).render(React.createElement(GuidePane,{segment:'commands',onSegment:noop,steps:[],onStep:noop,chapters:{selected:null,chapters:[],learn,onSelect:noop,onBack:noop,chordOf:()=>'',practice:()=>({talk:'',section:'',openNow:false}),onOpenPractice:noop,flashId:null},how:{learn,openId:null,onOpen:noop,onBack:noop,onTry:noop},features:{learn,onRead:noop,readConnections:async()=>[],onAction:noop}}));`, resolveDir: root, sourcefile: 'policy-dom.tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(scratch, 'guide.js'), logLevel: 'silent' })
  writeFileSync(join(scratch, 'guide.html'), `<!doctype html><meta charset="utf-8"><title>TalkWeaver Guide preview</title><style>body{font:14px system-ui;background:#f5f5f3;color:#17202a;margin:24px}.guide{max-width:440px;background:white;padding:16px}.guide-segments{display:flex;gap:8px}.guide-body{max-height:none}${readFileSync(join(root,'src/renderer/src/guide.css'),'utf8')}</style><div id="root"></div><script src="guide.js"></script>`)
  const pageHtml = buildShareHtml({ title: 'Online content guidelines preview', slides: [{ html: '<section class="slide"><div class="slide-content"><h1>TalkWeaver audience view</h1><p>Your own cloud hosting</p></div></section>', notes: '' }], styles: '.slide{background:#fff;padding:48px;box-sizing:border-box;font:32px system-ui}', includeNotes: false, slug: 'policy-preview', license: null })
  writeFileSync(join(scratch, 'audience.html'), pageHtml)
  // The handout home page (white page, handout tokens): the guidelines sit in the page's flow under the handout, not floating.
  const homeSlides = [{ html: '<section class="slide" data-id="one" data-nav-title="TalkWeaver handout"><div class="slide-content"><h1>TalkWeaver handout</h1></div></section>', notes: '' }]
  writeFileSync(join(scratch, 'handout.html'), buildHandoutHomePageHtml({ title: 'Online content guidelines handout', slides: homeSlides, styles: readFileSync(join(root, 'compiler/assets/styles/base.css'), 'utf8'), slug: 'policy-handout', license: null, home: { url: 'https://handouts.example.test/k7m2', qr: '<svg aria-label="QR code"></svg>', event: 'Briefing', author: 'Speaker' } }))
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
  const reports = []
  await context.route('https://github.com/**', async route => {
    const request = route.request()
    reports.push({ url: request.url(), post: request.postData(), referer: request.headers().referer })
    await route.fulfill({ status: 200, body: 'Report destination intercepted by local test.' })
  })
  const page = await context.newPage()
  await page.goto(pathToFileURL(join(scratch, 'guide.html')).href)
  const disclosure = page.locator('[data-online-content-guidelines]')
  await disclosure.locator('summary').focus()
  await page.keyboard.press('Enter')
  assert.equal(await disclosure.getAttribute('open'), '')
  await page.getByRole('link', { name: 'Report an online content concern' }).click()
  assert.deepEqual(await page.evaluate(() => window.reportCalls), [['online-content-report']], 'the Guide passes only the fixed destination id, with no current-talk or other data')
  assert.equal(reports.length, 0, 'rendering or opening the Guide does not send a report')
  if (screenshots) await page.screenshot({ path: join(screenshots, 'talkweaver-guide-online-content.png'), fullPage: true })
  await page.goto(pathToFileURL(join(scratch, 'audience.html')).href)
  await page.locator('[data-online-content-guidelines] summary').click()
  await page.getByText('Nothing is attached automatically.', { exact: false }).waitFor()
  assert.equal(reports.length, 0, 'the generated page sends nothing before the user follows the report link')
  if (screenshots) await page.screenshot({ path: join(screenshots, 'talkweaver-audience-online-content.png') })
  const popupPromise = context.waitForEvent('page')
  await page.getByRole('link', { name: 'Report an online content concern' }).click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  assert.equal(popup.url(), ONLINE_CONTENT_REPORT_URL)
  assert.deepEqual(reports, [{ url: ONLINE_CONTENT_REPORT_URL, post: null, referer: undefined }], 'the public destination receives no attachments, query data or page referrer')
  await popup.close()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-online-content-report]').scrollIntoViewIfNeeded()
  assert.ok(await page.getByRole('link', { name: 'Report an online content concern' }).isVisible())
  if (screenshots) await page.screenshot({ path: join(screenshots, 'talkweaver-phone-online-content.png') })
  for (const width of [390, 1300]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(pathToFileURL(join(scratch, 'handout.html')).href)
    const panel = page.locator('[data-online-content-guidelines]')
    await panel.locator('summary').click()
    await panel.scrollIntoViewIfNeeded()
    const placed = await page.evaluate(() => {
      const el = document.querySelector('[data-online-content-guidelines]')
      const cs = getComputedStyle(el)
      const box = el.getBoundingClientRect()
      const home = document.querySelector('.handout-home').getBoundingClientRect()
      return { position: cs.position, shadow: cs.boxShadow, left: box.left, right: box.right, top: box.top + scrollY, homeBottom: home.bottom + scrollY, page: getComputedStyle(document.body).backgroundColor, width: innerWidth }
    })
    assert.equal(placed.page, 'rgb(255, 255, 255)', 'the handout page is on the white page token')
    assert.equal(placed.position, 'static', 'on the handout page the guidelines sit in the page, not floating over it')
    assert.equal(placed.shadow, 'none', 'the handout look has no shadows')
    assert.ok(placed.top >= placed.homeBottom - 1, 'the guidelines follow the handout instead of covering it')
    assert.ok(placed.left >= 15 && placed.right <= placed.width - 15, `the guidelines stay inside the page margins at ${width}px`)
    assert.ok(await page.getByRole('link', { name: 'Report an online content concern' }).isVisible())
    if (screenshots) await page.screenshot({ path: join(screenshots, `talkweaver-handout-online-content-${width}.png`) })
  }
  console.log('PASS Guide keyboard access and fixed-id reporting; generated page reporting has no attachments or referrer; phone reachability; handout home page placement')
} finally {
  await browser?.close()
  rmSync(scratch, { recursive: true, force: true })
}
