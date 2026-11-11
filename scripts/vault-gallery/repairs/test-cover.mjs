import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {galleryCoverFile} from '../../../src/main/vault-gallery-cover.ts'
const home=path.resolve('scripts/vault-gallery/repairs/cover-fixture');fs.mkdirSync(home,{recursive:true})
try {
 const old='a'.repeat(16),current='b'.repeat(16),row={render_hash:'model',thumbnail_hash:current};
 for(const name of ['model',old+'-model'])fs.writeFileSync(path.join(home,name+'.png'),'obsolete');
 assert.equal(galleryCoverFile(home,row),null);
 const exact=path.join(home,current+'-model.png');fs.writeFileSync(exact,'current');assert.equal(galleryCoverFile(home,row),exact);
 fs.unlinkSync(exact);assert.equal(galleryCoverFile(home,row),null);
 console.log('PASS obsolete bare and old artwork refused; only exact current artwork accepted; missing exact pending');
} finally {fs.rmSync(home,{recursive:true,force:true})}
