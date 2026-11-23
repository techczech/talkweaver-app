import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOutlineRecovery } from '../src/main/outline-recovery.ts'
const root = mkdtempSync(join(tmpdir(), 'tw-merge-retention-'))
let clock = Date.now()
const recovery = createOutlineRecovery(root,()=>clock)
const snapshot = {base:'base',mine:'mine',disk:'disk'}
try {
  let latest
  for(let i=0;i<24;i++) { clock++; latest=await recovery.preserveMerge('/talk/one.md',{...snapshot,mine:`mine ${i}`}) }
  const other=await recovery.preserveMerge('/talk/two.md',snapshot)
  const folder=join(root,'merges')
  assert.equal(readdirSync(folder).length,21,'N3: keep at most twenty merge archives per talk')
  assert.match(JSON.parse(readFileSync(latest,'utf8')).mine,/23/)
  const mines=readdirSync(folder).filter(name=>join(folder,name)!==other).map(name=>Number(JSON.parse(readFileSync(join(folder,name),'utf8')).mine.slice(5))).sort((a,b)=>a-b)
  assert.deepEqual(mines,Array.from({length:20},(_,i)=>i+4),'the newest twenty versions survive')
  const untouched=join(folder,'unrelated.json')
  writeFileSync(untouched,'unrelated file')
  // Simulate existing legacy bundles too: their age comes from filesystem metadata.
  const old=join(folder,'old-0123456789ab-00000000-0000-4000-8000-000000000000.json')
  writeFileSync(old,JSON.stringify(snapshot));utimesSync(old,new Date(clock-15*86400000),new Date(clock-15*86400000))
  clock+=15*86400000
  const restarted=createOutlineRecovery(root,()=>clock)
  await restarted.read('/talk/one.md')
  assert.deepEqual(readdirSync(folder),['unrelated.json'],'N3: reading recovery prunes all expired owned archives, including another talk and legacy files')
  assert.equal(readFileSync(untouched,'utf8'),'unrelated file')
  assert.ok(other)
  if (process.platform !== 'win32') {
    const copies = join(root, 'recovery-copies')
    mkdirSync(copies)
    const index = join(copies, 'index.json')
    const target = join(root, 'external-index.json')
    writeFileSync(target, '{}')
    symlinkSync(target, index)
    const writer = createOutlineRecovery(copies, () => clock)
    await assert.rejects(writer.save('/talk/original.md', 'new outline'))
    assert.deepEqual(readdirSync(copies), ['index.json'], 'an index staging refusal leaves no partial recovery copy or temporary file')
    assert.equal(readFileSync(target, 'utf8'), '{}')
  }
  console.log('merge archive retention: twenty per talk, fourteen days, restart cleanup and unrelated-file preservation passed')
} finally { rmSync(root,{recursive:true,force:true}) }
