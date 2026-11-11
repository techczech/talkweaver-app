import assert from 'node:assert/strict'
import { captureResponseHeaders, CAPTURE_NETWORK_CSP } from '../src/main/capture-network-headers.ts'
const original = { 'content-security-policy': ["default-src 'none'; frame-ancestors 'none'"], 'X-Frame-Options': ['DENY'], 'Cache-Control': ['no-store'], 'alt-svc': ['h3="127.0.0.1:1234"'], 'X-DNS-Prefetch-Control': ['on'] }
const result = captureResponseHeaders(original)
assert.deepEqual(result['content-security-policy'], [...original['content-security-policy'], CAPTURE_NETWORK_CSP])
assert.deepEqual(result['X-Frame-Options'], ['DENY'])
assert.deepEqual(result['Cache-Control'], ['no-store'])
assert.deepEqual(result['Alt-Svc'], ['clear'])
assert.deepEqual(result['X-DNS-Prefetch-Control'], ['off'])
assert.equal(result['alt-svc'], undefined)
assert.deepEqual(original['alt-svc'], ['h3="127.0.0.1:1234"'], 'original response is not mutated')
assert.ok(CAPTURE_NETWORK_CSP.includes("worker-src 'none'"))
assert.ok(CAPTURE_NETWORK_CSP.includes("frame-src 'none'"))
console.log('PASS: capture-only CSP strengthens policy, preserves framing, disables speculative/alternate network channels')
const { containCaptureContents } = await import('../src/main/capture-network.ts')
const commands=[];let onMessage,closed=0,policy
const fake={setWebRTCIPHandlingPolicy:p=>policy=p,getWebRTCIPHandlingPolicy:()=>policy,loadURL:async()=>{},isDestroyed:()=>false,close:()=>closed++,executeJavaScript:async()=>true,debugger:{attach:()=>{},on:(_e,fn)=>onMessage=fn,sendCommand:async(method,args,id)=>{commands.push({method,args,id});return method==='Debugger.setInstrumentationBreakpoint'?{breakpointId:'bp-'+(id||'root')}:{result:{value:true}}}}}
await containCaptureContents(fake)
assert.ok(commands.some(c=>c.method==='Target.setAutoAttach'&&c.args.autoAttach&&c.args.waitForDebuggerOnStart&&c.args.flatten))
for(const type of ['iframe','worker']){
 const id='child-'+type;onMessage({},'Target.attachedToTarget',{sessionId:id,targetInfo:{type}})
 for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r))
 const own=commands.filter(c=>c.id===id)
 assert.ok(own.some(c=>c.method==='Runtime.evaluate'&&c.args.expression.includes('__twCaptureNetworkLocked')))
 assert.ok(own.findIndex(c=>c.method==='Target.setAutoAttach')<own.findIndex(c=>c.method==='Runtime.runIfWaitingForDebugger'))
 if(type==='iframe')assert.ok(own.findIndex(c=>c.method==='Page.addScriptToEvaluateOnNewDocument')<own.findIndex(c=>c.method==='Runtime.runIfWaitingForDebugger'))
}
assert.equal(closed,0)
console.log('PASS: recursive iframe/worker attachment installs the gate before resuming each target')
