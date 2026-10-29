// A framing refusal must not erase the presenter title, controls and browser fallback.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
mkdirSync(new URL('../research/', import.meta.url), { recursive: true })
const dir = mkdtempSync(join(process.cwd(), 'research/scratch-remote-fallback-'))
const remote = createServer((req,res) => {
  res.setHeader('content-type','text/html')
  if(req.url === '/blocked') res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
  res.end('<title>Remote control</title><body style="height:4000px">REMOTE-CONTENT</body>')
})
let deckServer, browser
try {
  await new Promise(r=>remote.listen(0,'127.0.0.1',r))
  const origin = `http://127.0.0.1:${remote.address().port}`
  const outline = `---\ntitle: Fallback\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Blocked page {id=blocked}\n\n[Embed: ${origin}/blocked]\n\n### Allowed page {id=control}\n\n[Embed: ${origin}/control]\n`
  const path = join(dir,'fallback-outline.md'); writeFileSync(path,outline)
  const model = await prepareSource(path,outline,null,statSync(path),{},{})
  deckServer=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(model.fullHtml)})
  await new Promise(r=>deckServer.listen(0,'127.0.0.1',r))
  browser=await chromium.launch({headless:true,...(process.env.TW_HEADLESS_SHELL ? {executablePath:process.env.TW_HEADLESS_SHELL}:{})})
  const page=await browser.newPage({viewport:{width:1440,height:900}})
  const errors=[];page.on('console',m=>errors.push(m.text()))
  await page.goto(`http://127.0.0.1:${deckServer.address().port}/deck?presenter=1#blocked`)
  const pane=page.locator('#currentPreview')
  await pane.locator('iframe[data-remote-embed]').waitFor()
  await page.waitForTimeout(1200)
  assert.ok(errors.some(s=>s.includes('frame-ancestors')), 'the fixture is actually refused')
  assert.equal(await pane.locator('.remote-preview-title').count(),1,'presenter retains the slide title when framing is refused')
  assert.equal(await pane.locator('.remote-preview-title').textContent(),'Blocked page')
  assert.ok(await pane.locator('.remote-preview-tools').isVisible(),'fallback is visible outside the refused frame')
  const link=pane.locator('.embed-open-link')
  assert.equal(await link.getAttribute('href'),`${origin}/blocked`)
  assert.equal(await link.getAttribute('target'),'_blank')
  assert.equal(await link.getAttribute('rel'),'noopener')
  assert.ok(await link.isVisible())
  assert.match(await pane.textContent(),/If this page stays blank/)
  assert.ok(await pane.locator('.embed-interact-chip').isVisible())
  await pane.locator('.embed-interact-chip').click()
  assert.equal(await pane.locator('iframe').evaluate(f=>getComputedStyle(f).pointerEvents),'auto')
  await page.locator('.embed-return-btn').click()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(700)
  const frame=await pane.locator('iframe[data-remote-embed]').elementHandle()
  const content=await frame.contentFrame()
  await content.waitForFunction(()=>document.title==='Remote control')
  assert.equal(await pane.locator('.remote-preview-title').textContent(),'Allowed page')
  assert.ok(await pane.locator('.embed-open-link').isVisible())
  const boxes=await pane.evaluate(p=>{const f=p.querySelector('iframe').getBoundingClientRect(),t=p.querySelector('.remote-preview-tools').getBoundingClientRect();return {bottom:f.bottom,top:t.top}})
  assert.ok(boxes.bottom<=boxes.top+1,'fallback does not cover the live page')
  await page.keyboard.press('ArrowLeft');await page.waitForTimeout(500)
  assert.equal(await pane.locator('.remote-preview-title').textContent(),'Blocked page')
  console.log('remote page fallback: refusal enforced; title, Open, Interact, Return and navigation pass; allowed control loads')
} finally {
  await browser?.close();await new Promise(r=>remote.close(r));if(deckServer)await new Promise(r=>deckServer.close(r));rmSync(dir,{recursive:true,force:true})
}
