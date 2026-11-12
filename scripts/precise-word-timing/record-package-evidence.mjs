import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { resolve,join } from 'node:path'
import { sourceIdentity,shaFile } from './source-identity.mjs'
const require=createRequire(import.meta.url),{verify,machoFiles}=require('../verify-electron-security.cjs'),bundle=resolve(process.argv[2])
await verify(bundle)
const app=join(bundle,'Contents/Resources/app'),runtime=join(app,'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64')
const record={status:'PASS production package policy gate',flavour:'signed unpublished production directory package; no release archive or installation',source:sourceIdentity(),machoBinaries:machoFiles(join(bundle,'Contents')).length,team:'M7H45AGG8A',helperEntitlements:'allow-jit only (native standalone tools may have none)',engineRequiresRunAsNode:false,retainedExistingExceptions:'RunAsNode and loose app/ASAR, as documented in docs/security-hardening.md; this is not the --require-full gate',compiledWorkerSHA256:shaFile(join(app,'out/main/alignment-worker.js')),bindingSHA256:shaFile(join(runtime,'onnxruntime_binding.node')),runtimeDylibSHA256:shaFile(join(runtime,'libonnxruntime.1.31.1.dylib'))}
writeFileSync(resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2b/package-security-evidence.json'),JSON.stringify(record,null,2)+'\n')
