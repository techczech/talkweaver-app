import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {prepareSource} from '../../../compiler/scripts/lib/08-source-adapters.mjs'
import {galleryAcquiredAssets} from '../../../src/main/vault-gallery-assets.ts'
if(process.platform!=='darwin'){console.log('SKIP native macOS fixture; requires bundled helper build');process.exit(0)}
const home=path.resolve('scripts/vault-gallery/native-storage/compiler-fixture');fs.mkdirSync(home,{recursive:true})
try {
 const root=path.join(home,'root'),outside=path.join(home,'outside');fs.mkdirSync(root);fs.mkdirSync(outside)
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>AUTHORISED</text></svg>'
 const file=path.join(root,'image.svg');fs.writeFileSync(file,svg);fs.writeFileSync(path.join(outside,'secret.svg'),svg.replace('AUTHORISED','OUTSIDE_SECRET'))
 const acquired=galleryAcquiredAssets({root,identity:fs.statSync(root),executable:path.resolve('native/vault-gallery'),cache:path.join(home,'cache')})
 let swapped=false
 const hook={...acquired,async file(candidate){const result=await acquired.file(candidate);if(result.ok&&!swapped){swapped=true;fs.renameSync(file,path.join(outside,'moved.svg'));fs.symlinkSync(path.join(outside,'secret.svg'),file)}return result}}
 try {
  const model=await prepareSource(path.join(root,'outline.md'),'---\ntitle: Talk\n---\n\n### Slide\n\n![Picture](image.svg)','Talk',{mtimeMs:0,size:1,isDirectory:()=>false,isFile:()=>true},undefined,{allowedAssetRoots:[root],galleryAcquiredAssets:hook})
  assert.equal(swapped,true);assert.ok(JSON.stringify(model).includes(Buffer.from(svg).toString('base64')),'Compiler consumes authorised acquired bytes after source swap')
  assert.equal(JSON.stringify(model).includes(Buffer.from(svg.replace('AUTHORISED','OUTSIDE_SECRET')).toString('base64')),false)
  console.log('PASS actual compiler digest/inliner reads acquired snapshot, never swapped live asset target')
 } finally {acquired.close()}
} finally {fs.rmSync(home,{recursive:true,force:true})}
