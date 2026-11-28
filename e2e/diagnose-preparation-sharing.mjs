import assert from 'node:assert/strict'
import { createAppScratch, launchApp } from './lib/launch-app.mjs'
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
await using fixture = createAppScratch()
const root=fixture.root,ud=join(root,'ud'),vault=join(root,'vault'),dir=join(vault,'large')
mkdirSync(ud,{recursive:true});mkdirSync(dir,{recursive:true})
const path=join(dir,'large-outline.md'),source='---\noutline_version: 2\ntitle: Large\n---\n\n'+Array.from({length:500},(_,i)=>`### Slide ${i} {#s-${i}}\n\nBody ${i}\n`).join('\n')
writeFileSync(path,source);writeFileSync(join(ud,'config.json'),JSON.stringify({vaultRoot:vault}))
const app=(await launchApp({ scratch: fixture, userData: ud, env: { ...process.env, TW_REC_TEST:'1' } })).app
try {
const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded')
// Startup prepares the title slide on the background lane. Measure the three foreground
// requests only after the Explorer has received that thumbnail for the one talk in this vault.
const recent = page.getByRole('region', { name: 'Vault Explorer' }).getByRole('group', { name: 'Recent talks' })
await recent.locator('.vx-cover img').first().waitFor({ state: 'attached', timeout: 30_000 })
const startupPreparations = await app.evaluate(() => {
  const count = globalThis.__twPrepareCount ?? 0
  globalThis.__twPrepareCount = 0
  return count
})
const timing=await page.evaluate(async({path,source})=>{const t=performance.now();await Promise.all([window.tw.talk.compile(path,source),window.tw.slide.renderPreview(path,source),window.tw.talk.compile(path,source)]);return performance.now()-t},{path,source})
const result=await app.evaluate(()=>({preparations:globalThis.__twPrepareCount,heap:process.memoryUsage().heapUsed}))
assert.equal(result.preparations,1,'concurrent editor and inspector requests prepare the same 500-slide document once')
console.log(JSON.stringify({ ...result, startupPreparations }))
console.log('simultaneousRequestsMs',timing)
console.log('PASS real preparation sharing: three requests, one compiler pass')
}finally {
  // Passing compiler assertions is not enough: settings must drain and Electron must exit too.
  const child = app.process()
  let timer
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Electron did not quit within 10 seconds after preparation sharing'))
          child.kill('SIGKILL')
        }, 10_000)
      })
    ])
    assert.equal(child.exitCode, 0, 'Electron exits normally after settings shutdown')
    console.log('PASS real Electron shutdown: settings drained and process exited normally')
  } finally { clearTimeout(timer) }
}
