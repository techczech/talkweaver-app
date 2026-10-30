import { configureTalkWriter } from '../src/main/talk-writer.ts'
import assert from 'node:assert/strict'
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, renameSync, rmSync, chmodSync, linkSync, statSync } from 'node:fs'
import { AGENT_VERBS, COMMAND_VERBS, researchWriteHandler, RESEARCH_WRITE_VERBS } from '../src/main/agent-verbs.ts'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
const writer = await import('../src/main/research-writer.ts').catch(()=>({}))
assert.equal(typeof writer.writeResearch, 'function', 'one research write seam exists')
const { writeResearch } = writer
const { researchPaths, replaceResearchLinks } = await import('../src/shared/research-links.ts')
const root=realpathSync(mkdtempSync(join(tmpdir(),'tw-write-'))),vault=join(root,'vault'),talk=join(vault,'talk'),other=join(vault,'other'),bin=join(root,'bin')
for(const d of [join(talk,'research'),join(other,'research'),bin])mkdirSync(d,{recursive:true})
const outline=join(talk,'talk-outline.md'), file=join(talk,'research/item.md')
const stub=()=> '---\ntitle: Counts [all]\nkind: table\ncreated: 2026-10-20T12:00:00Z\nby: agent\nprompt: Count things\nsources: ["url:https://example.org"]\n---\n![Chart](chart.png)\n'
writeFileSync(file,stub());writeFileSync(join(talk,'research/chart.png'),'image')
let live='# Talk\n\n## First\n\n[Research: Counts \\[all\\]](research/item.md)\n\n## Second\n\n[Research](research/item.md)\nUnsaved edit\n'
writeFileSync(outline,'# Older disk version\n');writeFileSync(join(other,'other-outline.md'),'# Other')
const trash=[],writes=[]
const fake=join(bin,'scout')
writeFileSync(fake,`#!/usr/bin/env node\nconst fs=require('fs'),p=require('path');const a=process.argv.slice(2),get=k=>a.find(x=>x.startsWith('--'+k+'='))?.split('=').slice(1).join('=');if(process.env.FAIL)process.exit(2);let body='';process.stdin.on('data',b=>body+=b);process.stdin.on('end',()=>{let dir=p.join(get('project'),'research'),n=1,file;do{file=p.join(dir,'copy-'+n+++'.md')}while(fs.existsSync(file));fs.writeFileSync(file,'---\\ntitle: '+JSON.stringify(get('title'))+'\\nkind: '+get('kind')+'\\ncreated: 2026-10-20T12:00:00Z\\nby: app:talkweaver\\nprompt: '+JSON.stringify(get('prompt')||'')+'\\nsources: '+JSON.stringify(a.filter(x=>x.startsWith('--source=')).map(x=>x.slice(9)))+'\\n---\\n'+body,{flag:'wx'});if(process.env.OVERSIZE_CAPTURE)fs.appendFileSync(file,'x'.repeat(256*1024));console.log(JSON.stringify({file,corpus:null,indexed:true}))})`);chmodSync(fake,0o755)
const deps={vaultRoot:vault,vaultRoots:[vault],env:{PATH:bin+':'+process.env.PATH},home:root,log:()=>{},activeTalkDir:()=>talk,trash:async p=>{trash.push(p);renameSync(p,join(root,'trash-'+trash.length))}}
configureTalkWriter({editorBufferFor:p=>p===outline?{read:async()=>live,commit:async(base,next,origin)=>{assert.equal(base,live);assert.equal(origin,'research-rename');writes.push([live,next]);live=next;return {ok:true,text:next}}}:null})
const run=(op,extra={},d=deps)=>writeResearch({op,file,...extra},d)
try{
  for (const form of ['[x](research/x.md "title")', '[x](<research/my x.md>)', '<research/my x.md>', '[x](research/x.md#part)', '[ref]: research/x.md', '<img src="research/x.md">', '<iframe src=research/x.md?view=1>']) {
    const expected = form.includes('my x') ? 'research/my x.md' : 'research/x.md'
    assert.deepEqual(researchPaths(form), [expected], 'recognises target: '+form)
    assert.ok(replaceResearchLinks(form, p=>p===expected?'research/new.md':p).includes('research/new.md'), 'rewrites target: '+form)
  }
  assert.equal(replaceResearchLinks('[x](research/x.md?view=1#part "title")', ()=> 'research/new.md'), '[x](research/new.md?view=1#part "title")')
  const malicious=join(talk,'research/malicious.md')
  writeFileSync(malicious,stub().replace('2026-10-20T12:00:00Z','../../2026').replace('![Chart](chart.png)','Text'))
  const escapePreview=await writeResearch({op:'rename',file:malicious,title:'Escaped',renameSlug:true,preview:true},deps)
  const escapeResult=await writeResearch({op:'rename',file:malicious,title:'Escaped',renameSlug:true,confirmation:escapePreview.confirmation},deps)
  assert.equal(escapeResult.ok,true,JSON.stringify(escapeResult))
  assert.equal(escapeResult.file,join(talk,'research/2026-01-01-escaped.md'),'date metadata cannot traverse directories')
  assert.ok(!existsSync(join(vault,'2026-escaped.md')))
  rmSync(escapeResult.file)
  assert.ok(trash.every(p=>!basename(p).startsWith('.')), 'deleted research is visible in Trash')
  const hardOutline=join(other,'hard-outline.md');linkSync(outline,hardOutline)
  const unchecked=await run('delete',{preview:true})
  assert.equal(unchecked.ok,true,JSON.stringify(unchecked))
  assert.ok(unchecked.uncheckedOutlines.includes(hardOutline),'linked outline is reported instead of blocking deletion')
  assert.equal((await run('delete')).ok,false,'unchecked outlines need confirmation')
  rmSync(hardOutline)
  const inode=statSync(file).ino
  assert.equal((await run('kind',{kind:'snippet'})).ok,true)
  assert.notEqual(statSync(file).ino,inode,'metadata update atomically replaces the file')
  writeFileSync(file,stub())
  const externalOutline=join(other,'other-outline.md')
  writeFileSync(externalOutline,'# Other\n\n## External\n[x](../talk/research/item.md#part "title")\n')
  for (const op of ['move','rename']) {
    const preview=await run(op,{title:'New',renameSlug:true,destination:other,preview:true})
    assert.equal(preview.uses.filter(u=>u.file===externalOutline).length,1,op+' checks other talks')
  }
  writeFileSync(externalOutline,'# Other')
  for(const op of ['rename','kind','delete','move','copy']){
    assert.equal((await run(op,{file:join(root,'outside.md'),title:'New',kind:'snippet',destination:other})).ok,false,op+' refuses outside source')
    assert.equal((await run(op,{file:file+'\0',title:'New',kind:'snippet',destination:other})).ok,false)
  }
  for (const op of ['rename','kind','delete','move','copy','insertHere']) {
    assert.ok(AGENT_VERBS.some(v=>v.id==='research.'+op))
    const v=RESEARCH_WRITE_VERBS.find(v=>v.id==='research.'+op), original=v.run
    v.run=async()=>({ok:false,error:{code:'shared',message:op}})
    assert.equal((await researchWriteHandler(op,{},deps)).error.message,op,'IPC reaches registered verb')
    v.run=original
  }
  for(const id of ['rename','change-kind','delete','move','copy','insert-here'])assert.ok(COMMAND_VERBS['research-'+id])
  const wrongActive={...deps,activeTalkDir:()=>other}
  assert.equal((await run('kind',{kind:'snippet'},wrongActive)).ok,false,'agent cannot change a non-active talk')
  assert.equal((await run('rename',{title:'x'.repeat(501)})).ok,false)
  assert.equal((await writeResearch({op:'copy',file,destination:other,renameSlug:'yes'},deps)).ok,false)
  const linkedSource=join(talk,'research/source-link.md');symlinkSync(file,linkedSource)
  for(const op of ['rename','kind','delete','move','copy'])assert.equal((await run(op,{file:linkedSource,title:'New',kind:'snippet',destination:other})).ok,false,op+' refuses symlink source')
  rmSync(linkedSource)
  const noTalk=join(vault,'not-a-talk');mkdirSync(noTalk)
  assert.equal((await run('copy',{destination:noTalk})).ok,false,'destination must hold an outline')
  const reserved=join(vault,'research');mkdirSync(reserved);writeFileSync(join(reserved,'fake-outline.md'),'# Fake')
  assert.equal((await run('copy',{destination:reserved})).ok,false,'research can never be a talk')
  const vaultAlias=join(root,'vault-alias');symlinkSync(vault,vaultAlias)
  const aliasDeps={...deps,vaultRoots:[vaultAlias],activeTalkDir:()=>join(vaultAlias,'talk')}
  const viaVaultAlias=await writeResearch({op:'kind',file:join(vaultAlias,'talk/research/item.md'),kind:'table'},aliasDeps)
  assert.equal(viaVaultAlias.ok,true,'configured vault aliases are canonicalised while links beneath the vault are refused')
  const duplicateTitle='2026-10-20-occupied.md'
  writeFileSync(join(talk,'research',duplicateTitle),stub())
  const occupied=await run('rename',{title:'Occupied',renameSlug:true,preview:true})
  assert.equal((await run('rename',{title:'Occupied',renameSlug:true,confirmation:occupied.confirmation})).ok,false,'slug rename never overwrites')
  assert.equal(readFileSync(join(talk,'research',duplicateTitle),'utf8'),stub())
  rmSync(join(talk,'research',duplicateTitle))
  const preview=await run('rename',{title:'Renamed [all]',renameSlug:true,preview:true})
  assert.equal(preview.ok,true,JSON.stringify(preview));assert.equal(preview.uses.length,2,'preview sees live unsaved backlinks including escaped brackets')
  assert.equal((await run('rename',{title:'Renamed [all]',renameSlug:true})).ok,false,'slug rename requires shown slide list')
  const renamed=await run('rename',{title:'Renamed [all]',renameSlug:true,confirmation:preview.confirmation})
  assert.equal(renamed.ok,true);assert.ok(existsSync(renamed.file));assert.ok(!existsSync(file));assert.match(live,/Unsaved edit/);assert.doesNotMatch(live,/research\/item.md/);assert.equal(writes.length,1);assert.equal(readFileSync(outline,'utf8'),'# Older disk version\n','rename goes through the live editor writer and never overwrites its outline on disk');assert.match(writes[0][0],/Unsaved edit/)
  const newFile=renamed.file
  assert.equal((await writeResearch({op:'kind',file:newFile,kind:'widget'},deps)).ok,true)
  assert.match(readFileSync(newFile,'utf8'),/kind: widget/)
  assert.equal((await writeResearch({op:'kind',file:newFile,kind:'bad'},deps)).ok,false)
  const titlePreview=await writeResearch({op:'rename',file:newFile,title:'Only title',preview:true},deps)
  const titleOnly=await writeResearch({op:'rename',file:newFile,title:'Only title',confirmation:titlePreview.confirmation},deps)
  assert.equal(titleOnly.file,newFile);assert.match(readFileSync(newFile,'utf8'),/title: Only title/)
  const insertCalls=[]
  const cross=await writeResearch({op:'insertHere',file:newFile},{...deps,activeTalkDir:()=>other,insertResearch:async(file,slide)=>{insertCalls.push([file,slide]);return {ok:true}}})
  assert.equal(cross.ok,true);assert.deepEqual(insertCalls,[[cross.file,false]],'cross-talk insert copies then invokes existing live editor seam')
  const copied=await writeResearch({op:'copy',file:newFile,destination:other},deps)
  assert.equal(copied.ok,true);const content=readFileSync(copied.file,'utf8');assert.match(content,/file:.*research/);assert.match(content,/Count things/)
  assert.equal(readdirSync(join(other,'research')).filter(x=>x.endsWith('.png')).length,2)
  assert.ok(existsSync(newFile),'copy preserves source')
  if (process.env.TW_TEST_REAL_SCOUT === '1') {
  const actual=await writeResearch({op:'copy',file:newFile,destination:other},{...deps,env:process.env})
  assert.equal(actual.ok,true,JSON.stringify(actual))
  const actualContent=readFileSync(actual.file,'utf8')
  assert.match(actualContent,/Only title/);assert.match(actualContent,/Count things/);assert.match(actualContent,/file:/)
  const actualRead=await (await import('../src/main/research-reader.ts')).listResearch({talkDir:other,file:actual.file},deps)
  assert.equal(actualRead.ok,true);assert.equal(actualRead.items[0].artefacts.length,1,'real Scout capture preserves copied attachment')
  }
  const suffixSource=join(talk,'research/suffixes.md')
  writeFileSync(suffixSource,stub().replace('![Chart](chart.png)','![Long](b-a.png)\n![Short](a.png)'))
  writeFileSync(join(talk,'research/b-a.png'),'LONG ATTACHMENT')
  writeFileSync(join(talk,'research/a.png'),'SHORT ATTACHMENT')
  const beforeSuffixMove=live
  live+='\n## Suffixes\n![Short](research/a.png)\n![Long](research/b-a.png)\n'
  const suffixPreview=await writeResearch({op:'move',file:suffixSource,destination:other,preview:true},deps)
  const suffixMove=await writeResearch({op:'move',file:suffixSource,destination:other,confirmation:suffixPreview.confirmation},deps)
  assert.equal(suffixMove.ok,true,JSON.stringify(suffixMove))
  const suffixLinks=researchPaths(live.slice(beforeSuffixMove.length))
  assert.deepEqual(suffixLinks.map(p=>readFileSync(join(talk,decodeURIComponent(p)),'utf8')),['SHORT ATTACHMENT','LONG ATTACHMENT'],'move preserves exact attachment identity when names share a suffix')
  live=beforeSuffixMove
  console.log('Research writer regression: move maps a.png and b-a.png to their own copied bytes — pass')
  const moveSource=join(talk,'research/moving.md');writeFileSync(moveSource,stub().replace('chart.png','moving.png'));writeFileSync(join(talk,'research/moving.png'),'moving image')
  const savedLive=live
  live+='\n## Moving\n[x](research/moving.md#part "title")\n<img src="research/moving.png">\n'
  const movePreview=await writeResearch({op:'move',file:moveSource,destination:other,preview:true},deps)
  assert.equal((await writeResearch({op:'move',file:moveSource,destination:other},deps)).ok,false)
  const moved=await writeResearch({op:'move',file:moveSource,destination:other,confirmation:movePreview.confirmation},deps)
  assert.ok(live.includes('../other/research/'+basename(moved.file)+'#part "title"'), 'move updates live outline to copied item')
  assert.doesNotMatch(live,/src="research\/moving.png"/, 'move rewrites direct attachment backlinks')
  assert.ok(!existsSync(join(talk,'research/moving.png')))
  live=savedLive
  assert.equal(moved.ok,true);assert.ok(existsSync(moved.file));assert.ok(!existsSync(moveSource),'successful move copies then trashes')
  const copyFilesBefore=readdirSync(join(other,'research')).sort()
  const failed=await writeResearch({op:'move',file:newFile,destination:other,confirmation:(await writeResearch({op:'move',file:newFile,destination:other,preview:true},deps)).confirmation},{...deps,env:{...deps.env,FAIL:'1'}})
  assert.deepEqual(readdirSync(join(other,'research')).sort(),copyFilesBefore,'failed capture removes copied attachments')
  assert.equal(failed.ok,false);assert.ok(existsSync(newFile),'partial move keeps original')
  const beforeOversizedCapture=new Set(readdirSync(join(other,'research')))
  const oversizedCapture=await writeResearch({op:'copy',file:newFile,destination:other},{...deps,env:{...deps.env,OVERSIZE_CAPTURE:'1'}})
  assert.equal(oversizedCapture.ok,false,'post-capture size validation still refuses the copy')
  assert.match(oversizedCapture.error.message,/too large/)
  const capturedStub=readdirSync(join(other,'research')).find(n=>!beforeOversizedCapture.has(n)&&n.endsWith('.md'))
  if(capturedStub){
    const capturedLinks=researchPaths(readFileSync(join(other,'research',capturedStub),'utf8'))
    assert.equal(capturedLinks.length,1,'oversized captured stub still names its attachment')
    for(const path of capturedLinks)assert.ok(existsSync(join(other,'research',decodeURIComponent(path))),'post-capture validation never leaves a stub pointing at a deleted attachment')
  }
  console.log('Research writer regression: post-capture refusal leaves no stub with missing attachments — pass')
  const beforeFenceTest=live
  live='# Talk\n\n## Example\n\n````md\n```\n[Research](research/'+basename(newFile)+')\n````\n\n## Real slide\n\n[Research](research/'+basename(newFile)+')\n'
  const fenced=await writeResearch({op:'delete',file:newFile,preview:true},deps)
  assert.deepEqual(fenced.uses.map(u=>u.slideTitle),['Real slide'],'fenced examples never hide a real use after a shorter fence')
  live=beforeFenceTest
  const liveWithoutBacklinks=live.replaceAll(/\[Research[^\n]+\n/g,'')
  const previousLive=live;live=liveWithoutBacklinks+'\n## Image only\n\n![Chart](research/chart.png)\n'
  const artefactUse=await writeResearch({op:'delete',file:newFile,preview:true},deps)
  assert.equal(artefactUse.ok,true);assert.equal(artefactUse.uses.length,1,'direct artefact use also requires a warning')
  assert.equal((await writeResearch({op:'delete',file:newFile},deps)).ok,false)
  live=previousLive
  const sharedFile=join(talk,'research/shared.md');writeFileSync(sharedFile,stub())
  const sharedPreview=await writeResearch({op:'delete',file:sharedFile,preview:true},deps)
  assert.equal((await writeResearch({op:'delete',file:sharedFile,confirmation:sharedPreview.confirmation},deps)).ok,true)
  assert.ok(existsSync(join(talk,'research/chart.png')),'an artefact used by another stub stays in place')
  const used=await writeResearch({op:'delete',file:newFile,preview:true},deps)
  assert.equal(used.uses.length,2)
  assert.equal((await writeResearch({op:'delete',file:newFile},deps)).ok,false)
  live+='New unsaved text\n'
  assert.equal((await writeResearch({op:'delete',file:newFile,confirmation:used.confirmation},deps)).ok,false,'stale use confirmation refuses')
  live=live.slice(0,-'New unsaved text\n'.length)
  const trashFailure=await writeResearch({op:'delete',file:newFile,confirmation:used.confirmation},{...deps,trash:async()=>{throw Error('Trash unavailable')}})
  assert.equal(trashFailure.error.message,'Trash unavailable')
  assert.ok(!readdirSync(join(talk,'research')).some(n=>n.startsWith('Deleted research')||n.startsWith('.trash-')))
  const clash=await writeResearch({op:'delete',file:newFile,confirmation:used.confirmation},{...deps,trash:async()=>{writeFileSync(newFile,'REAPPEARED');throw Error('Original Trash error')}})
  assert.match(clash.error.message,/Original Trash error/)
  assert.equal(readFileSync(newFile,'utf8'),'REAPPEARED')
  const restored=readdirSync(join(talk,'research')).find(n=>n.includes('restored-'))
  assert.ok(restored,'restore falls back to a free name on clash')
  assert.ok(clash.error.message.includes(restored),'the user-facing Trash error identifies the restored file name')
  console.log('Research writer regression: Trash rollback reports the restored file name — pass')
  rmSync(newFile);renameSync(join(talk,'research',restored),newFile)
  assert.equal(trashFailure.ok,false);assert.ok(existsSync(newFile));assert.ok(existsSync(join(talk,'research/chart.png')),'failed Trash restores all originals')
  const alias=join(vault,'alias');symlinkSync(other,alias)
  assert.equal((await writeResearch({op:'copy',file:newFile,destination:alias},deps)).ok,false,'destination symlink segment refused')
  const outside=join(root,'escape');mkdirSync(outside);symlinkSync(outside,join(talk,'research/escape.md'))
  assert.equal((await run('delete',{file:join(talk,'research/escape.md')})).ok,false)
  rmSync(join(talk,'research/escape.md'))
  rmSync(join(other,'research/_manifest.jsonl'),{force:true})
  symlinkSync(outside,join(other,'research/_manifest.jsonl'))
  assert.equal((await writeResearch({op:'copy',file:newFile,destination:other},deps)).ok,false,'Scout manifest cannot escape')
  rmSync(join(other,'research/_manifest.jsonl'))
  writeFileSync(join(other,'research/keep.md'),'KEEP')
  await writeResearch({op:'copy',file:newFile,destination:other},deps)
  assert.equal(readFileSync(join(other,'research/keep.md'),'utf8'),'KEEP','copy never overwrites')
  assert.equal((await writeResearch({op:'delete',file:newFile,confirmation:used.confirmation},deps)).ok,true)
  assert.ok(!existsSync(newFile));assert.ok(!existsSync(join(talk,'research/chart.png')));assert.ok(trash.length>=2,'Trash seam receives group, never unlink')
  console.log('Research writer security regressions: date traversal, visible Trash, rollback clash, vault-wide warnings, live move backlinks, link forms, capture cleanup and atomic writes pass')
  console.log('Research writer: live backlink preview, rename, kind, copy, move failure, containment, symlinks, no overwrite and Trash pass')
}finally{configureTalkWriter({editorBufferFor:()=>null});rmSync(root,{recursive:true,force:true})}
