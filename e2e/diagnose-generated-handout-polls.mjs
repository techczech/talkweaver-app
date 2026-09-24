import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createServer as httpServer } from 'node:http'
import { pathToFileURL } from 'node:url'
const compilerScripts = process.env.TW_TEST_COMPILER_SCRIPTS || resolve('compiler/scripts')
const { buildShareHtml } = await import(pathToFileURL(join(compilerScripts, 'lib/09-output-builders.mjs')).href)

// Verify a generated handout through presenter IPC, a local Worker and a real browser ballot.
// No production credentials, remote session or user vault are used.
const root = mkdtempSync(join(tmpdir(), 'tw-poll-launch-'))
const ud = join(root, 'userData'), vault = join(root, 'vault'), deck = join(vault, 'poll-launch')
mkdirSync(ud, { recursive: true }); mkdirSync(deck, { recursive: true })
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
let app, web
try {
const handoutTemplate = process.env.TW_TEST_HANDOUT_HTML ? readFileSync(process.env.TW_TEST_HANDOUT_HTML, 'utf8') : null
const templateSlideIds = handoutTemplate ? [...handoutTemplate.matchAll(/<section\b([^>]*)>/g)].flatMap(match => {
  if (!/class=["'][^"']*\bslide\b/.test(match[1])) return []
  const id = match[1].match(/data-id=["']([^"']+)/)?.[1]
  return id ? [id] : []
}) : ['rank', 'rate']
const [rankId, rateId] = templateSlideIds
assert.ok(rankId && rateId && rankId !== rateId && [rankId, rateId].every(id=>/^[A-Za-z0-9_-]+$/.test(id)))
// A staged production handout is served only locally; its live config is replaced in memory.
// Static slide content, new runtime and styles remain the staged candidate's actual bytes.
if(handoutTemplate) assert.equal((handoutTemplate.match(/const LIVE_CONFIG = [^\n]+;/g)||[]).length,1)
const generatedHandout = handoutTemplate ? handoutTemplate.replace(/const LIVE_CONFIG = [^\n]+;/, 'const LIVE_CONFIG = '+JSON.stringify({workerBaseUrl:`http://127.0.0.1:${port}`,talkSlug:'poll-launch'})+';') : buildShareHtml({title:'Local browser ballot probe', slug:'poll-launch', styles:'', includeNotes:false, workerBaseUrl:`http://127.0.0.1:${port}`, slides:[rankId,rateId].map(id=>({html:`<section class="slide" data-id="${id}"><h2>${id}</h2></section>`}))})
web = httpServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(generatedHandout)})
await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve))
const handoutUrl = `http://127.0.0.1:${web.address().port}/handout.html`
let phone
const source = `---
outline_version: 2
title: Extended poll launch
handout_url: ${handoutUrl}
auto_title_slide: false
auto_thanks_slide: false
---

### Rank these approaches
{id=${rankId} poll=ranking pollresults=held}

- Read
- Discuss
- Practise

### Rate these approaches
{id=${rateId} poll=rating}

[scale: 1, 2, 3]

- Read
- Discuss
- Practise
`
const outlinePath = join(deck, 'poll-launch-outline.md')
writeFileSync(outlinePath, source)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault, liveWorkerBaseUrl: `http://127.0.0.1:${port}` }))
const executablePath = process.env.TW_TEST_APP_EXECUTABLE
app = await electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : ['.']), '--user-data-dir=' + ud],
  cwd: resolve('.'), env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1', TW_LIVE_LOCAL: '1' }
})
  await app.evaluate(({ app, BrowserWindow }) => {
    const hide = win => { win.setPosition(-20000, -20000); win.hide() }
    BrowserWindow.getAllWindows().forEach(hide)
    app.on('browser-window-created', (_event, win) => hide(win))
  })
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  const win = app.waitForEvent('window')
  const opened = main.evaluate(({ outlinePath, source, rankId }) => window.tw.talk.present(outlinePath, source, 'presenter', rankId), { outlinePath, source, rankId })
  const presenter = await win
  assert.equal((await opened).success, true)
  await presenter.waitForLoadState('domcontentloaded')
  presenter.setDefaultTimeout(45000)
  const errors = []; presenter.on('pageerror', error => errors.push(error.message))
  await presenter.locator('#liveGoButton').click()
  await presenter.waitForFunction(() => document.querySelector('#liveGoButton')?.classList.contains('is-live'))
  await presenter.locator('#liveGoPanelClose').click()
  const phoneWindow = app.waitForEvent('window')
  await app.evaluate(({BrowserWindow, session}, url)=>{
    const probe = session.fromPartition('handout-probe')
    probe.webRequest.onBeforeRequest((request, done)=>{
      const target = new URL(request.url)
      done({cancel: ['http:','https:','ws:','wss:'].includes(target.protocol) && target.hostname !== '127.0.0.1'})
    })
    const w=new BrowserWindow({width:390,height:844,show:false,webPreferences:{partition:'handout-probe',sandbox:true,contextIsolation:true,nodeIntegration:false}})
    void w.loadURL(url)
  },handoutUrl)
  phone = await phoneWindow
  await phone.waitForLoadState('domcontentloaded')
  await phone.waitForFunction(()=>document.querySelector('#liveFollowStatus')?.textContent==='live')
  for (const [slide, type] of [[rankId, 'ranking'], [rateId, 'rating']]) {
    if (slide === rateId) await presenter.keyboard.press('ArrowRight')
    await presenter.waitForFunction(id => document.querySelector('.slide.active')?.dataset.id === id, slide)
    await presenter.locator('#presenterPollOpen').click()
    await presenter.waitForFunction(() => document.querySelector('#presenterPollChip')?.textContent === 'Poll open · 0')
    assert.equal(await presenter.locator('#presenterPollType').textContent(), type.toUpperCase())
    assert.match(await presenter.locator('#presenterPollDisplayStatus').textContent(), /Accepting responses/)
    assert.equal(await presenter.locator('#presenterPollOperation').isVisible(), false)
    console.log(`PASS ${type}: actual presenter click received local Worker confirmation`)
    await phone.locator('.poll-vote').waitFor({state:'visible'})
    let expectedChoice
    if(type==='ranking') {
      assert.equal(await phone.locator('.poll-rank-list .poll-rank-row').count(),3)
      expectedChoice = await phone.locator('.poll-rank-list .poll-rank-row').evaluateAll(rows=>rows.map(row=>row.dataset.rankId))
      ;[expectedChoice[0],expectedChoice[1]]=[expectedChoice[1],expectedChoice[0]]
      await phone.locator('[data-rank-down]').first().click()
      assert.deepEqual(await phone.locator('.poll-rank-list .poll-rank-row').evaluateAll(rows=>rows.map(row=>row.dataset.rankId)),expectedChoice)
    } else {
      assert.equal(await phone.locator('.poll-matrix-item').count(),3)
      expectedChoice = {}
      for(const [index,field] of (await phone.locator('.poll-matrix-item').all()).entries()) {
        const input=field.locator('input').nth(index)
        expectedChoice[await input.getAttribute('data-matrix-row')]=await input.getAttribute('value')
        await input.check()
      }
    }
    await phone.locator('.poll-submit').click()
    await phone.waitForFunction(()=>/answer recorded/i.test(document.querySelector('#audiencePollSurface')?.textContent || ''))
    await presenter.waitForFunction(()=>document.querySelector('#presenterPollChip')?.textContent==='Poll open · 1')
    await phone.reload()
    await phone.waitForFunction(()=>/answer recorded/i.test(document.querySelector('#audiencePollSurface')?.textContent || ''))
    assert.equal(await phone.locator('.poll-submit').count(),0)
    const savedChoices=await phone.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('talkweaver:poll-vote:')).map(k=>JSON.parse(localStorage.getItem(k))))
    assert.ok(savedChoices.some(value=>JSON.stringify(value)===JSON.stringify(expectedChoice)), 'Confirmed receipt must retain the reordered ranking or distinct per-item rating values')
    console.log(`PASS ${type}: generated 390px handout rendered ballot, accepted one real response and retained receipt after reload`)
    await presenter.locator('#presenterPollClose').click()
    await presenter.waitForFunction(() => document.querySelector('#presenterPollChip')?.textContent === 'Poll closed · 1')
  }
  assert.deepEqual(errors, [])
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible())))
} finally {
  // This fixture tests poll delivery, not the interactive recording/close workflow.
  if(app){
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(win => win.destroy())).catch(() => {})
    await app.close().catch(() => {})
  }
  if(web) await new Promise(resolve=>web.close(()=>resolve()))
  rmSync(root, { recursive: true, force: true })
}
