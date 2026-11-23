import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLibraryFiles } from '../src/main/publishing-library-sync.ts'
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}).trim()
function fixture(t, { editSource = false } = {}) {
  const root=mkdtempSync(join(tmpdir(),'tw-library-recovery-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const origin=join(root,'origin'),author=join(root,'author'),client=join(root,'client')
  mkdirSync(origin);git(origin,'init','--bare','--initial-branch=main')
  git(root,'clone',origin,author)
  git(author,'config','user.name','Synthetic fixture');git(author,'config','user.email','fixture@example.invalid')
  writeFileSync(join(author,'source.md'),'Original\n');git(author,'add','source.md');git(author,'commit','-m','Initial synthetic source');git(author,'push','origin','main')
  git(root,'clone',origin,client)
  git(client,'config','user.name','Synthetic fixture');git(client,'config','user.email','fixture@example.invalid')
  writeFileSync(join(author,'widget.html'),'<p>Arriving widget</p>')
  if (editSource) writeFileSync(join(author,'source.md'),'Remote revised source\n')
  git(author,'add','widget.html','source.md');git(author,'commit','-m','Add synthetic widget');git(author,'push','origin','main')
  return {client}
}
test('explicit recovery fetches an upstream widget through a real fast-forward',async t=>{
  const {client}=fixture(t)
  assert.equal(existsSync(join(client,'widget.html')),false)
  assert.deepEqual(await getLibraryFiles(client),{ok:true})
  assert.equal(readFileSync(join(client,'widget.html'),'utf8'),'<p>Arriving widget</p>')
})
test('recovery fetches a disjoint missing widget while keeping local edits',async t=>{
  const {client}=fixture(t)
  writeFileSync(join(client,'source.md'),'Local edits that must survive\n')
  const before=git(client,'rev-parse','HEAD')
  assert.equal((await getLibraryFiles(client)).ok,true)
  assert.equal(readFileSync(join(client,'source.md'),'utf8'),'Local edits that must survive\n')
  assert.notEqual(git(client,'rev-parse','HEAD'),before)
  assert.equal(readFileSync(join(client,'widget.html'),'utf8'),'<p>Arriving widget</p>')
})
test('recovery refuses overlapping remote edits and keeps the local source and head',async t=>{
  const {client}=fixture(t,{editSource:true})
  git(client,'config','merge.autoStash','true');git(client,'config','rebase.autoStash','true')
  writeFileSync(join(client,'source.md'),'Local overlapping source that must survive\n')
  const before=git(client,'rev-parse','HEAD')
  assert.equal((await getLibraryFiles(client)).ok,false)
  assert.equal(git(client,'rev-parse','HEAD'),before)
  assert.equal(readFileSync(join(client,'source.md'),'utf8'),'Local overlapping source that must survive\n')
  assert.equal(existsSync(join(client,'widget.html')),false)
})
test('recovery refuses an untracked widget collision without overwriting it',async t=>{
  const {client}=fixture(t)
  writeFileSync(join(client,'widget.html'),'<p>Untracked local widget</p>')
  const before=git(client,'rev-parse','HEAD')
  assert.equal((await getLibraryFiles(client)).ok,false)
  assert.equal(git(client,'rev-parse','HEAD'),before)
  assert.equal(readFileSync(join(client,'widget.html'),'utf8'),'<p>Untracked local widget</p>')
})
test('recovery keeps a diverged local commit without creating a merge',async t=>{
  const {client}=fixture(t)
  writeFileSync(join(client,'local.md'),'Local committed work\n');git(client,'add','local.md');git(client,'commit','-m','Keep synthetic local work')
  const before=git(client,'rev-parse','HEAD')
  assert.equal((await getLibraryFiles(client)).ok,false)
  assert.equal(git(client,'rev-parse','HEAD'),before)
  assert.equal(readFileSync(join(client,'local.md'),'utf8'),'Local committed work\n')
  assert.equal(existsSync(join(client,'.git/MERGE_HEAD')),false)
})

test('recovery keeps a local widget ignored by Git when upstream adds the same path', async t => {
  const { client } = fixture(t)
  writeFileSync(join(client, '.git/info/exclude'), 'widget.html\n')
  const widget = join(client, 'widget.html')
  writeFileSync(widget, '<p>Ignored local widget</p>')
  const before = git(client, 'rev-parse', 'HEAD')
  assert.equal((await getLibraryFiles(client)).ok, false)
  assert.equal(git(client, 'rev-parse', 'HEAD'), before)
  assert.equal(readFileSync(widget, 'utf8'), '<p>Ignored local widget</p>')
})
