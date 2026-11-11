// Hidden Electron, synthetic local widget and data: sanitisation, file authority and one editor Undo.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { createSocket } from 'node:dgram'
import { createServer as createTcpServer } from 'node:net'
import { captureAttack } from './lib/capture-network-attack.mjs'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
const repo = resolve('.')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-offline-e2e-')))
const userData = join(scratch, 'userData'), vault = join(scratch, 'vault'), talk = join(vault, 'offline-page'), assets = join(talk, 'assets')
for (const dir of [userData, assets]) mkdirSync(dir, { recursive: true })
const outlinePath = join(talk, 'offline-page-outline.md')
const outline = '---\ntitle: Offline page\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Widget\n{id=widget}\n\n[Embed: assets/widget.html]\n\n### After\n{id=after}\n\n- Keep me\n'
writeFileSync(outlinePath, outline)
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'markdown' }))
let app, hits = 0, udpHits = 0, tcpHits = 0
const udp = createSocket('udp4'); udp.on('message', () => udpHits++)
const tcp = createTcpServer(socket => { tcpHits++; socket.destroy() })
await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve))
await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve))
const attack = `<script>(()=>{
 let peers=0;
 function peer(realm){try{const C=realm.RTCPeerConnection||realm.webkitRTCPeerConnection;if(typeof C!=='function')return;const p=new C({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'},{urls:'turn:127.0.0.1:${tcp.address().port}?transport=tcp',username:'fixture',credential:'fixture'}]});peers++;p.createDataChannel('probe');p.createOffer().then(o=>p.setLocalDescription(o)).catch(()=>{});}catch{}}
 try{new WebSocket('ws://127.0.0.1:${tcp.address().port}/blocked')}catch{}
 peer(window);const f=document.createElement('iframe');document.body.append(f);peer(f.contentWindow);
 const proof=document.createElement('p');proof.textContent='PEERS:'+peers+' RTC:'+typeof RTCPeerConnection+' CHILD:'+typeof f.contentWindow.RTCPeerConnection+' TRANSPORT:'+typeof WebTransport;document.body.append(proof);
 const l=document.createElement('link');l.rel='preconnect';l.href='https://127.0.0.1:${tcp.address().port}';document.head.append(l);
 })();</script><p id="opaque-witness"></p>`+captureAttack(udp.address().port,tcp.address().port)+`<script>setTimeout(()=>document.querySelector('#opaque-witness').textContent='Opaque capture frames '+globalThis.__reports.length,600)</script>`
const networkProof = 'PEERS:0 RTC:undefined CHILD:undefined TRANSPORT:undefined'

