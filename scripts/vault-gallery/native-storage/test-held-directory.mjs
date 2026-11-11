import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {inventoryFilesystem} from '../../../src/main/vault-gallery-inventory-fs.ts'
if(process.platform!=='darwin'){console.log('SKIP native macOS fixture; requires bundled helper build');process.exit(0)}
const home=path.resolve('scripts/vault-gallery/native-storage/held-fixture');fs.mkdirSync(home,{recursive:true})
let adapter
try{
 const root=path.join(home,'root');fs.mkdirSync(path.join(root,'folder'),{recursive:true})
 for(let i=0;i<45;i++)fs.writeFileSync(path.join(root,'folder',String(i)),'fixture')
 const s=fs.statSync(root);adapter=inventoryFilesystem(root,path.resolve('native/vault-gallery'),`${s.dev}:${s.ino}`)
 await adapter.identity();await adapter.metadata('folder')
 const names=[]
 for await(const name of adapter.children('folder')){names.push(name);if(names.length===1)fs.renameSync(path.join(root,'folder'),path.join(home,'moved'))}
 assert.equal(names.length,45,'Policy allows bounded enumeration through acquired directory after move')
 await assert.rejects(adapter.metadata('folder/1'),'Fresh acquisition of old path must fail')
 fs.writeFileSync(path.join(root,'cloud'),'data');execFileSync('/usr/bin/xattr',['-w','com.apple.fileprovider.fixture','fixture',path.join(root,'cloud')])
 assert.equal((await adapter.metadata('cloud')).allocated,null)
 fs.writeFileSync(path.join(root,'plain'),'data');assert.equal((await adapter.metadata('plain')).allocated,fs.statSync(path.join(root,'plain')).blocks*512)
 console.log('PASS approved held-directory enumeration after move, fresh old-path refusal, provider allocation unknown and actual st_blocks allocation')
}finally{await adapter?.close();fs.rmSync(home,{recursive:true,force:true})}
