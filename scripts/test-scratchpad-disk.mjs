// Fault injection against the actual child I/O runtime. Every path is a temporary synthetic talk
// or victim. An injected test launcher adds the fs hook; production drops ambient Node loaders.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createScratchpadStore } from '../src/main/scratchpad-store.ts'
import { createScratchpadDisk } from '../src/main/scratchpad-disk.ts'
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'tw-scratchpad-disk-')))
let checks = 0
let activeHook
const makeStore = (talk) => createScratchpadStore(talk, {}, createScratchpadDisk(talk, (exe,args,options) =>
  spawn(exe,args,{ ...options, env: activeHook ? { ...options.env, NODE_OPTIONS: `--require ${JSON.stringify(activeHook)}` } : options.env })))
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`) }
const folder = (name) => { const p = join(root,name); fs.mkdirSync(p); return p }
const withHook = async (code, fn) => {
  const hook = join(root,`hook-${checks}.cjs`); fs.writeFileSync(hook,code)
  const before = activeHook; activeHook = hook
  try { return await fn() } finally { activeHook = before }
}
try {
  await check('a directory swap at the final state commit cannot touch a victim', async () => {
    const talk=folder('commit-talk'); const scratch=join(talk,'scratchpad'); fs.mkdirSync(scratch)
    const victim=folder('commit-victim'); fs.writeFileSync(join(victim,'scratchpad-state.json'),'victim unchanged')
    const held=join(talk,'held'); const denied=join(talk,'rename-denied.json'); const store=makeStore(talk)
    const hook=`const fs=require('node:fs');const write=fs.writeFileSync;let once=false;fs.writeFileSync=function(p,...args){if(!once && String(p).startsWith('.scratchpad-state.json.')){once=true;try{fs.renameSync(${JSON.stringify(scratch)},${JSON.stringify(held)})}catch(e){write(${JSON.stringify(denied)},JSON.stringify({code:e.code}));throw e}fs.symlinkSync(${JSON.stringify(victim)},${JSON.stringify(scratch)},'dir')}return write.call(this,p,...args)}`
    let refusal
    await withHook(hook,async()=>{ try { await store.createGroup('Held folder') } catch(e) { refusal=e } })
    assert.ok(refusal,'the injected mutation cannot report success')
    assert.equal(fs.readFileSync(join(victim,'scratchpad-state.json'),'utf8'),'victim unchanged')
    assert.deepEqual(fs.readdirSync(victim),['scratchpad-state.json'])
    if(fs.existsSync(denied)) {
      // Windows may protect a process's held cwd by refusing the directory rename itself.
      assert.equal(process.platform,'win32')
      const code=JSON.parse(fs.readFileSync(denied,'utf8')).code
      assert.ok(['EPERM','EACCES','EBUSY'].includes(code),`the OS must have refused the attempted swap: ${code}`)
      assert.ok(fs.lstatSync(scratch).isDirectory())
      assert.equal(fs.existsSync(join(scratch,'scratchpad-state.json')),false)
    } else {
      assert.match(refusal.message,/folder changed/)
      assert.ok(fs.existsSync(join(held,'scratchpad-state.json')),'relative commit stayed in the held directory')
    }
  })
  for (const selected of ['page.html','page.html.json','scratchpad-state.json']) {
    await check(`a link swapped into ${selected} at open is never consumed`,async()=>{
      const talk=folder(`read-${checks}`);const scratch=join(talk,'scratchpad');fs.mkdirSync(scratch)
      fs.writeFileSync(join(scratch,'page.html'),'<p>Safe words</p>')
      fs.writeFileSync(join(scratch,'page.html.json'),'{"title":"Safe title"}')
      fs.writeFileSync(join(scratch,'scratchpad-state.json'),'{"version":1,"groups":[],"items":[]}')
      const victim=join(root,`victim-${checks}.txt`);const secret='PRIVATE VICTIM MUST NEVER APPEAR'
      fs.writeFileSync(victim,secret)
      const target=join(scratch,selected)
      const hook=`const fs=require('node:fs');const open=fs.openSync;let once=false;fs.openSync=function(p,...args){if(!once && p===${JSON.stringify(selected)}){once=true;fs.renameSync(${JSON.stringify(target)},${JSON.stringify(target+'.held')});fs.symlinkSync(${JSON.stringify(victim)},${JSON.stringify(target)})}return open.call(this,p,...args)}`
      const store=makeStore(talk)
      const snap=await withHook(hook,()=>store.load())
      assert.ok(!JSON.stringify(snap).includes(secret),'no victim words in state, sidecar or search')
      assert.equal(fs.readFileSync(victim,'utf8'),secret)
      assert.ok(fs.lstatSync(target).isSymbolicLink(),'the injected race actually happened')
      if(selected==='scratchpad-state.json') {
        assert.deepEqual(snap.groups,[])
        await assert.rejects(store.createGroup('Refused'),/Nothing was changed/)
      } else if(selected==='page.html') assert.equal(snap.items.length,0,'a different inode was refused')
      else assert.equal(snap.items[0].title,'Page','the linked sidecar was not consumed')
    })
  }
  await check('an oversized agent file is refused with a notice and is never rewritten',async()=>{
    const talk=folder('oversized'); const scratch=join(talk,'scratchpad'); fs.mkdirSync(scratch)
    const file=join(scratch,'large.svg'); const fd=fs.openSync(file,'wx')
    try { fs.ftruncateSync(fd,64*1024*1024+1) } finally { fs.closeSync(fd) }
    const before=fs.statSync(file); const snap=await createScratchpadStore(talk).load()
    assert.deepEqual(snap.items,[])
    assert.match(snap.notices[0],/larger than 64 MB/)
    const after=fs.statSync(file)
    assert.deepEqual([after.size,after.mtimeMs],[before.size,before.mtimeMs])
  })
  await check('a failed I/O child must close before the next queued action starts',async()=>{
    const talk=folder('child-drain'); const children=[]
    const disk=createScratchpadDisk(talk,()=>{
      const child=new EventEmitter()
      child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough()
      child.kills=0;child.kill=()=>{child.kills++;return true}
      children.push(child);return child
    })
    const store=createScratchpadStore(talk,{},disk)
    let firstSettled=false
    const first=store.createGroup('Refused').then(()=>{throw new Error('must reject')},e=>{firstSettled=true;return e})
    const next=store.fileFor('unknown')
    await new Promise(setImmediate);assert.equal(children.length,1)
    children[0].emit('error',new Error('controlled I/O failure'))
    await new Promise(setImmediate)
    assert.equal(firstSettled,false,'kill request is not proof that the writer stopped')
    assert.equal(children.length,1,'no next filesystem job can race the live writer')
    children[0].stdout.end();children[0].stderr.end();children[0].emit('close',1)
    assert.ok((await first).message.includes('controlled I/O failure'))
    await new Promise(setImmediate);assert.equal(children.length,2)
    children[1].stdout.end(JSON.stringify({ok:true,value:{folder:null,state:{text:null,error:null},files:[],notices:[]}}))
    children[1].stderr.end();children[1].emit('close',0)
    assert.equal(await next,null)
    assert.equal(children[0].kills,1)
  })
  await check('filesystem identities are read without numeric inode rounding',async()=>{
    const talk=folder('lossless-identity'); const scratch=join(talk,'scratchpad'); fs.mkdirSync(scratch)
    fs.writeFileSync(join(scratch,'page.html'),'<p>Lossless identity</p>')
    const hook=`const fs=require('node:fs');const lstat=fs.lstatSync,stat=fs.statSync,fstat=fs.fstatSync;fs.lstatSync=function(p,options){if((p==='scratchpad'||p==='page.html')&&!options?.bigint)throw new Error('lossless lstat required');return lstat.call(this,p,options)};fs.statSync=function(p,options){if(!options?.bigint)throw new Error('lossless stat required');return stat.call(this,p,options)};fs.fstatSync=function(fd,options){if(!options?.bigint)throw new Error('lossless fstat required');return fstat.call(this,fd,options)}`
    await withHook(hook,async()=>{
      const store=makeStore(talk);const snap=await store.load();assert.equal(snap.items.length,1)
      const file=await store.fileFor(snap.items[0].id);assert.equal(fs.readFileSync(file.path,'utf8'),'<p>Lossless identity</p>')
    })
  })
  await check('production I/O drops ambient Node preloads',async()=>{
    const talk=folder('ambient-env'); const marker=join(root,'ambient-ran.txt'); const hook=join(root,'ambient.cjs')
    fs.writeFileSync(hook,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'should not run')`)
    const previous=process.env.NODE_OPTIONS; process.env.NODE_OPTIONS=`--require ${JSON.stringify(hook)}`
    try { await createScratchpadStore(talk).createGroup('Safe environment') }
    finally { if(previous===undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS=previous }
    assert.equal(fs.existsSync(marker),false,'no inherited preload runs with the app filesystem authority')
  })
  await check('Unicode state crosses child output chunks without corruption',async()=>{
    const talk=folder('unicode'); const store=makeStore(talk)
    const title='Žluťoučký kůň 🐎 '.repeat(2500)
    await store.addSlides([{talkPath:'a.md',talkTitle:'A',slideId:'unicode',title:'Unicode',markdown:`### Unicode\n\n${title}`,thumbKey:'k'}])
    const fresh=(await store.load()).items[0]
    assert.equal(fresh.slide.markdown,`### Unicode\n\n${title}`)
  })
  await check('HTML thumbnail identity survives a new process and private cache directory',async()=>{
    const talk=folder('cache-restart'); const scratch=join(talk,'scratchpad'); fs.mkdirSync(scratch)
    fs.writeFileSync(join(scratch,'page.html'),'<p>Persistent thumbnail</p>')
    const storeModule=pathToFileURL(join(process.cwd(),'src/main/scratchpad-store.ts')).href
    const thumbModule=pathToFileURL(join(process.cwd(),'src/main/scratchpad-html-thumb.ts')).href
    const code=`import {createScratchpadStore} from ${JSON.stringify(storeModule)};import {htmlThumbKey} from ${JSON.stringify(thumbModule)};import {statSync} from 'node:fs';const store=createScratchpadStore(${JSON.stringify(talk)});const snap=await store.load();const file=await store.fileFor(snap.items[0].id);const info=statSync(file.path);console.log(JSON.stringify({path:file.path,key:htmlThumbKey(file.path,info.mtimeMs,info.size)}))`
    const answers=[]
    for(let i=0;i<2;i++) {
      const run=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}})
      assert.equal(run.status,0,run.stderr);answers.push(JSON.parse(run.stdout))
    }
    assert.notEqual(answers[0].path,answers[1].path)
    assert.equal(answers[0].key,answers[1].key,'an immutable content snapshot keeps its thumbnail across launches')
  })
  await check('snapshots are complete and stable across overlapping stores',async()=>{
    const talk=folder('concurrent');const scratch=join(talk,'scratchpad');fs.mkdirSync(scratch)
    const text='<p>'+('complete '.repeat(100000))+'</p>';fs.writeFileSync(join(scratch,'page.html'),text)
    const first=makeStore(talk);const snap=await first.load()
    const others=Array.from({length:4},()=>makeStore(talk))
    const files=await Promise.all(others.map(s=>s.fileFor(snap.items[0].id)))
    for(const file of files) assert.equal(fs.readFileSync(file.path,'utf8'),text)
  })
} finally { fs.rmSync(root,{recursive:true,force:true}) }
console.log(`${checks} Scratchpad disk safety checks passed`)
