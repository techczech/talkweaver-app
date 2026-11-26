import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as cover from '../../../src/main/vault-gallery-cover.ts'
const {galleryCoverFile}=cover
const home=path.resolve('scripts/vault-gallery/repairs/cover-fixture');fs.mkdirSync(home,{recursive:true})
try {
 const section={slide_id:'section',layout:'section-title',role:'section-title'};
 const first={slide_id:'intro',layout:'text',role:'content'};
 const title={slide_id:'cover',layout:'title',role:'opening'};
 assert.equal(cover.galleryCoverIndex([section,first,title]),2,'an authored title slide wins over the first row');
 assert.equal(cover.galleryCoverIndex([section,first]),1,'a divider is never rendered as the fallback');
 assert.equal(cover.galleryCoverIndex([section]),-1,'a deck of dividers has no cover');
 const old='a'.repeat(16),current='b'.repeat(16),row={render_hash:'model',thumbnail_hash:current};
 for(const name of ['model',old+'-model'])fs.writeFileSync(path.join(home,name+'.png'),'obsolete');
 assert.equal(galleryCoverFile(home,row),null);
 const exact=path.join(home,current+'-model.png');fs.writeFileSync(exact,'current');assert.equal(galleryCoverFile(home,row),exact);
 fs.unlinkSync(exact);assert.equal(galleryCoverFile(home,row),null);
 console.log('PASS obsolete bare and old artwork refused; only exact current artwork accepted; missing exact pending');
} finally {fs.rmSync(home,{recursive:true,force:true})}
