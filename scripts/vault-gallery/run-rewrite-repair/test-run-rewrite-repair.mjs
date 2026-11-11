import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join, resolve } from 'node:path'
import { createPlannedRun, readRunForTalk, persistRunForTalk } from '../../../src/main/runs.ts'
import { pinRunWork } from '../../../src/main/run-work-pin.ts'
import { runPublicationFixture } from '../../../scripts/lib/run-publication-fixture.mjs'
const home = fs.mkdtempSync(join(import.meta.dirname, 'fixture-'))
const source = fs.readFileSync('src/main/index.ts', 'utf8')
let count = 0
try {
for (const qualified of [false, true]) for (const mode of ['own', 'before-pin', 'at-write', 'after-pre', 'source', 'closed', 'tuple']) {
  const root = join(home, String(count++)); fs.mkdirSync(join(root, 'Work files'), {recursive:true})
  fs.mkdirSync(join(root, 'talk')); const outline = join(root, 'talk/talk-outline.md'); fs.writeFileSync(outline, '# Talk')
  fs.writeFileSync(join(root, 'Work files/intake.md'), '---\nid: intake\ntitle: Intake\nrevision: 1\n---\n### Answer\n{id=answer}{poll=open}\n')
  createPlannedRun(root, {talkSlug:'talk', talkTitle:'Talk', plannedDate:'2099-01-01', startTime:'10:00', timeZone:'Europe/London', eventTitle:'Event', audience:'', slideSet:{kind:'full'}, work:{pre:{fileId:'intake',opens:'2098-12-01T09:00'},post:{fileId:'intake',closes:'2099-01-10T18:00'}}}, ()=>'r')
  if (qualified) persistRunForTalk(root, 'talk', 'r', {...readRunForTalk(root,'talk','r'), sourceOutline:'talk/talk-outline.md'})
  let open = true
  const {runPublicationAuthority} = runPublicationFixture(source, resolve('.'), ()=>[{id:'v',root,open}], ()=>[{slug:'talk',outlinePath:outline}])
  const authority = runPublicationAuthority(root, readRunForTalk(root,'talk','r'))
  const file = join(root,'_PRESENTATIONS/talk/r.json')
  const replace = path => {fs.renameSync(path,path+'.old');fs.copyFileSync(path+'.old',path);assert.notEqual(fs.statSync(path).ino,fs.statSync(path+'.old').ino)}
  if (mode==='before-pin') replace(file)
  if (mode==='source') replace(outline)
  if (mode==='closed') open=false
  const before = fs.readFileSync(file)
  if (mode==='tuple') {
    assert.throws(()=>persistRunForTalk(root,'talk','r',{...readRunForTalk(root,'talk','r'),sourceOutline:'different.md'},authority.replace))
    assert.deepEqual(fs.readFileSync(file),before)
  } else if (['before-pin','at-write','closed'].includes(mode) || (qualified && mode==='source')) {
    const guard = mode==='at-write' ? (...args)=>{replace(file);return authority.replace(...args)} : authority.replace
    assert.throws(()=>pinRunWork(root,'talk','r','pre',undefined,guard))
    assert.deepEqual(fs.readFileSync(file),before)
    assert.equal(readRunForTalk(root,'talk','r').work.pre.pinned,undefined)
  } else {
    const first = fs.statSync(file).ino
    pinRunWork(root,'talk','r','pre',undefined,authority.replace); authority()
    const second = fs.statSync(file).ino; assert.notEqual(first,second)
    if (mode==='after-pre') {
      replace(file); const bytes=fs.readFileSync(file)
      assert.throws(()=>pinRunWork(root,'talk','r','post',undefined,authority.replace))
      assert.deepEqual(fs.readFileSync(file),bytes)
      assert.throws(authority)
    } else {
      pinRunWork(root,'talk','r','post',undefined,authority.replace); authority()
      assert.notEqual(fs.statSync(file).ino,second)
      const saved=readRunForTalk(root,'talk','r');assert.ok(saved.work.pre.pinned && saved.work.post.pinned)
      const unchanged=fs.statSync(file).ino
      pinRunWork(root,'talk','r','pre',undefined,authority.replace);authority();assert.equal(fs.statSync(file).ino,unchanged)
      replace(file);assert.throws(authority)
    }
  }
  assert.equal(fs.readdirSync(join(root,'_PRESENTATIONS/talk')).some(name=>name.endsWith('.tmp')),false)
  console.log('PASS',qualified?'qualified':'legacy',mode)
}
console.log(`PASS ${count} real writer/authority cases`)
} finally { fs.rmSync(home,{recursive:true,force:true}) }
