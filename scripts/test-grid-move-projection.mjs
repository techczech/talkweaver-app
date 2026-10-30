import assert from 'node:assert/strict'
import { projectGridMove } from '../src/shared/slide-handling/grid-move-projection.ts'
import { slideKeys } from '../src/renderer/src/lib/useSlideSelection.ts'
import { moveBlocks } from '../src/shared/slide-handling/blocks.ts'
const source='---\ntitle: Test\n---\n\n## Same\n{id=a}\n\n### Twin\n{id=x}\n\nIdentical.\n\n### Twin\n{id=y}\n\nIdentical.\n\n## Same\n{id=b}\n\n### Last\n{id=z}\n\nEnd.\n'
const lines=source.split('\n')
const row=(id,role,section)=>({slide_id:id,source_line:lines.findIndex(l=>l===`{id=${id}}`),role,section,render_hash:id,thumbnail_hash:id})
const rows=[{slide_id:'cover',role:'title',source_line:null},row('a','section-title','A'),row('x','content','A'),row('y','content','A'),row('b','section-title','B'),row('z','content','B'),{slide_id:'closing',role:'closing',source_line:null}]
const ref=id=>({line:row(id).source_line,headingText:lines[row(id).source_line-1]})
const moved=moveBlocks(source,[ref('x')],{kind:'after',line:ref('z').line,title:'Last'})
assert.ok(!('refused' in moved))
const projected=projectGridMove(rows,source,moved.text)
assert.deepEqual(projected.map(r=>r.slide_id),['cover','a','y','b','z','x','closing'])
assert.equal(projected[5].section,'B')
assert.equal(projected[5].render_hash,'x','same slide retains its own current artwork while compiling')
assert.equal(projected[2].source_line,moved.text.split('\n').indexOf('### Twin')+1)
assert.deepEqual(projectGridMove(projected,moved.text,source),rows,'Undo derives the original rows and current source addresses')
assert.equal(projectGridMove(rows,source,source.replace('Identical.','Changed.')),null,'an edit cannot reorder stale artwork')
assert.equal(projectGridMove(rows,source,source+'\n### Added\n'),null,'inserts are left to the compiler')
assert.equal(projectGridMove(rows,source,source.replace('title: Test','title: Different')),null,'changed document context is left to compiler')
assert.equal(projectGridMove([{...rows[0],source_line:999},...rows.slice(1)],source,moved.text),null,'unmapped rows fail closed')
const twins='### Same\n\nBody\n\n### Same\n\nBody\n'
assert.equal(projectGridMove([{source_line:1},{source_line:5}],twins,twins.replace('Body', 'Different')),null)
assert.equal(projectGridMove(rows.filter(r=>r.slide_id!=='x'),source,moved.text),null,'folded/unprojected children require the compiler')
assert.equal(projectGridMove(rows.map(r=>({...r,subsection:'Nested'})),source,moved.text),null,'nested context stays with the compiler')
assert.deepEqual(projectGridMove(rows.map((r,order)=>({...r,order})),source,moved.text).map(r=>r.order),rows.map((_,i)=>i),'projection order metadata stays current')
const keys=slideKeys([{slide_id:'a'},{slide_id:'b'},{slide_id:'a'},{content_hash:'same'},{content_hash:'same'}],()=>true)
assert.equal(new Set(keys).size,keys.length,'duplicate ids and identical content still receive unique React keys')
const reversed=slideKeys([rows[5],rows[2],rows[3]],()=>true)
assert.deepEqual(reversed,['id:z','id:x','id:y'],'stamped identity does not depend on title, content or position')
for(const [ids,place] of [[['x','y'],{kind:'after',line:ref('z').line,title:'Last'}],[['b'],{kind:'before',line:ref('a').line,title:'Same'}],[['z'],{kind:'start'}]]) {
  const r=moveBlocks(source,ids.map(ref),place)
  assert.ok(!('refused' in r))
  const order=projectGridMove(rows,source,r.text)
  if (ids.length === 2 || ids[0] === 'z') { assert.equal(order,null,'removing the last children requires compiler role reassessment'); continue }
  assert.ok(order)
  assert.deepEqual(projectGridMove(order,r.text,source),rows,'section, batch and endpoint moves reverse exactly')
}
console.log('PASS exact source permutation, twins, sections, generated ends, Undo and stale-content refusal')

// Differential contract: every accepted projection must have the real compiler's grouping.
const { prepareSource } = await import('../compiler/scripts/lib/08-source-adapters.mjs')
const { buildPerSlideProjections } = await import('../compiler/scripts/lib/10-projections.mjs')
const { mkdtempSync, writeFileSync, statSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const fixtureDir = mkdtempSync(join(tmpdir(), 'tw-grid-projection-diff-'))
try {
  const compile = async text => {
    const path = join(fixtureDir, 'outline.md')
    writeFileSync(path, text)
    return buildPerSlideProjections(await prepareSource(path, text, 'probe', statSync(path), {}, {}), 'probe')
  }
  const header = '---\ntitle: Projection comparison\n---\n\n'
  const fixture = blocks => header + blocks.map(([level,id,title]) => '#'.repeat(level)+' '+title+'\n{id='+id+'}\n\nBody '+id+'\n\n').join('')
  const flat = fixture([[2,'o','One'],[2,'t','Two'],[2,'h','Three']])
  const leaf = fixture([[2,'i','Intro'],[2,'a','Alpha'],[3,'a1','One'],[3,'a2','Two']])
  const sections = fixture([[2,'a','Alpha'],[3,'a1','One'],[2,'b','Beta'],[3,'b1','Two'],[3,'b2','Three']])
  const fields = rows => rows.map(({slide_id,role,section,source_line,order}) => ({slide_id,role,section,source_line,order}))
  for (const [label,src,id,target,kind,accepted] of [
    ['flat h2',flat,'o','h','after',false],
    ['leaf h2 to end',leaf,'i','a2','after',false],
    ['child under leaf',leaf,'a1','i','after',false],
    ['sole child out',sections,'a1','b2','after',false],
    ['section swap',sections,'b','a','before',true]
  ]) {
    const lines = src.split('\n')
    const ref = id => { const line = lines.indexOf('{id='+id+'}'); return {line,headingText:lines[line-1]} }
    const result = moveBlocks(src,[ref(id)],{kind,line:ref(target).line,title:ref(target).headingText.replace(/^#+\s*/, '')})
    assert.ok(!('refused' in result),label)
    const actual = projectGridMove(await compile(src),src,result.text)
    if (accepted) assert.ok(actual,label+' keeps the instant path')
    else assert.equal(actual,null,label+' safely waits for compiler context')
    if(actual) assert.deepEqual(fields(actual),fields(await compile(result.text)),label+' equals real compiler')
  }
} finally { rmSync(fixtureDir,{recursive:true,force:true}) }
console.log('PASS real-compiler differential grouping and role-change fallbacks')
