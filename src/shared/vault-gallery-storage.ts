export interface InventoryRequest { vaultId:string; relativePath:string; generation:number; recursive:boolean; confirmedRoot:boolean }
export type InventoryKind = 'folder'|'file'|'research'|'assets'|'system'|'link'|'alias'|'other'
export interface InventoryEntry { relativePath:string; kind:InventoryKind; logical:number|null; allocated:number|null; reason?:string }
export interface InventoryResult {
 vaultId:string; relativePath:string; generation:number; recursive?:boolean; rootIdentity:string|null; checkedAt:string;
 state:'running'|'complete'|'partial'|'cancelled'|'stale'|'unavailable'|'refused'; reason?:string;
 entries:InventoryEntry[]; counted:number; unreadable:number; excluded:number; truncated:boolean;
 logicalBytes:number|null; allocatedBytes:number|null; allocationUnknown:number
}
export function validateInventoryRequest(value:unknown):InventoryRequest {
 if (!value || typeof value!=='object') throw Error('Invalid inventory request')
 const r=value as InventoryRequest
 if(Object.keys(r).some(k=>!['vaultId','relativePath','generation','recursive','confirmedRoot'].includes(k)) || typeof r.vaultId!=='string' || !r.vaultId || r.vaultId.length>256 || typeof r.relativePath!=='string' || r.relativePath.length>4096 || r.relativePath.includes('\\') || r.relativePath.includes('\0') || (r.relativePath!=='' && r.relativePath.split('/').some(p=>!p || p==='.' || p==='..')) || !Number.isSafeInteger(r.generation) || r.generation<0 || typeof r.recursive!=='boolean' || typeof r.confirmedRoot!=='boolean') throw Error('Invalid inventory authority')
 if(r.recursive && !r.relativePath && !r.confirmedRoot) throw Error('Whole vault measurement requires confirmation')
 return r
}
/** Physical subtree only; cached image references never affect these totals.
 *  `allocated` is an exact total or null; `allocatedAtLeast` is the sum of retained known allocations (a floor, never a total). */
export interface TalkSize { logical: number | null; allocated: number | null; allocatedAtLeast: number | null; partial: boolean }
export function inventoryTalkSize(result:InventoryResult|null|undefined,folder:string):TalkSize|null {
 if(!result?.recursive || !['complete','partial','cancelled'].includes(result.state))return null
 if(result.relativePath!==folder && !folder.startsWith(result.relativePath ? result.relativePath+'/' : ''))return null
 if(result.relativePath!==folder && !result.entries.some(e=>e.relativePath===folder))return null
 const prefix=folder?folder+'/':''
 const entries=result.entries.filter(e=>e.relativePath.startsWith(prefix))
 const files=entries.filter(e=>e.kind==='file')
 const partial=result.state!=='complete' || result.truncated
 const logical=files.reduce((sum,e)=>sum+(e.logical??0),0)
 const known=files.reduce((sum,e)=>sum+(e.allocated??0),0)
 const exactFolder=result.relativePath===folder && result.state==='complete' && !result.truncated
 const exact=exactFolder && result.allocatedBytes!=null ? result.allocatedBytes : (partial || entries.some(e=>['link','alias','other'].includes(e.kind)) || files.some(e=>e.allocated===null)) ? null : known
 const floor=exact==null ? Math.max(known,result.relativePath===folder && result.allocatedBytes!=null ? result.allocatedBytes : 0) : exact
 const exactLogical=exactFolder && result.logicalBytes!=null ? result.logicalBytes : logical
 return {logical:partial && exactLogical===0?null:exactLogical,allocated:exact,allocatedAtLeast:floor>0?floor:null,partial}
}
/** The first scan that can size this folder (an explicit measurement before a search scan). */
export function scanSize(results:(InventoryResult|null|undefined)[],folder:string):TalkSize|null {
 let partial:TalkSize|null=null
 for(const r of results){const s=inventoryTalkSize(r,folder);if(!s)continue;if(s.allocated!=null)return s;partial??=s}
 return partial
}
