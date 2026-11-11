import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { readOfflinePage } from '../src/main/offline-page-dom.js'
import { buildOfflinePage } from '../src/main/offline-page-policy.ts'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.route('**/*', route => route.abort())
  await page.setContent('<h1 style="color:rgb(20,60,40)">Offline title</h1><table><tr><td>42</td></tr></table><script>window.HOSTILE=true</script><iframe src="https://example.org/private"></iframe><form><input value="private"></form><canvas width="20" height="20"></canvas><img width="64" height="32" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><div style="background-image:linear-gradient(red,blue)">Background omitted</div>')
  const raw = await page.evaluate(readOfflinePage)
  const data = buildOfflinePage(raw, raw.images.map(item => item.src), [{ url: 'https://example.org/data.json', body: '{"count":42,"attack":"</pre><script>window.BAD=true</script>"}' }])
  const clean = await browser.newPage()
  const requests = []; clean.on('request', request => requests.push(request.url()))
  await clean.setContent(data.html)
  assert.equal(await clean.locator('h1').textContent(), 'Offline title')
  assert.equal(await clean.locator('td').textContent(), '42')
  assert.equal(await clean.locator('script,iframe,form,input').count(), 0)
  assert.equal(await clean.evaluate(() => window.HOSTILE || window.BAD || false), false)
  assert.ok((await clean.locator('details pre').textContent()).includes('"count":42'))
  assert.ok(!requests.some(url => /^https?:/.test(url)))
  assert.equal(await clean.locator('img').count(), 2)
  const dimensions = await clean.locator('img').last().boundingBox()
  assert.equal(dimensions.width, 64)
  assert.equal(dimensions.height, 32)
  assert.ok(data.omitted >= 2, 'background image and iframe omissions are counted')

  await page.setContent('<input value="visible"><textarea>Visible writing</textarea><select><option>Visible choice</option></select><input type="hidden" value="private"><textarea style="display:none">Hidden</textarea>')
  const controls = await page.evaluate(readOfflinePage)
  assert.equal(controls.omitted, 3, 'each visible form control is counted; hidden controls are excluded')
  await page.setContent('<div style="background-image:linear-gradient(red,blue)">Visible hero</div>')
  assert.equal((await page.evaluate(readOfflinePage)).omitted, 1, 'a CSS background omission is independent of frame/control omissions')
  await page.setContent('<img style="width:30px;height:15px" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">')
  const cssImage = await page.evaluate(readOfflinePage)
  await clean.setContent(buildOfflinePage(cssImage,cssImage.images.map(item=>item.src)).html)
  const cssDimensions = await clean.locator('img').boundingBox()
  assert.equal(cssDimensions.width,30)
  assert.equal(cssDimensions.height,15)
  // Exercise the real Inspector callbacks and Workspace save callback through replacement.
  const workspace = readFileSync('src/renderer/src/components/WorkspaceLayout.tsx', 'utf8')
  const callback = workspace.slice(workspace.indexOf('  const saveOffline = useCallback('), workspace.indexOf('  // Capture embed…', workspace.indexOf('  const saveOffline = useCallback(')))
  const harness = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React, { useCallback } from 'react'; import { createRoot } from 'react-dom/client'; import { flushSync } from 'react-dom'
import Inspector from './src/renderer/src/components/Inspector'
import {selectOfflinePage,offlinePageReplacement,type OfflinePageSelection} from './src/renderer/src/lib/offlinePage'
let buffer='', messages=[], captures=0
const activeTalkRef={current:{outlinePath:'/fixture/outline.md'}}, inspectedNowRef={current:0}, slideLinesRef={current:[1]}, offlineSavingRef={current:false}, inspectorCommitInProgressRef={current:false}
const editorReadRef={current:()=>({text:buffer})}, editorReplaceRef={current:text=>{buffer=text;return text}}
const notify=message=>messages.push(message), setOfflineSaving=()=>{}
window.tw={vault:{talkDefaults:async()=>null,onVaultsChanged:()=>()=>{},talkActivity:async()=>[],onTalkActivityChanged:()=>()=>{}},slide:{renderPreview:async()=>null},htmlPage:{saveOffline:async()=>{captures++;return {ok:true,embedPath:'assets/offline.html',images:0,dataFiles:0,omitted:0}}}}
const root=createRoot(document.body.appendChild(document.createElement('div')))
function App(){
${callback}
window.menuSave=saveOffline
return <Inspector talk={{outlinePath:'/fixture/outline.md'}} compiledSlides={null} outlineContent={buffer} triggerFindings={[]} activeIndex={0} headingLine={1} onSaveOffline={saveOffline} onCommitOption={()=>null} onBoardEdit={()=>false} />
}
window.fixture=text=>{buffer=text;messages=[];captures=0;flushSync(()=>root.render(<App key={text}/>))}
window.result=()=>({buffer,messages,captures})
` }, bundle: true, jsx: 'automatic', platform: 'browser', format: 'iife', write: false, logLevel: 'silent' })
  const caller = await browser.newPage()
  await caller.addScriptTag({content:harness.outputFiles[0].text})
  const url = 'https://example.org/page'
  const embed = `[Embed: ${url}]`, simulation = `[Simulation: ${url}]`
  const copied = `[Embed: assets/offline.html]\n\n[Original page](<${url}>)`
  const first = `### A\n${url}\n${embed}\n${embed}`
  await caller.evaluate(text=>window.fixture(text),first)
  await caller.getByRole('button',{name:'Save offline copy',exact:true}).first().click()
  await caller.waitForFunction(()=>window.result().captures===1 && window.result().buffer.includes('assets/offline.html'))
  assert.equal((await caller.evaluate(()=>window.result())).buffer,`### A\n${url}\n${copied}\n${embed}`)
  const mixed = `### A\n${simulation}\n${embed}`
  await caller.evaluate(text=>window.fixture(text),mixed)
  await caller.getByRole('button',{name:'Save offline copy',exact:true}).nth(1).click()
  await caller.waitForFunction(()=>window.result().buffer.includes('assets/offline.html'))
  assert.equal((await caller.evaluate(()=>window.result())).buffer,`### A\n${simulation}\n${copied}`)
  await caller.evaluate(text=>window.fixture(text),mixed)
  await caller.getByRole('button',{name:'Save offline copy',exact:true}).first().click()
  await caller.waitForFunction(()=>window.result().buffer.includes('assets/offline.html'))
  assert.equal((await caller.evaluate(()=>window.result())).buffer,`### A\n[Simulation: assets/offline.html]\n\n[Original page](<${url}>)\n${embed}`)
  const duplicate = `### A\n${embed}\n${embed}`
  await caller.evaluate(text=>window.fixture(text),duplicate)
  await caller.evaluate(()=>window.menuSave())
  const refused = await caller.evaluate(()=>window.result())
  assert.equal(refused.buffer,duplicate)
  assert.equal(refused.captures,0)
  assert.deepEqual(refused.messages,['This slide has more than one copy of that page. Select the one to save in the Inspector.'])
  console.log('PASS: real Inspector to Workspace replacement for bare URL plus two Embeds, Simulation plus Embed, and menu ambiguity refusal before capture')
  console.log('PASS: 14 offline DOM, resource isolation and inert supporting-data assertions')
} finally { await browser.close() }
