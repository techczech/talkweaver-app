import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {inventoryFilesystem} from '../../../src/main/vault-gallery-inventory-fs.ts'
import {readGallerySource} from '../../../src/main/vault-gallery-read.ts'
const home=path.resolve('scripts/vault-gallery/native-lifecycle-repairs/protocol-fixture');fs.mkdirSync(home,{recursive:true})
try{
 for(const phase of ['identity','list','next','end','malformed','exit','deadline','close','source']){
 const marker=path.join(home,'marker');fs.writeFileSync(marker,'');const helper=path.join(home,'helper')
 fs.writeFileSync(helper,`#!/usr/bin/env node
process.on('SIGTERM',()=>{});require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);if(${JSON.stringify(phase)}==='exit')process.exit(1);if(${JSON.stringify(phase)}==='malformed'){console.log('bad');return}if(r.op===${JSON.stringify(phase)}||['deadline','close'].includes(${JSON.stringify(phase)}))return;console.log(JSON.stringify({id:r.id,value:r.op==='next'?{done:true,batch:[]}:r.op==='list'?'key':{}}))});`);fs.chmodSync(helper,0o755)
 let adapter,pending,closed
 if(phase==='source')pending=readGallerySource(home,path.join(home,'file'),()=>fs.existsSync(marker),fs.statSync(home),helper,marker)
 else{adapter=inventoryFilesystem(home,helper,'',{marker,deadline:Date.now()+(phase==='deadline'?120:2000)});pending=(async()=>{await adapter.identity();for await(const x of adapter.children('captures')){} })()}
 const reject=assert.rejects(pending)
 if(!['malformed','exit','deadline'].includes(phase)){await new Promise(r=>setTimeout(r,120));if(phase==='close')closed=adapter.close();else fs.unlinkSync(marker)}
 await reject;await closed;await adapter?.close();console.log('PASS pending '+phase+' settles after cancellation/failure and actual close')
 }
 const missing=inventoryFilesystem(home,path.join(home,'missing'));await assert.rejects(missing.identity());await missing.close();console.log('PASS spawn error settlement')
}finally{fs.rmSync(home,{recursive:true,force:true})}
