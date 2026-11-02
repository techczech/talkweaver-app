import type { createGalleryStorage } from './vault-gallery-storage'
interface Sender {id:number;mainFrame:unknown;isDestroyed():boolean;once(event:string,callback:()=>void):unknown;send(channel:string,value:unknown):void}
interface Event {senderFrame:unknown;sender:Sender}
export function registerGalleryStorageIPC(ipc:{handle(channel:string,callback:(event:Event,...args:any[])=>unknown):unknown},storage:ReturnType<typeof createGalleryStorage>) {
 const senders=new WeakSet<Sender>()
 const authorize=(event:Event)=>{if(!event.senderFrame || event.senderFrame!==event.sender.mainFrame)throw Error('Main frame required')}
 ipc.handle('vault:gallery-inventory',(event,request:unknown)=>{
  authorize(event)
  if(!senders.has(event.sender)){senders.add(event.sender);const id=event.sender.id;event.sender.once('destroyed',()=>storage.forget(id))}
  return storage.start(event.sender.id,request,result=>{if(!event.sender.isDestroyed())event.sender.send('vault:gallery-inventory-progress',result)})
 })
 ipc.handle('vault:gallery-inventory-cancel',(event,generation:unknown)=>{
  authorize(event)
  if(!Number.isSafeInteger(generation) || (generation as number)<0)throw Error('Invalid inventory generation')
  storage.cancel(event.sender.id,generation as number)
 })
}
