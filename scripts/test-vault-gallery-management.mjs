import { tmpdir as fixtureTmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
const dir=mkdtempSync(resolve(fixtureTmpdir(),'tw-gallery-actions-'))
try {
 await build({entryPoints:['src/renderer/src/components/talklist/actions.ts'],outfile:join(dir,'actions.mjs'),bundle:true,platform:'node',format:'esm'})
 const {useTalkActions}=await import(join(dir,'actions.mjs'))
 globalThis.CustomEvent=class{constructor(type,options){this.type=type;this.detail=options?.detail}}
 const old={path:'/fixture/category/old',title:'Old',slug:'old',vaultId:'v',outlinePath:'/fixture/category/old/old-outline.md'}
 const moved={...old,title:'New',outlinePath:'/fixture/new/new-outline.md'}
 let prompt,confirm,allow=false,result=moved,calls=[],results=[]
 globalThis.window={dispatchEvent(){},tw:{windows:{recoverMovedTalk:async()=>({kind:'no-receipt'})},vault:{renameTalk:async()=>{calls.push('write');return result},moveTalk:async()=>{calls.push('write');return result},deleteTalk:async()=>{calls.push('write');return !!result},cloneTalk:async()=>{calls.push('clone');return result},createFolder:async(...args)=>{calls.push(args);return 'nested/new'}}}}
 const a=useTalkActions({talks:[old],vaults:[{id:'v',root:'/fixture',open:true}],activeTalk:old,leaveActive:async()=>{calls.push('leave');if(allow==='throw')throw Error('Save refused');return allow},onSelectTalk:async()=>{calls.push('select');return true},onDeletedTalk:()=>calls.push('removed'),onRefresh:async()=>calls.push('refresh'),onOperationResult:r=>results.push(r),setPrompt:p=>prompt=p,setConfirm:c=>confirm=c,setMenu(){},setMoveMenu(){},setFocusKey(){}})
 a.startRename(old);assert.equal(calls.length,0,'cancelled dialog performs no operation')
 await prompt.onSubmit('New');assert.deepEqual(calls,['leave'],'save refusal prevents writer');assert.equal(results.length,0)
 allow='throw';calls=[];await assert.rejects(prompt.onSubmit('New'),/Save refused/);assert.deepEqual(calls,['leave']);
 allow=true;calls=[];await prompt.onSubmit('New');assert.deepEqual(calls,['leave','write','select','refresh']);assert.equal(results[0].talk.outlinePath,moved.outlinePath)
 for(const refusal of [null,{error:'target-exists'},{error:'open-elsewhere'}]){result=refusal;calls=[];results=[];await prompt.onSubmit('New');assert.deepEqual(calls,['leave','write']);assert.equal(results.length,0)}
 result=moved;calls=[];await a.doMove(old,'nested');assert.deepEqual(calls,['leave','write','select','refresh'])
 calls=[];a.startDelete(old);await confirm.onConfirm();assert.deepEqual(calls,['leave','write','removed','refresh'])
 calls=[];await a.doNewFolder('new','nested','v');assert.deepEqual(calls[0],['new','nested','v'])
 calls=[];a.startDuplicate(old);await prompt.onSubmit('Copy');assert.deepEqual(calls,['leave','clone','refresh','select'])
 calls=[];window.tw.vault.renameFolder=async()=>{calls.push('folder-write');return 'renamed'};a.onFolderAction('category','rename','v');await prompt.onSubmit('renamed');assert.deepEqual(calls,['leave','folder-write','select','refresh']);
 calls=[];window.tw.vault.deleteFolder=async()=>{calls.push('folder-bin');return true};a.onFolderAction('category','delete','v');await confirm.onConfirm();assert.deepEqual(calls,['leave','folder-bin','refresh']);assert.equal(results.at(-1).folder,'');
 console.log('PASS cancellation, save refusal, collision, owner refusal, returned rename/move identity, active Bin callback, folder destination, flushed duplicate')
} finally {rmSync(dir,{recursive:true,force:true})}
