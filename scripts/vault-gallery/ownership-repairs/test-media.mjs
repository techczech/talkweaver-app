import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync,rmSync,statSync,existsSync} from 'node:fs'
import {resolve,basename} from 'node:path'
import {createHash} from 'node:crypto'
import ts from 'typescript'
import {mediaFingerprint} from '../../../src/main/layout-variant-thumbnail.ts'
import {createGalleryFacts} from '../../../src/main/vault-gallery-facts.ts'
const root=resolve('scripts/vault-gallery/ownership-repairs/media-fixture');mkdirSync(root,{recursive:true});
try {
const outlinePath=resolve(root,'outline.md'),media=resolve(root,'art.png'),old=resolve(root,'obsolete.png');const text='# Talk\n![](art.png)';writeFileSync(outlinePath,text);writeFileSync(media,'one');writeFileSync(old,'obsolete');
const index=readFileSync('src/main/index.ts','utf8');const body=index.split('const galleryFacts = createGalleryFacts({')[1].split('  read: async t => {')[1].split('\n  },\n  render:')[0];
const names={app:{isPackaged:false,getAppPath:()=>root},join:(...p)=>p.join('/'),readGallerySource:()=>({text,stat:statSync(outlinePath)}),vaultRegistry:{get:()=>({open:true,root})},vaultAvailability:{isUnavailable:()=>false},galleryEpoch:0,createHash,thumbCacheRoot:()=>root,searchCache:new Map([[outlinePath,{rows:[{thumbnail_hash:'obsolete'}]}]]),isSearchIndexEntryFresh:()=>true,galleryCoverFile:()=>old,talkThumbCacheDir:()=>root,thumbUrl:(_s,key)=>key,basename,mediaFingerprint,resolvePooledRefs:s=>s,galleryArtwork:new Map(),existsSync};
const js=ts.transpileModule(`async function read(t) {${body}\n}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const read=Function(...Object.keys(names),js+';return read')(...Object.values(names));let renders=0;
const target={outlinePath,root,vaultId:'v',relativeOutline:'outline.md',slug:'t',epoch:0};
const facts=createGalleryFacts({resolve:async()=>target,current:()=>true,read,render:async()=>({slideCount:1,coverUrl:'render-'+(++renders)})});
assert.equal((await read(target)).coverUrl,null,'uncertified stale search artwork must not be ready');
const first=await facts('v','outline.md');assert.equal(renders,1);writeFileSync(media,'changed media bytes, unchanged outline');const second=await facts('v','outline.md');assert.notEqual(second.revision,first.revision);assert.equal(renders,2);assert.equal(second.coverUrl,'render-2');console.log('PASS actual main read revision detects media-only edit and refuses uncertified stale rows');
}finally{rmSync(root,{recursive:true,force:true})}
