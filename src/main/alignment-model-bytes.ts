import { openSync,readSync,closeSync,fstatSync,lstatSync,constants } from 'node:fs'
import { createHash } from 'node:crypto'
/** Verify the exact bounded buffer ORT will parse. Never hand ORT a checked pathname to reopen. */
export function verifiedModelBytes(path:string,sha256:string,bytes:number):Buffer {
  if(!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes<1 || bytes>2_000_000_000)throw Error('Invalid model identity')
  if(!lstatSync(path).isFile())throw Error('Model is not a regular file')
  const fd=openSync(path,constants.O_RDONLY | (constants.O_NOFOLLOW??0))
  let buffer:Buffer
  try {
    const stat=fstatSync(fd);if(!stat.isFile() || stat.size!==bytes)throw Error('Model size mismatch')
    buffer=Buffer.allocUnsafe(bytes)
    let offset=0
    while(offset<bytes){const n=readSync(fd,buffer,offset,Math.min(1024*1024,bytes-offset),offset);if(!n)throw Error('Truncated model');offset+=n}
    if(fstatSync(fd).size!==bytes)throw Error('Model changed while reading')
  }finally{closeSync(fd)}
  if(createHash('sha256').update(buffer).digest('hex')!==sha256)throw Error('Model checksum mismatch')
  return buffer
}
