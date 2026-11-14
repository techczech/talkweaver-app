import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync,existsSync,readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {acquireGallerySite} from '../../../src/main/gallery-site.ts'
const fixture=mkdtempSync(join(import.meta.dirname,'cancel-fixture-'))
let pid,current=true
try {
 const executable=join(fixture,'metadata-fixture'),started=join(fixture,'started')
 writeFileSync(executable,`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started+'.tmp')},String(process.pid));fs.renameSync(${JSON.stringify(started+'.tmp')},${JSON.stringify(started)});process.stdin.resume();process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`,{mode:0o700})
 const pending=acquireGallerySite(fixture,['page'],()=>current,executable)
 await new Promise((resolve,reject)=>{const timer=setInterval(()=>{if(existsSync(started)){clearInterval(timer);clearTimeout(limit);resolve()}},10);const limit=setTimeout(()=>{clearInterval(timer);reject(Error('Fixture helper did not start'))},20000)})
 // Renamed into place, so never read half-written: an empty read gave pid 0, and kill(0, 0) signals our own group and always succeeds.
 pid=Number(readFileSync(started,'utf8'));assert.ok(Number.isInteger(pid)&&pid>0,`helper pid ${pid}`);current=false
 await assert.rejects(pending,/Cancelled/)
 // Cancellation awaits the helper's close, so it must already be gone (a zombie would also no longer run); no waiting here.
 // ps exits 1 when no process has that pid; any other failure (ps missing, not permitted) is a broken check, not a stopped process.
 const state=(()=>{try{return execFileSync('ps',['-o','stat=','-p',String(pid)]).toString().trim()}catch(error){if(error.status===1)return 'gone';throw error}})()
 assert.ok(state==='gone'||state.startsWith('Z'),`helper still runs after cancellation: ${state}`)
 console.log('pending metadata cancellation awaits helper exit, including SIGKILL escalation; no live helper remains')
}finally{if(pid){try{process.kill(pid,'SIGKILL')}catch{}}rmSync(fixture,{recursive:true,force:true})}
