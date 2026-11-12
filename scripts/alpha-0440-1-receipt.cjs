'use strict'
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { createRequire } = require('node:module')
const plist = require('plist')
const { machoFiles } = require('./verify-electron-security.cjs')
const app = path.resolve('release/mac-arm64/TalkWeaver.app')
const info = plist.parse(fs.readFileSync(path.join(app,'Contents/Info.plist'),'utf8'))
const targets = [app,...machoFiles(path.join(app,'Contents'))]
const entitlements = targets.map(file => {
 const p = cp.spawnSync('/usr/bin/codesign',['-d','--entitlements',':-',file],{encoding:'utf8'})
 if (p.status !== 0) throw Error(p.stderr)
 const values = p.stdout.trim() ? plist.parse(p.stdout) : {}
 if (file.endsWith('/Helpers/transcription') || file.includes('/node_modules/onnxruntime-node/')) {
  if(Object.keys(values).length)throw Error('Native speech/alignment helper must have no entitlements: '+file)
 }
 return {file:path.relative(app,file)||'.',entitlements:values}
})
const sig=cp.spawnSync('/usr/bin/codesign',['-dvvv',app],{encoding:'utf8'})
if(sig.status)throw Error(sig.stderr)
const receipt={version:info.CFBundleShortVersionString,cdhash:/^CDHash=(.*)$/m.exec(sig.stderr)?.[1],source:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),entitlements}
;(async () => {
 const builderRequire=createRequire(require.resolve('app-builder-lib'))
 const {getCurrentFuseWire,FuseV1Options}=builderRequire('@electron/fuses')
 const wire=await getCurrentFuseWire(app)
 receipt.fuseWireVersion=wire.version
 receipt.fuseWire=wire
 receipt.fuses=Object.fromEntries(Object.entries(FuseV1Options).filter(([,index])=>typeof index==='number' && wire[index]!==undefined).map(([name,index])=>[name,wire[index]===49?'enabled':wire[index]===48?'disabled':`state ${wire[index]}`]))
 fs.writeFileSync('evidence/alpha-0440-1/package-receipt.json',JSON.stringify(receipt,null,2)+'\n')
 console.log(JSON.stringify({version:receipt.version,cdhash:receipt.cdhash,macho:targets.length-1,fuses:receipt.fuses,nativePolicy:'present speech/alignment binaries have no entitlements'}))
})().catch(error=>{console.error(error.message);process.exitCode=1})
