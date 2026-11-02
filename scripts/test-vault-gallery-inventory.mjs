import assert from 'node:assert/strict'
import { scanInventory } from '../src/main/vault-gallery-inventory.ts'
const calls=[]
const nodes={ '':{kind:'folder'}, 'empty':{kind:'folder'}, 'research':{kind:'research'}, 'research/a':{kind:'file',logical:19,allocated:512}, '_assets':{kind:'assets'}, '_assets/image':{kind:'file',logical:90,allocated:null,reason:'unsupported'}, 'link':{kind:'link'}, 'alias':{kind:'alias'}, 'bad':{kind:'folder'} }
const fs={identity:async()=> 'root:1', metadata:async p=>{calls.push(p);return nodes[p]}, children:async p=>{if(p==='bad')throw Error('unreadable');return Object.keys(nodes).filter(k=>k && k.split('/').slice(0,-1).join('/')===p)},close:async()=>{}}
const results=[]
await scanInventory({vaultId:'v',relativePath:'',generation:1,recursive:true,confirmedRoot:true},fs,()=>true,r=>results.push(structuredClone(r)))
const r=results.at(-1)
assert.equal(r.state,'partial');assert.equal(r.logicalBytes,109);assert.equal(r.allocatedBytes,null);assert.equal(r.unreadable,1)
assert.equal(r.entries.find(e=>e.relativePath==='empty').kind,'folder')
assert.equal(calls.includes('link/target'),false);assert.equal(calls.includes('alias/target'),false)
assert.equal(r.entries.filter(e=>e.relativePath==='_assets/image').length,1)
let active=true
await scanInventory({vaultId:'v',relativePath:'',generation:2,recursive:true,confirmedRoot:true},{...fs,metadata:async p=>{active=false;return nodes[p]}},()=>active,r=>results.push(r))
assert.equal(results.at(-1).state,'cancelled')
console.log('PASS distinct allocation, unknown allocation, empty directory, research/assets, unreadable coverage, link exclusions and cancellation')
let identity='old',operations=0,closed=0
await scanInventory({vaultId:'v',relativePath:'folder',generation:3,recursive:true,confirmedRoot:false},{identity:async()=>identity,metadata:async()=>{identity='new';operations++;return {kind:'folder'}},children:async()=>{throw Error('stale traversal')},close:async()=>{closed++}},()=>true,r=>results.push(r))
assert.equal(results.at(-1).state,'stale');assert.equal(operations,1);assert.equal(closed,1)
let visits=0
await scanInventory({vaultId:'v',relativePath:'',generation:4,recursive:true,confirmedRoot:true},{identity:async()=> 'fixed',metadata:async p=>{visits++;return p?{kind:'file',logical:1,allocated:512}:{kind:'folder'}},async *children(){for(let i=0;i<30000;i++)yield String(i)},close:async()=>{}},()=>true,r=>results.push(r))
assert.equal(results.at(-1).truncated,true);assert.equal(results.at(-1).state,'partial');assert.ok(visits<=20000);assert.ok(results.at(-1).entries.length<=2000)
console.log('PASS stale identity stops traversal, resource close, 20000 work bound, 2000 retention bound, explicit truncation')
const {inventoryTalkSize}=await import('../src/shared/vault-gallery-storage.ts')
const measured={...results.at(-1),recursive:true,state:'complete',truncated:false,relativePath:'',entries:[{relativePath:'talk',kind:'folder',logical:null,allocated:null},{relativePath:'talk/file',kind:'file',logical:13,allocated:512},{relativePath:'_assets/image',kind:'file',logical:99,allocated:4096}]}
assert.deepEqual(inventoryTalkSize(measured,'talk'),{logical:13,allocated:512,allocatedAtLeast:512,partial:false})
assert.equal(inventoryTalkSize({...measured,recursive:false},'talk'),null)
assert.equal(inventoryTalkSize(measured,'missing'),null)
assert.equal(inventoryTalkSize({...measured,truncated:true},'talk').allocated,null)
assert.equal(inventoryTalkSize({...measured,truncated:true},'talk').allocatedAtLeast,512)
console.log('PASS talk size joins only physical subtree, shared pool excluded, unmeasured/missing unknown and truncated allocation unknown')
