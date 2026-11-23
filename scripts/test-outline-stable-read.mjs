import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOutlineDiskGuard, hashOutlineText } from '../src/main/outline-disk-guard.ts'
import { configureTalkWriter, writeTalkOutline } from '../src/main/talk-writer.ts'
const root = mkdtempSync(join(tmpdir(), 'tw-stable-outline-'))
const path = join(root, 'outline.md')
const base = '# Talk\n\n## Slide\n{id=a}\n- original\n'
const full = base + '\n## Agent append\n{id=b}\n- complete\n'
let reads = 0, changing = false, completion
const guard = createOutlineDiskGuard({
  canonical:p=>p, withLock:(_p,work)=>work(), watch(){},unwatch(){},notify(){},
  mtime:async()=>statSync(path).mtimeMs,
  readText:async()=>{
    reads++
    const text=readFileSync(path,'utf8')
    if(reads===1) completion=setTimeout(()=>writeFileSync(path,full),250) // two reads 80 ms apart would accept the paused partial write
    if(changing) return text + reads
    return text
  },
})
try {
  writeFileSync(path, full.slice(0,20)); guard.track('win',path,base)
  const started=Date.now()
  const version = await guard.diskVersion(path)
  assert.equal(version.text,full,'stable read must not merge a partially written outline as deletions')
  assert.ok(reads>=5)
  assert.ok(Date.now()-started>=400,'N4: require a longer stability window')
  changing=true
  await assert.rejects(()=>guard.diskVersion(path),/still changing/)
  changing=false
  writeFileSync(path,base); guard.track('win',path,base)
  configureTalkWriter({editorBufferFor:()=>null,diskGuard:guard})
  const result=await writeTalkOutline(path,full,'editor',{expectedDiskHash:hashOutlineText(full)})
  assert.equal(result.ok,false,'a stale observed hash must refuse even when the disk reverted to the main guard baseline')
  assert.equal(readFileSync(path,'utf8'),base)
  configureTalkWriter({editorBufferFor:()=>null,diskGuard:{...guard,conflict:async()=>{throw Error('injected version check failure')}}})
  const failedCheck=await writeTalkOutline(path,full,'editor',{expectedDiskHash:hashOutlineText(base)})
  assert.equal(failedCheck.ok,false,'observed-version guard failures must fail closed')
  assert.equal(readFileSync(path,'utf8'),base)
  console.log('stable outline reads and per-write observed-version refusal passed')
} finally {clearTimeout(completion);guard.dispose();configureTalkWriter({editorBufferFor:()=>null});rmSync(root,{recursive:true,force:true})}
