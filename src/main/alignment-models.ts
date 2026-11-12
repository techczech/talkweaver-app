import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AlignmentModelStore, ModelHostRefused, type ModelPin } from './alignment-model-store.ts'
import type { Alphabet } from '../shared/word-alignment.ts'
import type { AlignmentModelRow } from '../shared/alignment-status.ts'
export type AlignmentModelManifest = Omit<ModelPin,'url'> & {language:string;label:string;name:string;source:'local'|'download';url:string|null;alphabet:Alphabet;threads?:number}
export function readAlignmentManifests(folder: string): AlignmentModelManifest[] {
  return ['en','cs'].flatMap(language=>{
    try {
      const m=JSON.parse(readFileSync(join(folder,`${language}.json`),'utf8'))
      if (!m || m.threads!==undefined && ![2,4].includes(m.threads) || m.version!==1 || m.language!==language || !['local','download'].includes(m.source) || typeof m.label!=='string' || typeof m.name!=='string' || !m.alphabet || !Number.isInteger(m.alphabet.blank) || m.alphabet.blank<0 || !Object.values(m.alphabet.vocab??{}).includes(m.alphabet.blank) || m.alphabet.blank===m.alphabet.vocab?.[m.alphabet.delimiter] || ((m.alphabet.vocab?.['[PAD]']??m.alphabet.vocab?.['<pad>'])!==undefined && m.alphabet.blank!==(m.alphabet.vocab['[PAD]']??m.alphabet.vocab['<pad>'])) || m.alphabet.delimiter!=='|' || typeof m.alphabet.uppercase!=='boolean' || !Object.values(m.alphabet.vocab).every(v=>Number.isInteger(v) && Number(v)>=0)) return []
      if (!/^[a-f0-9]{64}$/.test(m.sha256) || !/^[a-f0-9]{40}$/.test(m.revision) || !Number.isSafeInteger(m.bytes) || m.bytes<=0 || !['Apache-2.0','MIT','BSD','CC-BY-4.0'].includes(m.licence) || !/^[a-z0-9-]+$/.test(m.id))return []
      if(m.source==='download'){const url=new URL(m.url);if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.port && url.port!=='443')return []}
      if(m.source==='local' && m.url!==null)return []
      if(m.redirectHosts!==undefined && (
        !Array.isArray(m.redirectHosts) || m.redirectHosts.length>16 ||
        !m.redirectHosts.every((h:unknown)=>typeof h==='string' && /^[a-z0-9.-]+$/.test(h) && !h.startsWith('.') && !h.endsWith('.'))
      ))return []
      return [m as AlignmentModelManifest]
    } catch { return [] }
  })
}
export function modelPin(m:AlignmentModelManifest):ModelPin {return {...m}}
export class AlignmentModels {
  readonly store:AlignmentModelStore
  private rows=new Map<string,AlignmentModelRow>()
  readonly manifests:AlignmentModelManifest[]
  private notify:()=>void
  private unavailableNote?:string
  constructor(manifests:AlignmentModelManifest[], userData:string,notify:()=>void=()=>{},unavailableNote?:string){this.manifests=manifests;this.notify=notify;this.unavailableNote=unavailableNote;this.store=new AlignmentModelStore(userData)}
  manifest(locale:string):AlignmentModelManifest|undefined{return this.manifests.find(m=>m.language===locale.split(/[-_]/)[0].toLowerCase())}
  async status():Promise<AlignmentModelRow[]>{return Promise.all(['en','cs'].map(async language=>{
    const m=this.manifest(language),active=this.rows.get(language)
    if(active)return active
    if(!m)return{language,label:language==='en'?'English':'Czech',state:'unavailable',note:this.unavailableNote}
    await this.store.cleanupStale(modelPin(m))
    return{language,label:m.label,bytes:m.bytes,host:m.url?new URL(m.url).hostname:undefined,local:m.source==='local',state:await this.store.usable(modelPin(m),true)?'installed':'absent'}
  }))}
  async change(language:unknown,action:'download'|'install'|'remove',file?:string):Promise<void>{
    if(typeof language!=='string' || !['en','cs'].includes(language))throw Error('Invalid language')
    const m=this.manifest(language);if(!m)throw Error('Precise word timing is not available yet for this language')
    if(this.rows.get(language)?.state==='downloading')throw Error('Model operation already running')
    if(action==='remove'){await this.store.remove(modelPin(m));this.rows.delete(language);this.notify();return}
    if(action==='download' && m.source!=='download' || action==='install' && (m.source!=='local' || !file))throw Error('Model source refused')
    const row={language,label:m.label,bytes:m.bytes,host:m.url?new URL(m.url).hostname:undefined,local:m.source==='local'}
    this.rows.set(language,{...row,state:'downloading',received:0});this.notify()
    let reported=0
    const progress=(received:number)=>{if(received-reported<Math.max(65536,m.bytes/100) && received!==m.bytes)return;reported=received;this.rows.set(language,{...this.rows.get(language)!,received});this.notify()}
    try{if(action==='download')await this.store.download(modelPin(m),progress);else await this.store.installFile(modelPin(m),file!,progress);this.rows.set(language,{...row,state:'installed'})}
    catch(e){const kept=await this.store.usable(modelPin(m));this.rows.set(language,{language,label:m.label,bytes:m.bytes,host:m.url?new URL(m.url).hostname:undefined,local:m.source==='local',state:kept?'installed':'failed',note:e instanceof ModelHostRefused?`Model host refused: ${e.host}. Report this host so the download allow-list can be checked.`:kept?'Installation failed; the earlier verified model is still available.':e instanceof Error && e.name==='AbortError'?'Cancelled. Retry when ready.':'The model could not be installed. Check the file or connection and Retry.'});throw e}
    finally{this.notify()}
  }
  cancel(language:unknown):void{if(typeof language!=='string')return;const m=this.manifest(language);if(m)this.store.cancel(modelPin(m))}
}
