import type { ChildProcess } from 'node:child_process'
/** A request owns its child until close, including after cancellation or protocol failure. */
export function galleryChildLifetime(child:ChildProcess,current:()=>boolean,deadline:number) {
 let exited=false,stopped=false, escalation:ReturnType<typeof setTimeout>|undefined
 const stop=()=>{if(exited)return;stopped=true;child.kill('SIGTERM');escalation ??= setTimeout(()=>{if(!exited)child.kill('SIGKILL')},250)}
 const done=new Promise<void>(resolve=>child.once('close',()=>{exited=true;clearInterval(poll);clearTimeout(timer);if(escalation)clearTimeout(escalation);resolve()}))
 const check=()=>{try{if(!current())stop()}catch{stop()}}
 const poll=setInterval(check,25)
 const timer=setTimeout(stop,Math.max(0,deadline-Date.now()))
 check()
 return {stop,done,get stopped(){return stopped}}
}
