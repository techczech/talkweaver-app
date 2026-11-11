import { tmpdir as fixtureTmpdir } from 'node:os'
import assert from 'node:assert/strict'
import {mkdir,mkdtemp,writeFile,symlink,rm,rename,readFile} from 'node:fs/promises'
import {inventoryFilesystem} from '../src/main/vault-gallery-inventory-fs.ts'
import {scanInventory} from '../src/main/vault-gallery-inventory.ts'
import {execFileSync} from 'node:child_process'
if(process.platform!=='darwin'){console.log('SKIP real macOS adapter fixture; portable fake-adapter/authority tests remain registered');process.exit(0)}
const source=new URL('../native/vault-gallery',import.meta.url).pathname
const fixture=await mkdtemp(fixtureTmpdir()+'/tw-gallery-storage-')
try {
 await mkdir(fixture+'/root/empty',{recursive:true});await mkdir(fixture+'/outside')
 await writeFile(fixture+'/root/file', 'fixture bytes');await writeFile(fixture+'/outside/secret','never read')
 await symlink(fixture+'/outside',fixture+'/root/link')
 const fs=inventoryFilesystem(fixture+'/root',source),results=[]
 await scanInventory({vaultId:'fixture',relativePath:'',generation:1,recursive:true,confirmedRoot:true},fs,()=>true,r=>results.push(r))
 const result=results.at(-1)
 console.log(JSON.stringify(result))
 assert.equal(result.state,'partial')
 assert.equal(result.entries.find(e=>e.relativePath==='file').logical,13)
 assert.equal(result.entries.some(e=>e.relativePath.includes('secret')),false)
 assert.equal(result.entries.find(e=>e.relativePath==='link').kind,'link')
 const leaf=inventoryFilesystem(fixture+'/root',source)
 await leaf.identity();await leaf.metadata('file')
 await rename(fixture+'/root/file',fixture+'/root/saved')
 await symlink(fixture+'/outside/secret',fixture+'/root/file')
 await assert.rejects(leaf.metadata('file'),/Path changed/)
 await leaf.close()
 const ancestor=inventoryFilesystem(fixture+'/root',source)
 await ancestor.identity();await ancestor.metadata('empty')
 await rename(fixture+'/root/empty',fixture+'/root/saved-empty')
 await symlink(fixture+'/outside',fixture+'/root/empty')
 await assert.rejects(ancestor.metadata('empty/secret'))
 await ancestor.close()
 await writeFile(fixture+'/root/disguised.pdf','alias fixture')
 execFileSync('/usr/bin/xattr',['-wx','com.apple.FinderInfo','0000000000000000800000000000000000000000000000000000000000000000',fixture+'/root/disguised.pdf'])
 const alias=inventoryFilesystem(fixture+'/root',source)
 await alias.identity();assert.equal((await alias.metadata('disguised.pdf')).kind,'alias');await alias.close()
 const swapped=inventoryFilesystem(fixture+'/root',source);await swapped.identity()
 await rename(fixture+'/root',fixture+'/old-root');await mkdir(fixture+'/root')
 await assert.rejects(swapped.identity(),/stale/);await swapped.close()
 console.log('PASS real allocation, descriptor listing, leaf/ancestor swaps, Finder alias with misleading extension, symlink exclusion, changed root refusal')
} finally {await rm(fixture,{recursive:true,force:true})}
