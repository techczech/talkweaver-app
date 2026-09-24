import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { objectBlocksExtension, objectBlocksIn, setRawObjectBlock, setOpenObjectBlock } from '../src/renderer/src/extensions/objectBlocks/field.ts'
const source=Array.from({length:500},(_,i)=>`### Slide ${i}\n\nBody ${i}\n\n| A | B |\n| --- | --- |\n| one | two |\n\n`).join('')
let state=EditorState.create({doc:source,extensions:[objectBlocksExtension({})]})
const blocks=objectBlocksIn(state)
assert.equal(blocks.length,500)
for(let i=0;i<100;i++) state=state.update({selection:{anchor:i%10}}).state
assert.ok(objectBlocksIn(state)===blocks,'cursor movement reuses parsed blocks without rescanning the document')
state=state.update({effects:[setRawObjectBlock.of({from:blocks[0].from,raw:true}),setOpenObjectBlock.of(blocks[1])]}).state
assert.ok(objectBlocksIn(state)===blocks,'opening/raw effects do not rescan source')
const transaction=state.update({changes:{from:10,insert:'x'}})
const doc=transaction.newDoc,original=doc.toString.bind(doc)
let scans=0
doc.toString=()=>{scans++;return original()}
state=transaction.state
assert.equal(scans,1,'one changed document scan is shared by raw, open and decoration fields')
assert.equal(objectBlocksIn(state).length,500)
assert.ok(objectBlocksIn(state)!==blocks,'edits invalidate detection')
assert.equal(objectBlocksIn(state)[0].from,blocks[0].from+1,'object offsets follow source edits')
console.log('PASS object detection work budget: zero scans for cursor/effects, one for edits')
