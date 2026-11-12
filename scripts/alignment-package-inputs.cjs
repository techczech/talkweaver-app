'use strict'
const {resolve,join,sep}=require('node:path')
const {getMainFileMatchers}=require('app-builder-lib/out/fileMatcher')
/** Evaluate the installed builder's ACTUAL normalised matchers before it copies any bytes.
 * A platform exclusion-only matcher can otherwise implicitly include the entire worktree. */
function assertAlignmentPackageInputs(context){
 const packager=context.packager,info=packager.info,root=resolve(info.appDir)
 const matchers=getMainFileMatchers(root,join(root,'.tw-package-boundary-probe'),s=>s,packager.platformSpecificBuildOptions,packager,resolve(info.projectDir,info.config.directories.output),false)
 const stat={isDirectory:()=>false,isSymbolicLink:()=>false}
 const included=relative=>{const path=join(root,relative);return matchers.some(m=>(path===m.from||path.startsWith(m.from+sep))&&m.createFilter()(path,stat))}
 for(const path of ['src/main/index.ts','docs/design/acceptance.md','scripts/precise-word-timing/local/model_int8.onnx','scripts/precise-word-timing/local/cs/model-int8.onnx','.tw-cut-study/public.wav','.tw-listening-slice2b/sample.wav','.tw-alignment-package/mac-arm64/Electron.app/Contents/MacOS/Electron'])if(included(path))throw Error(`Package source boundary refused: ${path}`)
 for(const path of ['out/main/index.js','out/main/alignment-worker.js','package.json'])if(!included(path))throw Error(`Required app input missing from package: ${path}`)
}
module.exports={assertAlignmentPackageInputs}
