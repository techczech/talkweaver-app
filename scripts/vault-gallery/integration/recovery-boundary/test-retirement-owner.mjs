import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {transformSync} from 'esbuild'
const source=fs.readFileSync(process.env.TW_RECOVERY_MAIN_SOURCE || 'src/main/index.ts','utf8')
for(const change of ['adoption','owner','receipt']) {
 const handlers=new Map(), receipt={from:'old',to:'destination',settled:false},entry={outlinePath:'destination',win:{isDestroyed:()=>false}};let release
 const env={ipcMain:{handle:(k,v)=>handlers.set(k,v)},movedEditorReceipts:new Map([[1,receipt]]),editorWindows:new Map([[1,entry]]),retiredMovePaths:new Map(),outlineRecovery:{save:()=>new Promise(r=>release=r)},validMoveReceipt:()=>receipt}
 vm.createContext(env)
 for(const name of ['adopt','retire']){const start=source.indexOf("ipcMain.handle('window:"+name+"-moved-talk'");vm.runInContext(transformSync(source.slice(start,source.indexOf('\n})',start)+3),{loader:'ts'}).code,env)}
 const retiring=handlers.get('window:retire-moved-talk')({sender:{id:1}},'old','latest')
 if(change==='adoption')handlers.get('window:adopt-moved-talk')({sender:{id:1}},'old','destination')
 if(change==='owner')entry.outlinePath='new-owner'
 if(change==='receipt')env.movedEditorReceipts.set(1,{...receipt})
 release();assert.equal((await retiring).ok,false,change+' across copy must refuse retirement');assert.notEqual(entry.outlinePath,null);assert.equal(env.retiredMovePaths.size,0)
}
console.log('PASS actual main retirement refuses adoption, changed owner and replaced receipt across copy')
