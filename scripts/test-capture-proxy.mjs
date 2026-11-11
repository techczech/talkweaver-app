import assert from 'node:assert/strict'
import { request } from 'node:http'
import { connect } from 'node:net'
import { captureDestination, createCaptureProxy } from '../src/main/capture-proxy.ts'
for (const host of ['127.0.0.1','0x7f.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','224.0.0.1','::1','fc00::1','fe80::1','ff02::1','::ffff:127.0.0.1']) assert.equal(await captureDestination(host,443,{}),null,host)
assert.equal(await captureDestination('example.org',443,{},async()=>['8.8.8.8','127.0.0.1']),null)
assert.equal(await captureDestination('example.org',443,{},async()=>[]),null)
let resolves=0
assert.equal(await captureDestination('public.example',443,{},async()=>{resolves++;return ['8.8.8.8']}),'8.8.8.8')
assert.equal(resolves,1,'the result is the vetted IP, never a name to resolve again at connect')
assert.equal(await captureDestination('8.8.8.8',443,{denyAll:true}),null)
for (const opts of [{},{denyAll:true}]) {
 const proxy=await createCaptureProxy(opts)
 try {
  const url=new URL(proxy.url)
  const status=await new Promise((resolve,reject)=>{const r=request({hostname:url.hostname,port:url.port,path:'http://127.0.0.1:9/',headers:{host:'127.0.0.1:9'}},res=>{res.resume();resolve(res.statusCode)});r.on('error',reject);r.end()})
  assert.equal(status,403)
  const connectStatus=await new Promise((resolve,reject)=>{const s=connect(Number(url.port),url.hostname,()=>s.write('CONNECT [::1]:443 HTTP/1.1\r\nHost: [::1]:443\r\n\r\n'));s.on('data',d=>{resolve(d.toString().split('\r\n')[0]);s.destroy()});s.on('error',reject)})
  assert.match(connectStatus,/403/)
 }finally{proxy.close()}
}
console.log('PASS: capture proxy denies private/CGNAT/multicast/IPv6 and mixed DNS, pins public IP, refuses HTTP/CONNECT and deny-all traffic')
const { containCaptureSession }=await import('../src/main/capture-network.ts')
let configuration,connectionsClosed=0,headerHandler
const release=await containCaptureSession({setProxy:async config=>configuration=config,closeAllConnections:async()=>connectionsClosed++,webRequest:{onHeadersReceived:(_filter,fn)=>headerHandler=fn}},{denyAll:true})
try{
 assert.equal(configuration.mode,'fixed_servers')
 assert.match(configuration.proxyRules,/^http:\/\/127\.0\.0\.1:\d+$/)
 assert.equal(configuration.proxyBypassRules,'<-loopback>','remove Chromium implicit loopback bypass')
 assert.equal(connectionsClosed,1,'pre-proxy connections cannot be reused')
 assert.equal(typeof headerHandler,'function')
}finally{release()}
console.log('PASS: session fixed proxy has no DIRECT fallback or implicit loopback bypass, closes old connections')
