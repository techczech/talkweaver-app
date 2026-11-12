// Run only under the shared machine slot, after the full suite. Never change failing assertions.
import {readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
const folder='docs/design/2026-11-10-record-and-edit-video/built/slice-2'
const full=readFileSync(`${folder}/${process.argv[2] || 'unit.log'}`,'utf8')
const names=(/^failed: (.+)$/m.exec(full)?.[1] ?? '').split(' ').filter(n=>/^test:[a-zA-Z0-9:-]+$/.test(n))
const results=[]
for(const name of names){
 const exits=[]
 for(let i=1;i<=2;i++){
  const result=spawnSync(process.execPath,['scripts/run-tests.mjs',name,'--jobs','1'],{encoding:'utf8',timeout:1000*60*20,maxBuffer:32*1024*1024})
  writeFileSync(`${folder}/recheck-${name.replaceAll(':','-')}-${i}.log`,(result.stdout ?? '')+(result.stderr ?? ''))
  exits.push(result.status)
 }
 results.push({name,exits,classification:exits.every(c=>c===0)?'load-only':'fails in isolation'})
}
writeFileSync(`${folder}/rechecks.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2))
