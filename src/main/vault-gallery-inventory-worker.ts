import { scanInventory } from './vault-gallery-inventory'
import { inventoryFilesystem } from './vault-gallery-inventory-fs'

import type { InventoryRequest } from '../shared/vault-gallery-storage'
let used=false,active=true
let fs:ReturnType<typeof inventoryFilesystem>|null=null
process.parentPort.on('message',(event:{data:{root:string;executable:string;expectedIdentity:string;request:InventoryRequest;cancel?:boolean}})=>{
 if(event.data.cancel){active=false;void fs?.close().then(()=>process.exit(0));return}
 if(used)return
 used=true
 const {root,request,executable,expectedIdentity}=event.data
 fs=inventoryFilesystem(root,executable,expectedIdentity)
 void scanInventory(request,fs,()=>active,result=>process.parentPort.postMessage(result))
})
