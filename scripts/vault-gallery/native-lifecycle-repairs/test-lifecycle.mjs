import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {readGallerySource} from '../../../src/main/vault-gallery-read.ts'
import {galleryAcquiredAssets} from '../../../src/main/vault-gallery-assets.ts'
const home=path.resolve('scripts/vault-gallery/native-lifecycle-repairs/fixture');fs.mkdirSync(home,{recursive:true})
const helper=path.join(home,'helper'),marker=path.join(home,'marker');fs.writeFileSync(marker,'')
fs.writeFileSync(helper,`#!/usr/bin/env node
const fs=require('fs');fs.writeFileSync(${JSON.stringify(home+'/pid')},String(process.pid));process.on('SIGTERM',()=>{});require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);if(r.op==='source')setTimeout(()=>{console.log(JSON.stringify({value:{data:'eA==',text:'x',size:1}}));process.exit()},350);});`);fs.chmodSync(helper,0o755)
try{
 let beat=false;setTimeout(()=>beat=true,20)
 const pending=readGallerySource(home,path.join(home,'file'),()=>true,fs.statSync(home),helper)
 assert.equal(typeof pending.then,'function','source acquisition must be asynchronous');await pending;assert.equal(beat,true)
 const assets=galleryAcquiredAssets({root:home,identity:fs.statSync(home),executable:helper,cache:home,marker})
 const listing=assets.list(path.join(home,'captures'));const rejected=assert.rejects(listing)
 await new Promise(r=>setTimeout(r,150));fs.unlinkSync(marker);await rejected;await assets.close()
 const pid=Number(fs.readFileSync(path.join(home,'pid')));assert.throws(()=>process.kill(pid,0));assert.equal(fs.readdirSync(home).some(n=>n.startsWith('gallery-')),false)
 console.log('PASS asynchronous heartbeat, marker cancellation, SIGKILL escalation, exited child and snapshot cleanup')
}finally{fs.rmSync(home,{recursive:true,force:true})}
