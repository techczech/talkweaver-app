import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url),scratch=mkdtempSync(join(process.cwd(),'.tw-alignment-settings-'))
const dom=new JSDOM('<div id="fixture"></div><div class="bsw-root" data-section="recording"><div class="bsw-pscroll"><div class="recording-settings-page"><button>Check devices</button></div></div></div>')
try{
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true})
 const React=require('react'),{createRoot}=require('react-dom/client')
 dom.window.tw={alignment:{onModels:()=>()=>{},models:async()=>[{language:'en',label:'English',state:'unavailable',note:'not available on Windows yet'}]}}
 const output=join(scratch,'component.cjs')
 await build({entryPoints:['src/renderer/src/components/PreciseWordTimingSettings.tsx'],outfile:output,bundle:true,platform:'node',format:'cjs',external:['react','react-dom']})
 const Component=require(output).default,root=createRoot(document.querySelector('#fixture'))
 await React.act(async()=>{root.render(React.createElement(Component,{language:'en-US'}));await new Promise(r=>setTimeout(r,0))})
 assert.match(document.querySelector('.recording-settings-page').textContent,/Precise word timing/)
 assert.ok(document.querySelector('.recording-settings-page button'),'main device controls retained')
 assert.match(document.querySelector('[data-precise-word-timing]').textContent,/not available on Windows yet/)
 await React.act(async()=>{document.querySelector('.bsw-root').setAttribute('data-section','general');await new Promise(r=>setTimeout(r,0))})
 assert.equal(document.querySelector('[data-precise-word-timing]'),null)
 await React.act(async()=>root.unmount())
 console.log('PASS precise timing mounts beside main recording controls, shows unavailable status and leaves other panes')
}finally{dom.window.close();rmSync(scratch,{recursive:true,force:true})}
