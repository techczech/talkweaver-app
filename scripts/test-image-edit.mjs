import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync,readdirSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import sharp from 'sharp'
import {readImageEdit,saveImageEdit,IMAGE_EDIT_RECIPE_MAX_BYTES,ImageEditRecipeSizeError} from '../src/main/image-edit.ts'
import {validateImageRecipe,imageMarksSvg,replaceEditedImageUse,pooledImageOnLine} from '../src/shared/image-edit.ts'
const root=mkdtempSync(join(tmpdir(),'tw-image-edit-'))
let checks=0
const check=(f)=>{f();checks++}
try{
 mkdirSync(join(root,'_assets'))
 const original=await sharp({create:{width:100,height:80,channels:3,background:'#ffffff'}}).png().toBuffer()
 const path=join(root,'_assets','img-1234567.png');writeFileSync(path,original)
 const recipe={version:1,crop:{x:10,y:10,width:60,height:50},marks:[{kind:'text',x:12,y:12,width:20,height:15,colour:'#ff0000',text:'<script>&"'}]}
 const id=await saveImageEdit(root,'img-1234567',recipe,()=>true)
 check(()=>assert.notEqual(id,'img-1234567'))
 check(()=>assert.deepEqual(readFileSync(path),original))
 const meta=await sharp(join(root,'_assets',id+'.png')).metadata()
 check(()=>assert.deepEqual([meta.width,meta.height],[60,50]))
 const reopened=await readImageEdit(root,id)
 check(()=>assert.deepEqual(reopened,{originalId:'img-1234567',width:100,height:80,recipe}))
 check(()=>assert.ok(!imageMarksSvg(recipe,100,80).includes('<script>')))
 check(()=>assert.throws(()=>validateImageRecipe({...recipe,crop:{x:-1,y:0,width:5,height:5}},100,80)))
 check(()=>assert.throws(()=>validateImageRecipe({...recipe,marks:[{...recipe.marks[0],colour:'url(file:///etc/passwd)'}]},100,80)))
 const before=readdirSync(join(root,'_assets'))
 await assert.rejects(saveImageEdit(root,'img-1234567',recipe,()=>false));checks++
 check(()=>assert.deepEqual(readdirSync(join(root,'_assets')),before))
 const same=await saveImageEdit(root,'img-1234567',recipe,()=>true)
 check(()=>assert.equal(same,id))
 symlinkSync(path,join(root,'_assets','img-7654321.png'))
 await assert.rejects(readImageEdit(root,'img-7654321'));checks++
 await assert.rejects(saveImageEdit(root,'../../bad',recipe,()=>true));checks++

 // Command and replacement accept the same supported destination/title forms.
 for (const authored of ['![alt](img-1234567 "caption")', '![alt](  img-1234567  )', "![alt]( <img-1234567> 'caption' )", '![alt](img-1234567 "img-1234567")']) {
   check(()=>assert.equal(pooledImageOnLine(authored),'img-1234567'))
   check(()=>assert.equal(replaceEditedImageUse(authored,'img-1234567','img-7654321'),authored.replace('img-1234567','img-7654321')))
 }
 check(()=>assert.equal(pooledImageOnLine('![](img-1234567) ![](img-7654321)'),null,'command refuses two distinct pooled images'))
 check(()=>assert.equal(pooledImageOnLine('![](img-1234567) ![](img-1234567)'),null,'command refuses repeated image on a line'))
 check(()=>assert.equal(pooledImageOnLine('![](https://example.com/a.png) ![](img-1234567)'),null,'command does not guess among image references'))
 // Reviewer probes: reference ambiguity, escaped text, and syntax inside a title are never destinations.
 const referencePair='![first][p] ![second](img-1234567)\n\n[p]: img-1234567'
 const escapedLabel=String.raw`![a\](img-1234567)`
 const escapedBang=String.raw`\![a](img-1234567)`
 const titleLiteral='![external](https://example.org/a.png "literal ![](img-1234567)")'
 const escapedAltPair=String.raw`![a \] b](img-1234567)`+'\n'+titleLiteral
 for (const [authored,line] of [[referencePair,0],[escapedLabel,0],[escapedBang,0],[titleLiteral,0],[escapedAltPair,1]]) {
   check(()=>assert.equal(pooledImageOnLine(authored.split('\n')[line],authored,line),null))
   check(()=>assert.throws(()=>replaceEditedImageUse(authored,'img-1234567','img-7654321',line),/unambiguous/))
 }
 // The real escaped-bracket image may be accepted, but only its parser-proven destination may change.
 check(()=>assert.equal(replaceEditedImageUse(escapedAltPair,'img-1234567','img-7654321',0),escapedAltPair.replace('img-1234567','img-7654321')))
 check(()=>assert.equal(pooledImageOnLine(referencePair.split('\n')[0]),null,'unknown reference definitions cause refusal too'))
 check(()=>assert.equal(pooledImageOnLine('![first][p]','![first][p]\n\n[p]: img-1234567',0),null,'reference-only image has no inline destination'))
 // Block context must refuse image-looking source that Markdown renders as code or HTML.
 for (const [authored,line] of [['```markdown\n![](img-1234567)\n```',1],['    ![](img-1234567)',0],['<div>\n![](img-1234567)\n</div>',1]]) {
   check(()=>assert.equal(pooledImageOnLine(authored.split('\n')[line],authored,line),null))
   let after=authored
   check(()=>assert.throws(()=>{after=replaceEditedImageUse(authored,'img-1234567','img-7654321',line)},/unambiguous/))
   check(()=>assert.equal(after,authored,'refused code/HTML source remains unchanged'))
 }
 for (const authored of ['![](img-1234567)','### ![](img-1234567)','- ![](img-1234567)']) {
   check(()=>assert.equal(replaceEditedImageUse(authored,'img-1234567','img-7654321',0),authored.replace('img-1234567','img-7654321')))
 }
 // A line number cannot distinguish repeated references on that same line.
 const pair='![](img-1234567) ![](img-1234567)'
 check(()=>assert.throws(()=>replaceEditedImageUse(pair,'img-1234567','img-7654321',0),/unambiguous/))
 check(()=>assert.equal(replaceEditedImageUse('![](img-1234567)\n![](img-1234567)','img-1234567','img-7654321',1),'![](img-1234567)\n![](img-7654321)'))

 function fixture(name) {
   const dir=join(root,name);mkdirSync(join(dir,'_assets'),{recursive:true})
   writeFileSync(join(dir,'_assets','img-1234567.png'),original)
   return dir
 }
 for (const ext of ['webp','png']) {
   const dir=fixture('occupied-'+ext),pool=join(dir,'_assets')
   const occupied=join(pool,id+'.'+ext)
   const occupiedBytes=ext==='webp'?await sharp(original).webp().toBuffer():original
   writeFileSync(occupied,occupiedBytes)
   const fresh=await saveImageEdit(dir,'img-1234567',recipe,()=>true)
   check(()=>assert.notEqual(fresh,id,ext+' occupies the whole ID namespace'))
   check(()=>assert.deepEqual(readFileSync(occupied),occupiedBytes))
   check(()=>assert.equal(existsSync(join(pool,id+'.edit.json')),false,'no recipe attached to occupied '+ext))
   check(()=>assert.deepEqual(readFileSync(join(pool,fresh+'.edit.json')),readFileSync(join(root,'_assets',id+'.edit.json'))))
   const loaded=await readImageEdit(dir,fresh)
   check(()=>assert.deepEqual(loaded.recipe,recipe))
 }
 for (const failAt of [1,2]) {
   const dir=fixture('partial-write-'+failAt),pool=join(dir,'_assets')
   const unrelated=join(pool,'img-abcdef0.png');writeFileSync(unrelated,original)
   const names=readdirSync(pool)
   let writes=0
   await assert.rejects(saveImageEdit(dir,'img-1234567',recipe,()=>true,{write(fd,bytes){
     if(++writes===failAt){writeFileSync(fd,bytes.subarray(0,10));throw new Error('simulated disk full')}
     writeFileSync(fd,bytes)
   }}),/could not be saved/);checks++
   check(()=>assert.equal(writes,failAt))
   check(()=>assert.deepEqual(readdirSync(pool),names,'partial image/recipe created by this attempt removed'))
   check(()=>assert.deepEqual(readFileSync(unrelated),original))
   check(()=>assert.deepEqual(readFileSync(join(pool,'img-1234567.png')),original))
 }
 const largeDir=fixture('utf8-bound'),largePool=join(largeDir,'_assets')
 const largeRecipe={...recipe,marks:Array.from({length:100},()=>({...recipe.marks[0],text:'字'.repeat(300)}))}
 const serialised=JSON.stringify({originalId:'img-1234567',recipe:largeRecipe},null,2)+'\n'
 check(()=>assert.ok(serialised.length<IMAGE_EDIT_RECIPE_MAX_BYTES && Buffer.byteLength(serialised,'utf8')>IMAGE_EDIT_RECIPE_MAX_BYTES,'UTF-8 bytes, not character count, cross the bound'))
 const names=readdirSync(largePool)
 await assert.rejects(saveImageEdit(largeDir,'img-1234567',largeRecipe,()=>true),e=>e instanceof ImageEditRecipeSizeError && /Remove some marks/.test(e.message));checks++
 check(()=>assert.deepEqual(readdirSync(largePool),names,'oversized recipe writes nothing'))
 // Exactly the shared byte bound remains saveable and reloadable.
 let last=largeRecipe.marks.length-1
 const encode=()=>JSON.stringify({originalId:'img-1234567',recipe:largeRecipe},null,2)+'\n'
 while(Buffer.byteLength(encode(),'utf8')>IMAGE_EDIT_RECIPE_MAX_BYTES)largeRecipe.marks[last--].text=''
 const room=IMAGE_EDIT_RECIPE_MAX_BYTES-Buffer.byteLength(encode(),'utf8')
 largeRecipe.marks[last+1].text='字'.repeat(Math.floor(room/3))+(room%3===2?'é':room%3===1?'x':'')
 check(()=>assert.equal(Buffer.byteLength(encode(),'utf8'),IMAGE_EDIT_RECIPE_MAX_BYTES))
 const boundaryId=await saveImageEdit(largeDir,'img-1234567',largeRecipe,()=>true)
 const boundary=await readImageEdit(largeDir,boundaryId)
 check(()=>assert.deepEqual(boundary.recipe,largeRecipe))
 console.log(`image-edit: ${checks} assertions passed`)
}finally{rmSync(root,{recursive:true,force:true})}
