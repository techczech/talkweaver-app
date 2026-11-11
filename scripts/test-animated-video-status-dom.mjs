import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import {chromium} from 'playwright'
const root=resolve(import.meta.dirname,'..'),scratch=mkdtempSync(join(tmpdir(),'tw-video-status-dom-'))
let browser
try{
 await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{AnimatedVideoStatus,AnimatedVideoChip,useVideoPackageStatuses}from'./src/renderer/src/components/AnimatedVideoStatus.tsx';import{recordingRunKey}from'./src/shared/recording-run-home.ts';import'./src/renderer/src/styles.css';window.calls=[];window.state={state:'none'};window.listener=null;const run={id:'run',talkSlug:'talk',home:'/vault'},runs=[run],key=recordingRunKey(run);window.emit=state=>{window.state=state;window.listener?.({[key]:state})};Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.calls.push(['copy',text])}});window.tw={videoPack:{watch:async inputs=>{window.calls.push(['watch',inputs]);return{[key]:window.state}},unwatch:async()=>window.calls.push(['unwatch']),onStatus:fn=>{window.listener=fn;return()=>window.listener=null},play:async input=>{window.calls.push(['play',input]);return true},reveal:async(input,target)=>{window.calls.push(['finder',input,target]);return true}},shell:{showInFolder:async path=>window.calls.push(['finder',path])}};const reactRoot=createRoot(document.getElementById('root'));window.dispose=()=>reactRoot.unmount();function App(){const states=useVideoPackageStatuses(runs);return <><AnimatedVideoChip status={states[key]}/><AnimatedVideoStatus run={run} status={states[key]}/></>};reactRoot.render(<App/>);`,loader:'tsx',resolveDir:root},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:join(scratch,'test.js'),logLevel:'error'})
 writeFileSync(join(scratch,'test.html'),'<!doctype html><link rel="stylesheet" href="test.css"><div id="root"></div><script src="test.js"></script>')
 browser=await chromium.launch({headless:true,executablePath:process.env.TW_CHROMIUM_HEADLESS_SHELL||undefined});const page=await browser.newPage({reducedMotion:'reduce'});page.setDefaultTimeout(5000);await page.goto(pathToFileURL(join(scratch,'test.html')).href)
 await page.waitForFunction(()=>window.listener!==null)
 assert.equal(await page.getByRole('region',{name:'Animated video'}).count(),0)
 const base={packageId:'run-sections-version',folder:'/vault/talk/video-packs/version',prompt:'Exact package prompt',createdAt:'2026-10-18T12:00:00Z',durationMs:20000,stretch:'Demo'}
 await page.evaluate(state=>window.emit(state),{...base,state:'waiting'})
 await page.getByText('Package made, waiting for the video',{exact:true}).waitFor();assert.equal(await page.getByText('Video pending',{exact:true}).count(),1)
 await page.getByRole('button',{name:'Copy prompt',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),['copy',base.prompt])
 await page.getByRole('button',{name:'Show in Finder',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),['finder',{talkSlug:'talk',sessionId:'run',home:'/vault',packageId:base.packageId},'package'])
 console.log('PASS waiting card/chip, exact prompt, folder reveal')
 const ready={...base,state:'ready',videoPath:base.folder+'/out/final.mp4',lengthMs:61000}
 await page.evaluate(state=>window.emit(state),ready)
 await page.getByText('Animated video ready · 1:01',{exact:true}).waitFor();assert.equal(await page.getByText('Video ready',{exact:true}).count(),1);assert.match(await page.locator('.av-status-card').innerText(),/Made from “Demo”, 18 Oct 2026/)
 await page.getByRole('button',{name:'Play',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),['play',{talkSlug:'talk',sessionId:'run',home:'/vault',packageId:base.packageId}])
 await page.getByRole('button',{name:'Show in Finder',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),['finder',{talkSlug:'talk',sessionId:'run',home:'/vault',packageId:base.packageId},'video'])
 console.log('PASS watcher update changes card/chip; Play carries Run identity, Finder carries package identity')
 await page.evaluate(()=>window.dispose());await page.waitForFunction(()=>window.calls.some(c=>c[0]==='unwatch'));assert.equal(await page.evaluate(()=>window.listener),null)
 console.log('PASS unmount stops the subscription; animated video status DOM: 3 checks')
}finally{await browser?.close();rmSync(scratch,{recursive:true,force:true})}
