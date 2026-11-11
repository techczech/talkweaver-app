import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {resolve} from 'node:path'
import {configureTalkWriter,writeTalkOutline,withTalkFileLock,writeTalkFileInPlace} from '../../../src/main/talk-writer.ts'
const root=resolve('scripts/vault-gallery/ownership-repairs/writer-fixture');mkdirSync(root,{recursive:true});const path=resolve(root,'outline.md');
try {
 writeFileSync(path,'# Original');configureTalkWriter({editorBufferFor:()=>null});
 let release,entered;const ready=new Promise(r=>entered=r);const lock=withTalkFileLock(path,async()=>{entered();await new Promise(r=>release=r)});await ready;
 let valid=true;const pending=writeTalkOutline(path,'# Unsafe','editor',{authorize:()=>{if(!valid)throw Error('revoked')}});valid=false;release();await lock;
 const result=await pending;assert.equal(result.ok,false);assert.equal(result.untouched,true);assert.equal(readFileSync(path,'utf8'),'# Original');
 await assert.rejects(writeTalkFileInPlace(path,'# Unsafe',{authorize:()=>{throw Error('revoked after staging')}}));assert.equal(readFileSync(path,'utf8'),'# Original');
 const good=await writeTalkOutline(path,'# Safe','editor',{authorize:()=>{}});assert.equal(good.ok,true);assert.equal(readFileSync(path,'utf8'),'# Safe');
 console.log('PASS locked revocation and final staged authority preserve original; authorised control writes');
} finally {rmSync(root,{recursive:true,force:true})}
