import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import {createPlannedRunIn} from '../../../src/main/planned-runs-ipc.ts'
const root=mkdtempSync(join(import.meta.dirname,'plan-fixture-'))
try {
 const index=readFileSync('src/main/index.ts','utf8')
 const callback=index.slice(index.indexOf('  sourceForPlan: async ('),index.indexOf('  hasTalk: (root, talkSlug) =>'))
 const editors=new Map([[1,{outlinePath:'/vault/b/same-outline.md'}]])
 const sourceForPlan=vm.runInNewContext(ts.transpile('({'+callback+'})',{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}),{editorWindows:editors,verifiedRunSource:async()=> 'b/same-outline.md',writableRootFor:()=>root,writableVaultRoot:()=>root,vaultRegistry:{get:()=>({root})}}).sourceForPlan
 const history=readFileSync('src/main/history.ts','utf8')
 const start=history.indexOf("  ipcMain.handle('history:create-planned-run'")
 const end=history.indexOf("  ipcMain.handle('history:update-planned-run'",start)
 let fn,id=0
 const deps={sourceForPlan,vaultRoot:()=>root,mintId:()=>`p${++id}`}
 vm.runInNewContext(ts.transpile(history.slice(start,end),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}),{deps,ipcMain:{handle:(name,cb)=>fn=cb},plannedRunDeps:d=>d,createPlannedRunIn})
 const input={talkSlug:'same',talkTitle:'Same',eventTitle:'Fixture',plannedDate:'2026-10-29',slideSet:{kind:'all'}}
 const planned=await fn({sender:{id:1}},input)
 assert.equal(planned.run.sourceOutline,'b/same-outline.md')
 await assert.rejects(fn({sender:{id:1}},{...input,sourceOutline:'a/same-outline.md'}),/conflict/)
 const unknown=await fn({sender:{id:2}},{...input,sourceOutline:'a/same-outline.md'})
 assert.equal(unknown.run.sourceOutline,undefined,'Unmapped sender cannot establish provenance from renderer claim')
 console.log('actual history admission and main sender mapper: exact open editor, conflicting claim refusal, unmapped legacy remains unknown')
}finally{rmSync(root,{recursive:true,force:true})}
