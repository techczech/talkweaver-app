import assert from 'node:assert/strict'
import {selectGuardedTalk} from '../../../src/renderer/src/lib/talkSelection.ts'
let claims=0,adopted=0;
const deps={current:()=>({outlinePath:'A'}),leave:async()=>true,claim:async()=>{claims++;return {ok:true}},adopt:()=>adopted++,refused(){},isCurrent:()=>claims===0,settle:async()=>({ok:false})};
await assert.rejects(selectGuardedTalk({outlinePath:'B'},deps),/could not be restored/);assert.equal(adopted,0);assert.equal(claims,1);
await assert.rejects(selectGuardedTalk({outlinePath:'B'},{...deps,isCurrent:()=>true,claim:async()=>{throw Error('claim failure')},settle:async()=>{throw Error('rollback failure')}}),/rollback failure/);assert.equal(adopted,0);console.log('PASS refused and thrown recovery are explicit; no adoption or fallback claim');
