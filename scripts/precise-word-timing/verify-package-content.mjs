import assert from 'node:assert/strict'
import { readdirSync,existsSync,readFileSync,statSync } from 'node:fs'
import { join,resolve } from 'node:path'
const bundle=resolve(process.argv[2]),resources=join(bundle,'Contents','Resources'),app=join(resources,'app')
assert.deepEqual(readdirSync(app).sort(),['node_modules','out','package.json'],'Only the app allowlist and production dependencies are packaged')
const modelFiles=[]
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())walk(path);else if(e.isFile() && /\.(onnx|safetensors|flac|wav)$/i.test(e.name))modelFiles.push(path)}}
walk(resources);assert.deepEqual(modelFiles,[],'No model weights or corpus FLAC may enter the package')
const bin=join(app,'node_modules/onnxruntime-node/bin/napi-v6')
assert.ok(existsSync(join(bin,'darwin/arm64/onnxruntime_binding.node')))
assert.ok(existsSync(join(bin,'darwin/arm64/libonnxruntime.1.31.1.dylib')))
for(const path of ['linux','win32','darwin/x64'])assert.equal(existsSync(join(bin,path)),false,`Unneeded ${path} binary excluded`)
for(const lang of ['en','cs'])assert.deepEqual(JSON.parse(readFileSync(join(resources,'alignment-models',lang+'.json'),'utf8')),JSON.parse(readFileSync(resolve('resources/alignment-models',lang+'.json'),'utf8')))
assert.ok(existsSync(join(resources,'alignment-models/Apache-2.0.txt')))
for(const name of ['ORT-LICENSE.txt','ORT-ThirdPartyNotices.txt','runtime-licences.json'])assert.deepEqual(readFileSync(join(resources,'alignment-models',name)),readFileSync(resolve('resources/alignment-models',name)))
console.log('PASS packaged runtime/manifest/licence present, other-platform binaries excluded, no model weights or corpus audio')
