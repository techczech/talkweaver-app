import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync,existsSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {acquireGallerySite} from '../../../src/main/gallery-site.ts'
const fixture=mkdtempSync(join(import.meta.dirname,'cancel-fixture-'))
let pid,current=true
try {
 const executable=join(fixture,'metadata-fixture'),started=join(fixture,'started')
 writeFileSync(executable,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(started)},String(process.pid));process.stdin.resume();process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`,{mode:0o700})
 const pending=acquireGallerySite(fixture,['page'],()=>current,executable)
 await new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(existsSync(started)){clearInterval(timer);clearTimeout(limit);resolve()}},10);const limit=setTimeout(()=>{clearInterval(timer);reject(Error('Fixture helper did not start'))},1000)})
 pid=Number(readFileSync(started,'utf8'));current=false
 await assert.rejects(pending,/Cancelled/)
 assert.throws(()=>process.kill(pid,0),/ESRCH/)
 console.log('pending metadata cancellation awaits helper exit, including SIGKILL escalation; no live helper remains')
}finally{if(pid){try{process.kill(pid,'SIGKILL')}catch{}}rmSync(fixture,{recursive:true,force:true})}