const server = createServer((req, res) => {
  if (req.url === '/page') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Remote fixture</title><h1>Remote page</h1><p id="security"></p><script>document.querySelector("#security").textContent=typeof window.tw+"/"+typeof require;fetch("/data.json").then(r=>r.json()).then(d=>document.querySelector("h1").textContent="Remote count "+d.count);window.open("https://example.org")</script>'+attack); return }
  if (req.url === '/data.json') { res.setHeader('Content-Type', 'application/json'); res.end('{"count":42,"label":"REMOTE-DATA"}'); return }
  hits++; res.end('must not be reached')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
try {
  writeFileSync(join(assets, 'data.json'), '{"count":42,"label":"SUPPORTING-DATA"}')
  writeFileSync(join(assets, 'widget.html'), `<!doctype html><title>Widget</title><h1 id="result">Waiting</h1><table><tr><td>Offline table</td></tr></table><canvas width="20" height="20"></canvas><script>fetch('data.json').then(r=>r.json()).then(d=>document.querySelector('h1').textContent='Count '+d.count);fetch('http://127.0.0.1:${port}/leak').catch(()=>{});window.open('https://example.org');</script>`)
  await ensureFreshBuild(repo)
  const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1', TW_E2E_LIVE_PAGE_ALLOW: `127.0.0.1:${port}` }; delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: repo, env })
  app.on('console', message => { if (message.text().includes('[offline-page]')) console.log(message.text()) })
  const page = await app.firstWindow(); page.setDefaultTimeout(30000)
  await page.locator('[data-talk-slug="offline-page"]').first().dblclick()
  await page.locator('.cm-content').waitFor()
  await page.locator('.tw-slide-card[data-slide-index="0"]').waitFor()
  const read = () => page.evaluate(() => document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.toString())
  await page.locator('.tw-slide-card[data-slide-index="0"]').click()
  // Use the menu entry: the same command is also in the palette and Inspector.
  await page.locator('.toolbar-btn', { hasText: 'Insert' }).first().click()
  await page.getByRole('menuitem', { name: 'Offline HTML copy…' }).click()
  try {
  await page.waitForFunction(() => document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.toString().includes('[Embed: assets/offline-page.html]'), null, { timeout: 30000 })
  } catch (error) {
    console.log('Offline UI status:', (await page.locator('body').innerText()).slice(-1600))
    console.log('Offline IPC diagnostic:', await page.evaluate(path => window.tw.htmlPage.saveOffline({ outlinePath: path, source: 'assets/widget.html' }), outlinePath))
    throw error
  }

  const after = await read()
  // The menu replacement schedules autosave. Finish that author edit before starting another
  // independent capture: the strict size/mtime guard must refuse a save racing this disk write.
  await page.waitForFunction(() => document.body.innerText.includes('Saved just now') && !document.body.innerText.includes('● Unsaved'))
  assert.equal(readFileSync(outlinePath, 'utf8'), await read(), 'the preceding edit is saved before another capture starts')
  assert.ok(after.includes('- Keep me'))
  const html = readFileSync(join(assets, 'offline-page.html'), 'utf8')
  assert.ok(html.includes('Count 42'), 'rendered data survives')
  assert.ok(html.includes('SUPPORTING-DATA'), 'loaded JSON kept as inert text')
  assert.ok(html.includes('Offline table'))
  assert.ok(html.includes("script-src 'none'"))
  assert.ok(!html.includes('<script'))
  assert.equal(hits, 0, 'local page cannot exfiltrate source-folder content to the network')
  const remote = await page.evaluate(({path,url}) => window.tw.htmlPage.saveOffline({ outlinePath: path, source: url }), { path: outlinePath, url: `http://127.0.0.1:${port}/page` })
  assert.equal(remote.ok, true, JSON.stringify(remote))
  const remoteHtml = readFileSync(join(talk, remote.embedPath), 'utf8')
  assert.ok(remoteHtml.includes('Remote count 42'))
  assert.ok(remoteHtml.includes('REMOTE-DATA'))
  assert.ok(remoteHtml.includes('undefined/undefined'), 'remote page has no app bridge or Node')
  assert.ok(!remoteHtml.includes('<script'))

  assert.ok(remoteHtml.includes('Opaque capture frames 2'), 'remote opaque and nested srcdoc execute during the protected capture')
  assert.ok(remoteHtml.includes(networkProof), 'remote capture closes both top and synchronous child RTC realms')
  // Keep the hostile local fixture out of the editor: only the real offline capture executes it.
  writeFileSync(join(assets, 'network-widget.html'), '<!doctype html><title>Local network fixture</title><h1>Local</h1>'+attack)
  const localAttack = await page.evaluate(path => window.tw.htmlPage.saveOffline({ outlinePath: path, source: 'assets/network-widget.html' }), outlinePath)
  assert.equal(localAttack.ok, true, JSON.stringify(localAttack))
  const localAttackHtml = readFileSync(join(talk, localAttack.embedPath), 'utf8')
  assert.ok(localAttackHtml.includes('Opaque capture frames 2'), 'local opaque and nested srcdoc execute during the deny-all capture')
  assert.ok(localAttackHtml.includes(networkProof), 'local capture also closes both RTC realms')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(udpHits, 0, 'real local and remote offline captures send no STUN datagrams to loopback')
  assert.equal(tcpHits, 0, 'real local and remote offline captures make no TURN/TCP, WebSocket or preconnect connections to loopback')

  assert.ok(readFileSync(join(assets, 'widget.html'), 'utf8').includes('<script>'), 'source untouched')
  await page.locator('.cm-content').click(); await page.keyboard.press('Meta+z')
  await page.waitForFunction(expected => document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.toString() === expected, outline)
  const refused = await page.evaluate(path => window.tw.htmlPage.saveOffline({ outlinePath: path, source: '../outside.html' }), outlinePath)
  assert.equal(refused.ok, false)
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible())), true)
  console.log('PASS: offline local and remote data/image capture, sanitisation, network denial (STUN/UDP0 and TURN/TCP0 for local+remote), source preservation, Insert menu and one-step Undo')
} finally {
  await app?.close()
  await new Promise(resolve => server.close(resolve))
  udp.close()
  await new Promise(resolve => tcp.close(resolve))
  rmSync(scratch, { recursive: true, force: true })
}
