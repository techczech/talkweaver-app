import assert from 'node:assert/strict'
import {createGalleryAdmission} from '../../../src/main/vault-gallery-admission.ts'
const gate=createGalleryAdmission();const releases=[];const calls=[];
const load=name=>()=>{calls.push(name);return new Promise(r=>releases.push(()=>r(name)))};
const a=gate.run(1,load('old1')), b=gate.run(2,load('old2'));await new Promise(setImmediate);
const queued=gate.run(1,load('never'));gate.cancel(1);assert.equal(await queued,null);
const next=gate.run(3,load('next'));await new Promise(setImmediate);assert.deepEqual(calls,['old1','old2']);
releases.shift()();assert.equal(await a,null);await new Promise(setImmediate);assert.deepEqual(calls,['old1','old2','next']);
gate.invalidate();releases.splice(0).forEach(r=>r());assert.equal(await b,null);assert.equal(await next,null);
assert.equal(await gate.run(4,async()=> 'new'), 'new');console.log('PASS sender navigation/destruction cancellation suppresses late results, holds active permits and serves next window; registry invalidation');
const failures=createGalleryAdmission();let fail;
const staleFailure=failures.run(5,()=>new Promise((_r,reject)=>fail=reject));await new Promise(setImmediate);failures.cancel(5);fail(Error('old sender failed'));assert.equal(await staleFailure,null);
await assert.rejects(failures.run(6,async()=>{throw Error('current failure')}),/current failure/);assert.equal(await failures.run(7,async()=>7),7);console.log('PASS exceptions settle permits; stale errors cannot publish; next sender runs');
const bounded=createGalleryAdmission();const ends=[];let started=0;
const blocked=()=>{started++;return new Promise(r=>ends.push(r))};const jobs=[bounded.run(1,blocked),bounded.run(2,blocked)];await new Promise(setImmediate);
for(let i=0;i<16;i++)jobs.push(bounded.run(3,blocked));assert.equal(bounded.pending(),16);assert.equal(await bounded.run(4,blocked),null);assert.equal(started,2);
bounded.cancel(3);assert.equal(bounded.pending(),0);ends.forEach(r=>r());await Promise.all(jobs);assert.equal(started,2);console.log('PASS default shared budget exactly two active and sixteen queued; overflow refused; cancelled queue never starts');
