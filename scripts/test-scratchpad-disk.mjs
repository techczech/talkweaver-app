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
import { registerScratchpadIpc } from '../src/main/scratchpad-ipc.ts'
import { createScratchpadStore } from '../src/main/scratchpad-store.ts'
import { createScratchpadDisk } from '../src/main/scratchpad-disk.ts'
import * as snapshotUrls from '../src/main/scratchpad-disk.ts'
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
  await check('Markdown sketches are separate files and stale edits cannot overwrite a newer version', async () => {
    const talk = folder('sketches')
    const outline = join(talk, 'talk-outline.md')
    fs.writeFileSync(outline, '## Existing talk\n')
    const store = makeStore(talk)
    const one = await store.createSketch('## First sketch\r\n- Keep its bytes')
    const two = await store.createSketch('')
    assert.notEqual(one.name, two.name)
    const snapshot = await store.load()
    assert.deepEqual(snapshot.items.map(item => item.fileKind), ['sketch', 'sketch'])
    assert.equal(await store.fileFor(snapshot.items[0].id), null)
    const destination = join(talk, 'scratchpad', one.name)
    const outside = '## An independent edit\r\n'
    fs.writeFileSync(destination, outside)
    await assert.rejects(store.saveSketch(one.name, one.revision, 'Obsolete draft'), /changed on disk/)
    assert.equal(fs.readFileSync(destination, 'utf8'), outside)
    const latest = await store.readSketch(one.name)
    assert.equal(latest.text, outside)
    await store.saveSketch(one.name, latest.revision, '## Kept draft\n')
    assert.equal(fs.readFileSync(destination, 'utf8'), '## Kept draft\n')
    const before = fs.readFileSync(destination)
    const proposal = { talkPath: outline, talkTitle: 'Talk', title: 'Candidate', markdown: '### Candidate\n- A point', slideId: '', thumbKey: '' }
    await store.recordSketchUse(one.name, 'use-1', [], [proposal])
    const used = await store.recordSketchUse(one.name, 'use-1', ['abcde'], [])
    assert.deepEqual(used.items.find(item => item.file === one.name).sketchUses[0].ids, ['abcde'])
    assert.equal(used.items.filter(item => item.kind === 'proposed').length, 1)
    assert.deepEqual(fs.readFileSync(destination), before)
    assert.equal(fs.readFileSync(outline, 'utf8'), '## Existing talk\n')
    await assert.rejects(store.readSketch('../talk-outline.md'), /Choose a Markdown sketch/)
    const link = join(talk, 'scratchpad', 'link.md')
    fs.symlinkSync(outline, link)
    await assert.rejects(store.readSketch('link.md'), /is a link/)
    await assert.rejects(store.saveSketch('link.md', latest.revision, 'Do not write through links'), /is a link/)
    assert.equal(fs.readFileSync(outline, 'utf8'), '## Existing talk\n')
  })
  await check('a warm scan opens only changed files and notices sidecar changes and removals', async () => {
    const talk = folder('incremental-scan')
    const scratch = join(talk, 'scratchpad')
    fs.mkdirSync(scratch)
    fs.writeFileSync(join(scratch, 'draft.md'), '# Original')
    fs.writeFileSync(join(scratch, 'other.md'), '# Unchanged')
    fs.writeFileSync(join(scratch, 'image.png'), 'synthetic media')
    const store = makeStore(talk)
    const before = await store.load()
    const draft = await store.readSketch('draft.md')
    await store.saveSketch(draft.name, draft.revision, '# Revised')
    const reads = join(talk, 'opens.txt')
    const hook = `const fs=require('node:fs');const open=fs.openSync;fs.openSync=function(name,...args){if(name==='other.md'||name==='image.png')fs.appendFileSync(${JSON.stringify(reads)}, name+'\\n');return open.call(this,name,...args)}`
    const after = await withHook(hook, () => store.load())
    assert.equal(after.items.find(item => item.file === draft.name).title, 'Revised')
    assert.deepEqual(after.items.find(item => item.file === 'image.png'), before.items.find(item => item.file === 'image.png'))
    assert.equal(fs.existsSync(reads), false, 'the unchanged sketch and media were never opened')
    fs.writeFileSync(join(scratch, 'image.png.json'), '{"title":"New sidecar"}')
    assert.equal((await store.load()).items.find(item => item.file === 'image.png').title, 'New sidecar')
    fs.unlinkSync(join(scratch, 'other.md'))
    assert.equal((await store.load()).items.find(item => item.file === 'other.md').missing, true)
    fs.renameSync(scratch, join(talk, 'previous-scratchpad'))
    fs.mkdirSync(scratch)
    fs.writeFileSync(join(scratch, 'draft.md'), '# Replaced')
    assert.equal((await store.load()).items.find(item => item.file === 'draft.md').title, 'Replaced')
  })
  await check('a warm scan rebuilds a purged private media snapshot', async () => {
    const talk = folder('purged-snapshot')
    const scratch = join(talk, 'scratchpad')
    fs.mkdirSync(scratch)
    fs.writeFileSync(join(scratch, 'image.png'), 'synthetic media')
    const disk = createScratchpadDisk(talk)
    const [first] = (await disk.scan(['.png'])).files
    const url = snapshotUrls.scratchSnapshotUrl(first.path)
    assert.equal(snapshotUrls.scratchSnapshotFileFor(url), first.path)
    fs.unlinkSync(first.path)
    assert.equal(snapshotUrls.scratchSnapshotFileFor(url), null)

    const [rebuilt] = (await disk.scan(['.png'])).files
    assert.equal(snapshotUrls.scratchSnapshotFileFor(url), rebuilt.path, 'the scan restores the existing thumbnail URL')
    assert.equal(fs.readFileSync(rebuilt.path, 'utf8'), 'synthetic media')
  })
  await check('sketch names and authorship are stored separately from Markdown bytes', async () => {
    const talk = folder('sketch-names')
    const store = makeStore(talk)
    const sketch = await store.createSketch('## A name from the heading\n- A point')
    fs.writeFileSync(join(talk, 'scratchpad', 'outside.md'), '# An outside sketch')
    const before = await store.load()
    assert.deepEqual(before.items.map(item => [item.title, item.sketchOrigin, item.sketchLineCount]).sort(), [
      ['A name from the heading', 'person', 2], ['An outside sketch', undefined, 1],
    ])
    await store.renameSketch(sketch.name, 'A better name')
    const after = (await makeStore(talk).load()).items.find(item => item.file === sketch.name)
    assert.equal(after.title, 'A better name')
    assert.equal(after.sketchOrigin, 'person')
    assert.equal((await store.readSketch(sketch.name)).text, sketch.text)
  })
  await check('use after Undo records fresh slide ids without duplicating the same proposal', async () => {
    const talk = folder('sketch-reapply')
    const store = makeStore(talk)
    const sketch = await store.createSketch('### Candidate')
    const other = await store.createSketch('### Candidate')
    const outline = join(talk, 'talk-outline.md')
    const proposal = { talkPath: outline, talkTitle: 'Talk', title: 'Candidate', markdown: '### Candidate\n{id=one}\n\n- A point', slideId: '', thumbKey: '' }
    await store.recordSketchUse(sketch.name, 'first-apply', ['first-id'], [proposal])
    const item = (await store.load()).items.find(item => item.kind === 'proposed')
    await store.setStatus([item.id], 'kept')
    const retry = { ...proposal, markdown: proposal.markdown.replace('{id=one}', '{id=two}') }
    const reapplied = await store.recordSketchUse(sketch.name, 'second-apply', ['second-id'], [retry])
    assert.deepEqual(reapplied.items.filter(item => item.kind === 'proposed').map(item => [item.id, item.status]), [[item.id, 'kept']])
    assert.deepEqual(reapplied.items.find(item => item.file === sketch.name).sketchUses.at(-1).ids, ['second-id'])
    const different = await store.recordSketchUse(sketch.name, 'different-cut', [], [{ ...retry, markdown: retry.markdown + '\n- More detail' }])
    assert.equal(different.items.filter(item => item.kind === 'proposed').length, 2)
    const separate = await store.recordSketchUse(other.name, 'another-sketch', [], [retry])
    assert.equal(separate.items.filter(item => item.kind === 'proposed').length, 3)
  })
  await check('a large typed sketch can be saved and read back through IPC', async () => {
    const talk = folder('large-sketch')
    const outline = join(talk, 'talk-outline.md')
    const handlers = new Map()
    registerScratchpadIpc({ ipc: { handle: (channel, fn) => handlers.set(channel, fn) },
      outlinePathFor: () => outline, revealFolder: () => {}, htmlPreview: async () => ({ error: 'unused' }) })
    const created = await handlers.get('scratchpad:sketch-create')({}, outline, 'A starting point')
    assert.equal(created.ok, true)
    const text = 'Oversized relative to the old cap. é\n'.repeat(16_000)
    assert.ok(Buffer.byteLength(text) > 400_000)
    const reply = await handlers.get('scratchpad:sketch-save')({}, outline, created.sketch.name, created.sketch.revision, text)
    assert.equal(reply.ok, true, reply.error)
    assert.equal(fs.readFileSync(join(talk, 'scratchpad', created.sketch.name), 'utf8'), text)
  })
  await check('sketch pictures resolve inside the active vault and keep missing files unplaced', async () => {
    const talk = folder('sketch-pictures')
    const outline = join(talk, 'talk-outline.md')
    fs.mkdirSync(join(talk, 'assets'))
    fs.writeFileSync(join(talk, 'assets', 'garden-beds.jpg'), 'synthetic JPG fixture')
    const handlers = new Map()
    registerScratchpadIpc({ ipc: { handle: (channel, fn) => handlers.set(channel, fn) }, outlinePathFor: () => outline,
      sketchVaultRoot: () => talk, revealFolder: () => {}, htmlPreview: async () => ({ error: 'unused' }) })
    const pictures = handlers.get('scratchpad:sketch-pictures')
    assert.deepEqual(await pictures({}, outline, ['[picture: garden-beds.jpg]', '[picture: missing.jpg]']), {
      ok: true, pictures: [['[picture: garden-beds.jpg]', 'assets/garden-beds.jpg']],
    })
    assert.equal((await pictures({}, join(root, 'other-outline.md'), ['[picture: garden-beds.jpg]'])).ok, false)
  })
  await check('sketch export writes only the chosen unused destination', async () => {
    const talk = folder('sketch-export')
    let destination
    const handlers = new Map()
    registerScratchpadIpc({ ipc: { handle: (channel, fn) => handlers.set(channel, fn) },
      outlinePathFor: () => null, revealFolder: () => {}, htmlPreview: async () => ({ error: 'unused' }),
      chooseSketchCopy: async () => destination })
    const exportSketch = text => handlers.get('scratchpad:sketch-export')({}, text)
    assert.deepEqual(await exportSketch('Cancelled'), { ok: true, saved: false })
    destination = join(talk, 'recovered.md')
    const original = 'Preserved é\r\n'.repeat(390_000)
    assert.deepEqual(await exportSketch(original), { ok: true, saved: true })
    assert.equal((await exportSketch('Never overwrite')).ok, false)
    assert.equal(fs.readFileSync(destination, 'utf8'), original)
  })
  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
    await check(`a sketch can be created exclusively when hard links fail with ${code}`, async () => {
      const talk = folder('sketch-no-link-' + code)
      const script = `const fs=require('node:fs'); fs.linkSync=()=>{ throw Object.assign(new Error('hard links unavailable'), { code: '${code}' }) }`
      const store = makeStore(talk)
      const sketch = await withHook(script, () => store.createSketch('## No hard links here'))
      assert.equal((await store.readSketch(sketch.name)).text, '## No hard links here')
      assert.deepEqual(fs.readdirSync(join(talk, 'scratchpad')), [sketch.name])
      const collision = script.replace('fs.linkSync=()=>', "fs.linkSync=(_temp,name)=>").replace("throw Object.assign", "fs.writeFileSync(name, 'A different sketch'); throw Object.assign")
      await assert.rejects(withHook(collision, () => store.createSketch('Never replace another sketch')), /EEXIST/)
      assert.deepEqual(fs.readdirSync(join(talk, 'scratchpad')).map(name => fs.readFileSync(join(talk, 'scratchpad', name), 'utf8')).sort(),
        ['## No hard links here', 'A different sketch'])
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
    children[1].stdout.end(JSON.stringify({ok:true,value:{folder:null,state:{text:null,error:null},entries:[],notices:[]}}))
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
    fs.writeFileSync(join(scratch,'picture.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>')
    const loaded=await first.load();const picture=loaded.items.find(item=>item.file==='picture.svg')
    const image=await first.fileFor(picture.id)
    assert.equal(typeof snapshotUrls.scratchSnapshotUrl,'function','private images use compact URLs, not eager base64')
    const address=snapshotUrls.scratchSnapshotUrl(image.path)
    assert.ok(address.startsWith('twthumb://scratch/'));assert.ok(address.length<256)
    assert.equal(snapshotUrls.scratchSnapshotFileFor(address),image.path)
    const hardLink = join(talk, 'linked-snapshot.svg')
    fs.linkSync(image.path, hardLink)
    try {
      assert.equal(fs.statSync(image.path).nlink, 2)
      assert.equal(snapshotUrls.scratchSnapshotDirectory(image.path), null, 'an importer refuses a hard-linked snapshot')
      assert.equal(snapshotUrls.scratchSnapshotFileFor(address), null, 'the thumbnail protocol refuses it too')
    } finally { fs.unlinkSync(hardLink) }
    assert.equal(snapshotUrls.scratchSnapshotUrl(files[0].path),undefined,'HTML cannot enter the image protocol')
    for(const invalid of [address+'?x=1',address+'#x',address.replace('/scratch/','/other/'),'twthumb://scratch/../picture.svg',address.replace('picture.svg','picture.html')])
      assert.equal(snapshotUrls.scratchSnapshotFileFor(invalid),null,invalid)
    assert.equal(snapshotUrls.scratchSnapshotUrl(join(scratch,'picture.svg')),undefined,'agent-writable source is never served')
    fs.renameSync(image.path,image.path+'.held')
    try {
      fs.symlinkSync(join(scratch,'picture.svg'),image.path)
      assert.equal(snapshotUrls.scratchSnapshotFileFor(address),null,'a linked private image is refused')
    } finally { fs.rmSync(image.path,{force:true});fs.renameSync(image.path+'.held',image.path) }


  })
} finally { fs.rmSync(root,{recursive:true,force:true}) }
console.log(`${checks} Scratchpad disk safety checks passed`)
