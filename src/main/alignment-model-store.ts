import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
export class ModelHostRefused extends Error { readonly host:string;constructor(host:string){super(`Model host refused: ${host}`);this.host=host;this.name='ModelHostRefused'} }
export type ModelPin = { id: string; revision: string; sha256: string; bytes: number; url: string|null; redirectHosts?:string[]; licence: 'Apache-2.0' | 'MIT' | 'BSD' | 'CC-BY-4.0' }
function validatePin(pin: ModelPin): void {
  const url = pin.url ? new URL(pin.url) : null
  if (!/^[a-z0-9-]+$/.test(pin.id) || !/^[a-f0-9]{40}$/.test(pin.revision) || !/^[a-f0-9]{64}$/.test(pin.sha256) ||
      !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0 || url && (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port!=='443') ||
      pin.redirectHosts!==undefined && (!Array.isArray(pin.redirectHosts) || pin.redirectHosts.length>16 || !pin.redirectHosts.every(h=>typeof h==='string' && /^[a-z0-9.-]+$/.test(h) && !h.startsWith('.') && !h.endsWith('.'))) || !['Apache-2.0','MIT','BSD','CC-BY-4.0'].includes(pin.licence)) throw Error('Invalid model pin')
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
/** Main-process-only store. The caller supplies app.getPath('userData'), never a vault path.
 * Pins are build-time constants, never renderer arguments. Downloads cleanly restart. */
export class AlignmentModelStore {
  private readonly verified = new Map<string,{stamp:string;valid:boolean}>()
  private readonly active = new Map<string, AbortController>()
  private readonly userData: string
  private readonly request: typeof fetch
  private readonly hash: typeof hashFile
  constructor(userData: string, request: typeof fetch = fetch, hash:typeof hashFile=hashFile) { this.userData = userData; this.request = request;this.hash=hash }
  private path(pin: ModelPin): string { validatePin(pin); return join(this.userData, 'alignment-models', `${pin.id}-${pin.sha256}.onnx`) }
  async usable(pin: ModelPin, cached = true): Promise<string | null> {
    const path = this.path(pin)
    try {
      const stat=await lstat(path);if(!stat.isFile() || stat.isSymbolicLink() || stat.size!==pin.bytes)return null
      const stamp=JSON.stringify([stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs]),prior=this.verified.get(path)
      if(cached && prior?.stamp===stamp)return prior.valid?path:null
      const valid=await this.hash(path)===pin.sha256;this.verified.set(path,{stamp,valid});return valid?path:null
    } catch { return null }
  }
  /** Sweep only this manifest's dead-owner partials; never touch another live process. */
  async cleanupStale(pin:ModelPin):Promise<void>{
    this.path(pin)
    const folder=join(this.userData,'alignment-models'),prefix=`${pin.id}-${pin.sha256}.onnx.`
    let names:string[];try{names=await readdir(folder)}catch{return}
    for(const name of names){
      if(!name.startsWith(prefix))continue
      const match=/^(\d+)\.[a-f0-9-]{36}\.partial$/.exec(name.slice(prefix.length));if(!match)continue
      const pid=Number(match[1]);if(!Number.isSafeInteger(pid) || pid<=0 || pid===process.pid)continue
      try{process.kill(pid,0)}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')await rm(join(folder,name),{force:true})}
    }
  }
  /** Exact content-addressed files for this model ID only; partials and other languages stay. */
  private async removeSuperseded(pin:ModelPin,keepCurrent:boolean):Promise<void>{
    const target=this.path(pin),folder=join(this.userData,'alignment-models')
    let names:string[];try{names=await readdir(folder)}catch{return}
    for(const name of names){
      if(!name.startsWith(pin.id+'-') || !/^[a-f0-9]{64}\.onnx$/.test(name.slice(pin.id.length+1)))continue
      const path=join(folder,name);if(keepCurrent && path===target)continue
      await rm(path,{force:true});this.verified.delete(path)
    }
  }
  cancel(pin: ModelPin): void { validatePin(pin); this.active.get(pin.id)?.abort() }
  async remove(pin: ModelPin): Promise<void> {
    if (this.active.has(pin.id)) throw Error('Cancel the download before removing the model')
    const path=this.path(pin);await rm(path, { force: true });this.verified.delete(path);await this.removeSuperseded(pin,false)
  }
  cancelAll(): void { for (const controller of this.active.values()) controller.abort() }
  async installFile(pin: ModelPin, source: string, progress: (received:number,total:number)=>void):Promise<string> {
    const target=this.path(pin)
    if(this.active.has(pin.id))throw Error('Model operation already running')
    const controller=new AbortController();this.active.set(pin.id,controller)
    const temp=`${target}.${process.pid}.${randomUUID()}.partial`;let owns=false
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      const st=await lstat(source);if(!st.isFile() || st.size!==pin.bytes)throw Error('Model size mismatch')
      await mkdir(join(this.userData,'alignment-models'),{recursive:true})
      file=await open(temp,'wx',0o600);owns=true
      const hash=createHash('sha256');let received=0
      for await(const bytes of createReadStream(source)) {
        controller.signal.throwIfAborted();received+=bytes.length
        if(received>pin.bytes)throw Error('Model size mismatch')
        hash.update(bytes);await file.writeFile(bytes);progress(received,pin.bytes)
      }
      if(received!==pin.bytes || hash.digest('hex')!==pin.sha256)throw Error('Model checksum mismatch; file refused')
      await file.sync();await file.close();file=undefined
      controller.signal.throwIfAborted();await rename(temp,target);await this.removeSuperseded(pin,true);return target
    }finally{if(file)await file.close().catch(()=>{});if(owns)await rm(temp,{force:true});this.active.delete(pin.id)}
  }
  async download(pin: ModelPin, progress: (received: number, total: number) => void): Promise<string> {
    const target = this.path(pin)
    if (!pin.url) throw Error('No public download source for this model')
    if (this.active.has(pin.id)) throw Error('Model download already running')
    const controller = new AbortController(); this.active.set(pin.id, controller)
    const temp = `${target}.${process.pid}.${randomUUID()}.partial`
    let ownsTemp = false
    let file: Awaited<ReturnType<typeof open>> | undefined
    const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000)
    try {
      await mkdir(join(this.userData, 'alignment-models'), { recursive: true })
      // Exclusive creation refuses symlinks and concurrent processes. No partial is usable.
      file = await open(temp, 'wx', 0o600); ownsTemp = true
      const hosts=new Set([new URL(pin.url).hostname,...(pin.redirectHosts??[])])
      let url = new URL(pin.url), response: Response | undefined
      for (let redirects = 0; redirects <= 3; redirects++) {
        if (url.protocol !== 'https:' || url.username || url.password || !hosts.has(url.hostname) || url.port && url.port !== '443') throw new ModelHostRefused(url.hostname)
        response = await this.request(url, { signal: controller.signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' })
        if (![301,302,303,307,308].includes(response.status)) break
        const location = response.headers.get('location'); await response.body?.cancel()
        if (!location || redirects === 3) throw Error('Model redirect refused')
        url = new URL(location, url)
      }
      if (!response?.ok || !response.body) {try{await response?.body?.cancel()}catch{};throw Error('Model download failed; retry when online')}
      const hash = createHash('sha256'); let received = 0
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        controller.signal.throwIfAborted()
        received += chunk.length
        if (received > pin.bytes) throw Error('Model download exceeds pinned size')
        hash.update(chunk); await file.writeFile(chunk); progress(received, pin.bytes)
      }
      if (received !== pin.bytes || hash.digest('hex') !== pin.sha256) throw Error('Model checksum mismatch; file refused')
      await file.sync(); await file.close(); file = undefined
      controller.signal.throwIfAborted()
      await rename(temp, target)
      await this.removeSuperseded(pin,true)
      return target
    } finally {
      clearTimeout(timer)
      if (file) await file.close().catch(() => {})
      // Only remove our own exclusive temporary file; failed open may belong to another process.
      if (ownsTemp) await rm(temp, { force: true })
      this.active.delete(pin.id)
    }
  }
}
