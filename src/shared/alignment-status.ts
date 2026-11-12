export type AlignmentModelRow = { language: string; label: string; bytes?: number; host?: string; state: 'unavailable'|'absent'|'downloading'|'installed'|'failed'; local?: boolean; received?: number; note?: string }
export type AlignmentReply = {ok:true} | {ok:false;error:string}
export type AlignmentRunState = {sessionId:string;home?:string|null;state:'working'|'done'|'failed'|'cancelled';note:string;progress?:number}
