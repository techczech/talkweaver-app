import assert from 'node:assert/strict'
import {selectGuardedTalk} from '../../../src/renderer/src/lib/talkSelection.ts'
const A={outlinePath:'A'},B={outlinePath:'B'};let adopted=0,settled=[];
const deps={current:()=>A,leave:async()=>true,claim:async()=>({ok:true}),adopt:()=>adopted++,refused:()=>{},settle:async commit=>{settled.push(commit);return {ok:!commit}}};
assert.equal(await selectGuardedTalk(B,deps),false);assert.equal(adopted,0);assert.deepEqual(settled,[true]);
settled=[];await assert.rejects(selectGuardedTalk(B,{...deps,revalidate:async()=>{throw Error('confirm failed')}}),/confirm failed/);assert.deepEqual(settled,[]);
settled=[];let calls=0;assert.equal(await selectGuardedTalk(B,{...deps,revalidate:async()=>{if(++calls===1)return B;throw Error('confirm failed')}}),false);assert.deepEqual(settled,[false]);
settled=[];await assert.rejects(selectGuardedTalk(B,{...deps,claim:async()=>{throw Error('claim transport failed')}}),/claim transport failed/);assert.deepEqual(settled,[false]);
console.log('PASS settlement refusal prevents adoption; confirmation and claim exceptions abandon explicitly');
