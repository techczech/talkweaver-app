// Extract the production authority checks; only the registered fixture vaults/catalogue are supplied.
import assert from 'node:assert/strict'
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import ts from 'typescript'
import { readTalkOutline } from '../../src/main/talk-writer.ts'
import { readGallerySource } from '../../src/main/vault-gallery-read.ts'
export function runPublicationFixture(sourceText, repo, vaults, talks) {
  const source=ts.createSourceFile('index.ts',sourceText,ts.ScriptTarget.Latest,true)
  const names=['verifiedRunSource','qualifiedRunTalk','runPublicationAuthority']
  const declarations=source.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))
  assert.equal(declarations.length,names.length)
  const state={unavailable:new Set(),writable:true}
  const dependencies={
    vaultRegistry:{list:vaults,get:id=>vaults().find(v=>v.id===id)},
    vaultAvailability:{isUnavailable:id=>state.unavailable.has(id)},
    writableRootFor:path=>state.writable?vaults().find(v=>v.open&&existsSync(v.root)&&path?.startsWith(v.root+sep))?.root:undefined,
    app:{isPackaged:false,getAppPath:()=>repo},readGallerySource,findTalks:talks,
    outlineRefused:path=>vaults().some(v=>v.open&&path.startsWith(realpathSync(v.root)+sep)&&realpathSync(path).startsWith(realpathSync(v.root)+sep))?null:'refused',
    readTalkOutline,statSync,lstatSync,realpathSync,basename,join,relative,
  }
  const js=ts.transpileModule(declarations.map(n=>n.getText(source)).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
  return {...Function(...Object.keys(dependencies),`${js}\nreturn {runPublicationAuthority,qualifiedRunTalk}`)(...Object.values(dependencies)),state}
}
