import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
const appPath=process.argv[2]
assert.ok(appPath?.endsWith('.app'),'pass the signed TalkWeaver.app path')
const scratch=mkdtempSync(join(resolve('.'),'.tw-internal-gallery-smoke-'))
const vault=join(scratch,'Internal fixture vault'),talk=join(vault,'fixture'),userData=join(scratch,'userData')
mkdirSync(talk,{recursive:true});mkdirSync(userData)
writeFileSync(join(talk,'fixture-outline.md'),'---\noutline_version: 2\ntitle: Internal Gallery fixture\n---\n\n### Fixture slide\n\nSynthetic internal-build fixture.\n')
writeFileSync(join(userData,'config.json'),JSON.stringify({vaultRoot:vault,editorViewMode:'plain'}))
const env={...process.env,TW_E2E:'1',TW_REC_TEST:'1'}
delete env.ELECTRON_RUN_AS_NODE
let instance
try{
 instance=await electron.launch({executablePath:join(resolve(appPath),'Contents/MacOS/TalkWeaver'),args:[`--user-data-dir=${userData}`,'--use-mock-keychain'],env,cwd:resolve('.')})
 const page=await instance.firstWindow();await page.waitForLoadState('domcontentloaded')
 await page.locator('.vault-gallery-entry').click({timeout:30000})
 await page.locator('.vault-gallery').waitFor({timeout:30000})
 await page.getByRole('row',{name:/Internal fixture vault/}).waitFor({timeout:30000})
 const identity=await instance.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,version:app.getVersion(),allWindowsHidden:BrowserWindow.getAllWindows().every(w=>!w.isVisible()),windows:BrowserWindow.getAllWindows().length,pid:process.pid}))
 assert.equal(identity.packaged,true);assert.equal(identity.version,'0.42.0-alpha.19');assert.equal(identity.allWindowsHidden,true);assert.ok(identity.windows>0)
 assert.ok(await page.locator('.vault-gallery').isVisible())
 console.log(JSON.stringify({appPath:resolve(appPath),...identity,galleryOpen:true,fixtureVaultListed:true},null,2))
 console.log('PASS signed packaged TalkWeaver opens Vault Gallery with a synthetic vault; native windows remain hidden')
}finally{try{await instance?.close()}finally{rmSync(scratch,{recursive:true,force:true})}}
