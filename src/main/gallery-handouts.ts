import { join } from 'node:path'
import { normaliseRun } from './runs.ts'
import { readHandoutUrl } from './publishing-logic.ts'
import { collectPublishedPages, type PublishedPagesDeps, type linkedPages } from './published-pages.ts'
import { galleryHandouts } from '../shared/gallery-handouts.ts'
import type { GalleryTalk } from '../shared/vault-gallery.ts'
interface Source { text:string }
/** Scoped adapter to the combined collector. No discovery, compiler, refresh or writes. */
export async function collectGalleryHandouts(talk:GalleryTalk, root:string, io:{read(path:string):Promise<Source>;list(path:string):Promise<string[]>;current():boolean}, site:Pick<PublishedPagesDeps,'siteDir'|'readRegistry'> & {acquireSite?:(folders:string[])=>Promise<import('../shared/published-pages.ts').SiteListing>}) {
 const snapshot:ReturnType<typeof linkedPages>={talks:[],runs:[],unreadable:0}
 try {
  const {text}=await io.read(talk.relativeOutline)
  if(!io.current())return null
  const url=readHandoutUrl(text)
  if(url?.trim())snapshot.talks.push({vaultId:talk.vaultId,outline:talk.relativeOutline,slug:talk.slug,title:talk.title,outlinePath:join(root,talk.relativeOutline),handoutUrl:url.trim()})
 }catch{snapshot.unreadable++}
 // This index is keyed by slug, not source outline. Preserve its records as ambiguous evidence.
 try {
  if(!talk.slug || /[\\/]/.test(talk.slug) || talk.slug==='.' || talk.slug==='..')throw Error('Unsupported Run identity')
  const path=`_PRESENTATIONS/${talk.slug}`
  const roots=await io.list('')
  const names=roots.includes('_PRESENTATIONS') ? (await io.list('_PRESENTATIONS')).includes(path) ? await io.list(path) : [] : []
  if(names.length>128)throw Error('Run record limit')
  for(const file of names){
   if(!io.current())return null
   if(!file.endsWith('.json') || file.endsWith('/manifest.json'))continue
   try {const run=normaliseRun(JSON.parse((await io.read(file)).text));if(run.handoutUrl && run.talkSlug===talk.slug)snapshot.runs.push({vaultId:talk.vaultId,root,run})}catch{snapshot.unreadable++}
  }
 }catch{snapshot.unreadable++}
 if(!io.current())return null
 const folders=[talk.slug,...snapshot.runs.flatMap(({run})=>run.handoutFolder ? [run.handoutFolder] : [])]
 const acquired=site.acquireSite ? await site.acquireSite(folders) : undefined
 if(!io.current())return null
 const input=collectPublishedPages({...site,vaults:()=>[],talks:()=>[],readOutline:()=>null},snapshot,acquired)
 if(!io.current())return null
 return galleryHandouts(talk,input)
}
