import assert from 'node:assert/strict'
import {createGalleryAdmission} from '../../../src/main/vault-gallery-admission.ts'
const gate=createGalleryAdmission(2,4);let active=0,max=0;const releases=[]
const load=()=>{active++;max=Math.max(max,active);return new Promise(r=>releases.push(()=>{active--;r('done')}))}
const jobs=[]
for(let i=0;i<10;i++){gate.cancel(1);jobs.push(gate.run(1,load));jobs.push(gate.run(2,load))}
await new Promise(r=>setImmediate(r));assert.equal(max,2);assert.ok(gate.pending()<=4)
while(releases.length){releases.shift()();await new Promise(r=>setImmediate(r))}
await Promise.all(jobs);assert.equal(max,2)
console.log('PASS shared active permits survive navigation and multiple senders; bounded pending')
