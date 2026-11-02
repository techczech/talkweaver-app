import { constants, existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { galleryChildLifetime } from './vault-gallery-child.ts';
import { spawn } from 'node:child_process';
import { relative, isAbsolute, resolve } from 'node:path';
/** Acquisition is descriptor-relative in the bundled helper. Acquired reads may finish after a move. */
export async function readGallerySource(root: string, file: string, current: () => boolean, expectedRoot?: {dev:number; ino:number}, executable = resolve('native/vault-gallery'), marker?:string) {
  if (process.platform !== 'darwin') throw new Error('Safe gallery reads require macOS');
  const path = relative(root,file);
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path) || !current()) throw new Error('Unavailable gallery source');
  const fd = await open(root,constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
  try {
    const pinned = await fd.stat();
    if (expectedRoot && (!Number.isSafeInteger(expectedRoot.dev) || !Number.isSafeInteger(expectedRoot.ino))) throw new Error('Gallery root identity exceeds safe integer precision');
    if (expectedRoot && (expectedRoot.dev !== pinned.dev || expectedRoot.ino !== pinned.ino)) throw new Error('Gallery root replaced');
    if (!current()) throw new Error('Gallery read cancelled');
    const child = spawn(executable,[root,`${pinned.dev}:${pinned.ino}`,'--source',...(marker ? [marker] : [])],{stdio:['pipe','pipe','pipe']});
    const lifetime = galleryChildLifetime(child,()=>current() && (!marker || existsSync(marker)),Date.now()+10000);
    const chunks:Buffer[]=[];let length=0,failed=false;
    child.stdout.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>32*1024*1024){failed=true;lifetime.stop()}else chunks.push(chunk)});
    child.stderr.resume();
    child.on('error',()=>{failed=true});child.stdin.on('error',()=>{failed=true;lifetime.stop()});
    child.stdin.end(JSON.stringify({id:1,op:'source',path})+'\n');
    await lifetime.done;
    if(lifetime.stopped || failed || child.exitCode!==0 || !current() || (marker && !existsSync(marker)))throw Error('Gallery source helper unavailable or cancelled');
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (result.error) throw new Error(result.error);
    const now = await stat(root);
    if (!current() || now.dev !== pinned.dev || now.ino !== pinned.ino) throw new Error('Gallery root changed');
    return {data:Buffer.from(result.value.data,'base64'),text:result.value.text as string, stat:result.value as {dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number}};
  } finally {await fd.close()}
}
