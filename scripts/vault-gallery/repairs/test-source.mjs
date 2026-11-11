import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {readGallerySource} from '../../../src/main/vault-gallery-read.ts'
const home=path.resolve('scripts/vault-gallery/repairs/source-fixture');fs.mkdirSync(home,{recursive:true})
const root=path.join(home,'root'), outside=path.join(home,'outside');fs.mkdirSync(root);fs.mkdirSync(outside)
try {
 const file=path.join(root,'talk.md'), other=path.join(outside,'talk.md');fs.writeFileSync(file,'inside');fs.writeFileSync(other,'secret')
 if(process.platform!=='darwin'){assert.throws(()=>readGallerySource(root,file,()=>true));console.log('PASS unsupported runtime refuses');}
 else {
 assert.equal(readGallerySource(root,file,()=>true).text,'inside');fs.unlinkSync(file);fs.symlinkSync(other,file)
 assert.throws(()=>readGallerySource(root,file,()=>true));fs.unlinkSync(file)
 const folder=path.join(root,'folder');fs.symlinkSync(outside,folder)
 assert.throws(()=>readGallerySource(root,path.join(folder,'talk.md'),()=>true));
 fs.writeFileSync(file,'inside');assert.throws(()=>readGallerySource(root,file,()=>false));let calls=0;assert.throws(()=>readGallerySource(root,file,()=>++calls<3));
 console.log('PASS descriptor body read, leaf and ancestor symlink refusal, cancellation before/after read')
 }
} finally {fs.rmSync(home,{recursive:true,force:true})}
