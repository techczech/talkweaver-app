import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
export const shaFile=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
/** Proof identifies working-tree contents too; HEAD alone would omit pending source edits. */
export function sourceIdentity(){
 const paths=['src','native','build','resources/alignment-models','package.json','bun.lock','electron.vite.config.ts','electron.vite.security-test.config.ts','scripts/alignment-package-inputs.cjs','scripts/electron-builder-before-pack.cjs','scripts/sign-mac.cjs','scripts/verify-electron-security.cjs','scripts/test-tiers.json']
 const names=[...new Set(execFileSync('git',['ls-files','-c','-o','--exclude-standard','--',...paths],{encoding:'utf8'}).trim().split('\n').filter(Boolean))].sort()
 const files=Object.fromEntries(names.map(name=>[name,shaFile(name)]))
 return{head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceTreeSHA256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),files:Object.entries(files).map(([path,sha256])=>({path,sha256}))}
}
