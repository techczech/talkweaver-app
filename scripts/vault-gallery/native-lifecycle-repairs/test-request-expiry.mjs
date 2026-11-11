import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {readGallerySource} from '../../../src/main/vault-gallery-read.ts'
import {galleryAcquiredAssets} from '../../../src/main/vault-gallery-assets.ts'
if(process.platform!=='darwin'){console.log('SKIP native macOS fixture; requires bundled helper build');process.exit(0)}
const home=path.resolve('scripts/vault-gallery/native-lifecycle-repairs/expiry-fixture');fs.mkdirSync(home,{recursive:true})
try {
 const root=path.join(home,'root'),cache=path.join(home,'cache');fs.mkdirSync(root);fs.mkdirSync(cache);fs.writeFileSync(path.join(root,'file'),'approved')
 const marker=path.join(cache,'active');fs.writeFileSync(marker,'active')
 const acquired=galleryAcquiredAssets({root,identity:fs.statSync(root),executable:path.resolve('native/vault-gallery'),cache,marker})
 const file=await acquired.file(path.join(root,'file'));assert.equal(file.ok,true)
 fs.unlinkSync(marker);await assert.rejects(()=>readGallerySource(root,path.join(root,'file'),()=>true,fs.statSync(root),path.resolve('native/vault-gallery'),marker),/cancelled/,'Native helper independently refuses a revoked marker');await assert.rejects(acquired.file(path.join(root,'file')),/expired/,'Even a retained snapshot is unavailable to a cancelled request')
 await acquired.close();assert.equal(fs.existsSync(file.path),false)
 console.log('PASS marker revocation stops subsequent cached and fresh asset work; snapshot cleaned')
} finally {fs.rmSync(home,{recursive:true,force:true})}
