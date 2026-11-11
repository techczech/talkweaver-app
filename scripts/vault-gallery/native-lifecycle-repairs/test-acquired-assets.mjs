import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {galleryAcquiredAssets} from '../../../src/main/vault-gallery-assets.ts'
if(process.platform!=='darwin'){console.log('SKIP native macOS fixture; requires bundled helper build');process.exit(0)}
const home=path.resolve('scripts/vault-gallery/native-lifecycle-repairs/asset-fixture');fs.mkdirSync(home,{recursive:true})
try{
 const root=path.join(home,'root'),outside=path.join(home,'outside'),cache=path.join(home,'cache');fs.mkdirSync(root);fs.mkdirSync(outside)
 fs.writeFileSync(path.join(root,'pic.png'),Buffer.from([0,255,128,1]));fs.writeFileSync(path.join(outside,'secret'),'secret')
 const scope={root,identity:fs.statSync(root),executable:path.resolve('native/vault-gallery'),cache}
 const acquired=galleryAcquiredAssets(scope)
 const item=await acquired.file(path.join(root,'pic.png'));assert.equal(item.ok,true);assert.deepEqual(fs.readFileSync(item.path),Buffer.from([0,255,128,1]))
 fs.renameSync(path.join(root,'pic.png'),path.join(outside,'moved.png'))
 assert.deepEqual(fs.readFileSync(item.path),Buffer.from([0,255,128,1]),'Approved acquired bytes survive a subsequent move')
 fs.symlinkSync(path.join(outside,'secret'),path.join(root,'link'))
 assert.equal((await acquired.file(path.join(root,'link'))).ok,false)
 fs.symlinkSync(outside,path.join(root,'ancestor'));assert.equal((await acquired.file(path.join(root,'ancestor/secret'))).ok,false)
 assert.equal((await acquired.file(path.join(outside,'secret'))).ok,false)
 fs.renameSync(root,path.join(home,'old-root'));fs.mkdirSync(root);fs.writeFileSync(path.join(root,'replacement'),'replacement')
 assert.equal((await acquired.file(path.join(root,'replacement'))).ok,false)
 await acquired.close();assert.equal(fs.existsSync(item.path),false)
 console.log('PASS actual binary asset bytes, allowed acquired snapshot after move, fresh leaf/ancestor/outside/root rejection and cleanup')
}finally{fs.rmSync(home,{recursive:true,force:true})}
