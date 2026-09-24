import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const root=mkdtempSync(join(tmpdir(),'tw-compile-probe-')),ud=join(root,'ud'),vault=join(root,'vault'),dir=join(vault,'large')
mkdirSync(ud,{recursive:true});mkdirSync(dir,{recursive:true})
const path=join(dir,'large-outline.md'),source='---\noutline_version: 2\ntitle: Large\n---\n\n'+Array.from({length:500},(_,i)=>`### Slide ${i} {#s-${i}}\n\nBody ${i}\n`).join('\n')
writeFileSync(path,source);writeFileSync(join(ud,'config.json'),JSON.stringify({vaultRoot:vault}))
const app=await electron.launch({args:['.','--user-data-dir='+ud],cwd:process.cwd(),env:{...process.env,TW_E2E:'1',TW_REC_TEST:'1'}})
try {
const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded')
await app.evaluate(()=>{globalThis.__twPrepareCount=0})
const timing=await page.evaluate(async({path,source})=>{const t=performance.now();await Promise.all([window.tw.talk.compile(path,source),window.tw.slide.renderPreview(path,source),window.tw.talk.compile(path,source)]);return performance.now()-t},{path,source})
const result=await app.evaluate(()=>({preparations:globalThis.__twPrepareCount,heap:process.memoryUsage().heapUsed}))
assert.equal(result.preparations,1,'concurrent editor and inspector requests prepare the same 500-slide document once')
console.log(JSON.stringify(result))
console.log('simultaneousRequestsMs',timing)
console.log('PASS real preparation sharing: three requests, one compiler pass')
}finally {await app.close()}
