import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root=resolve(import.meta.dirname,'..'), scratch=mkdtempSync(join(tmpdir(),'tw-video-sheet-'))
const shotAt=process.argv.indexOf('--screenshots'), shots=shotAt<0?null:resolve(process.argv[shotAt+1])
let browser
try {
  await build({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'
import {AnimatedVideoAction} from './src/renderer/src/components/AnimatedVideoSheet.tsx'
import {useVideoMenuRequest} from './src/renderer/src/lib/toolsActions.ts'
import './src/renderer/src/styles.css'
import './src/renderer/src/studio.css'
window.legacy=false; window.trims=[]; window.calls=[]; window.wordStatusFixture={ok:true,hasWords:true,canTranscribe:true,ffmpegFound:true}; window.pending=null; window.progress=null
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.calls.push(['copy',text])}})
window.tw={videoPack:{wordStatus:async input=>{window.calls.push(['status',input]);return window.wordStatusFixture},make:input=>{window.calls.push(['make',input]);return new Promise(resolve=>window.pending=resolve)},cancel:async()=>{window.calls.push(['cancel']);window.pending?.({ok:false,error:'Package cancelled.'})},onProgress:fn=>{window.progress=fn;return()=>window.progress=null}},shell:{showInFolder:async folder=>window.calls.push(['finder',folder])},settingsWindow:{open:async page=>window.calls.push(['settings',page])}}
const slides={a:{title:'Opening slide',section:'Opening',tag:'bullets',thumbUrl:null},b:{title:'Code slide',section:'Demo',tag:'code',thumbUrl:null},c:{title:'Pictures slide',section:'Demo',tag:'image-grid',thumbUrl:null}}
const base={id:'run',talkSlug:'talk',talkTitle:'A real recorded talk',home:'/secondary-vault',startedAt:'2026-10-18T12:00:00Z',recordingMs:30000,wallClockMs:30000,slideTimeIndex:[{event:'enter',slideId:'a',tMs:0},{event:'enter',slideId:'b',tMs:10000},{event:'enter',slideId:'c',tMs:20000}],audio:{segments:[{startMs:0,endMs:9000},{startMs:12000,endMs:30000}]}}
function App(){const [audio,setAudio]=React.useState(true),[key,setKey]=React.useState(0),[show,setShow]=React.useState(true),[runId,setRunId]=React.useState('run'),[request,setRequest]=React.useState(null);const registered=React.useCallback(()=>setRequest(null),[]);const [videoRequest,clearVideoRequest]=useVideoMenuRequest(request,show?{...base,id:runId}:null,registered);window.requestVideo=()=>setRequest(n=>(n??0)+1);window.switchRun=()=>{window.loading=false;setRunId('run-b');setAudio(true);setKey(k=>k+1)};window.fixture=(value)=>{setAudio(value);setKey(k=>k+1);setShow(true)};window.unmount=()=>setShow(false);return <div><h1>Studio</h1><div className="tws-ts-head" style={{width:296,boxSizing:'border-box'}}><span className="tws-p-title">Transcript</span><button className="tws-ts-retry">Manage notes</button>{show?<AnimatedVideoAction key={key} run={{...base,id:runId,trims:window.trims,audio:audio?(window.legacy?{...base.audio,segments:[{startMs:0,endMs:0}]}:base.audio):null}} videoRequest={videoRequest} onVideoRequestHandled={clearVideoRequest} slides={window.loading?{}:slides} onShowTalkFolder={async()=>window.calls.push(['talkFolder'])}/>:null}<button className="tws-ts-retry">Re-transcribe</button></div></div>}
createRoot(document.getElementById('root')).render(<App/>)`,resolveDir:root,loader:'tsx',sourcefile:'video-sheet-dom.tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:join(scratch,'test.js'),logLevel:'error'})
  writeFileSync(join(scratch,'test.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="test.css"><div id="root"></div><script src="test.js"></script>')
  browser=await chromium.launch({headless:true,executablePath:process.env.TW_CHROMIUM_HEADLESS_SHELL||undefined})
  const page=await browser.newPage({viewport:{width:1100,height:900},reducedMotion:'reduce'})
  page.setDefaultTimeout(6000)
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto(pathToFileURL(join(scratch,'test.html')).href)
  const button=name=>page.getByRole('button',{name,exact:true})
  const open=async()=>{await button('Animated video…').click();await button('Make package').waitFor()}
  const reset=async(status={ok:true,hasWords:true,canTranscribe:true,ffmpegFound:true},audio=true)=>{await page.evaluate(({status,audio})=>{window.wordStatusFixture=status;window.calls=[];window.fixture(audio)},{status,audio});await page.getByRole('dialog').waitFor({state:'detached'})}
  const calls=()=>page.evaluate(()=>window.calls)
  const shot=async name=>{if(shots){mkdirSync(shots,{recursive:true});await page.screenshot({path:join(shots,name+'.png')})}}
  let checks=0
  const test=async(name,fn)=>{await fn();checks++;console.log('PASS '+name)}
  await test('narrow Studio header keeps actions inside the transcript column',async()=>{assert.equal(await page.locator('.tws-ts-head').evaluate(el=>el.scrollWidth<=el.clientWidth),true);const boxes=await page.locator('.tws-ts-head button').evaluateAll(buttons=>buttons.map(b=>({width:b.clientWidth,scroll:b.scrollWidth})));assert.ok(boxes.every(b=>b.scroll<=b.width))})
  await test('Run without audio refuses the action with its reason',async()=>{await reset(undefined,false);assert.equal(await button('Animated video…').isDisabled(),true);assert.equal(await button('Animated video…').getAttribute('title'),'This Run has no audio.');await reset()})
  await test('whole Run: real duration, default treatment and gap; selected home is forwarded',async()=>{await open();await page.getByText('Ready',{exact:true}).waitFor();assert.equal(await page.locator('.av-slide').count(),3);assert.equal(await page.getByRole('group',{name:'Treatment for Opening slide'}).getByRole('button',{name:'Animate',exact:true}).getAttribute('aria-pressed'),'true');for(const name of ['Code slide','Pictures slide'])assert.equal(await page.getByRole('group',{name:'Treatment for '+name}).getByRole('button',{name:'Keep as slide',exact:true}).getAttribute('aria-pressed'),'true');assert.match(await page.locator('.pr-foot-note').innerText(),/0:30 · 3 slides · 1 animated, 2 kept/);assert.match(await page.locator('.av-gap').innerText(),/0:09 to 0:12/);assert.equal((await calls()).find(c=>c[0]==='status')[1].home,'/secondary-vault');await shot('whole-run')})
  await test('choose sections recomputes list and duration; exact choices reach make',async()=>{await button('Choose sections').click();assert.equal(await button('Make package').isDisabled(),true);await page.getByLabel('Demo',{exact:false}).check();assert.equal(await page.locator('.av-slide').count(),2);assert.match(await page.locator('.pr-foot-note').innerText(),/0:20 · 2 slides/);await page.getByRole('group',{name:'Treatment for Code slide'}).getByRole('button',{name:'Animate',exact:true}).click();await shot('chosen-section');await button('Make package').click();assert.deepEqual((await calls()).find(c=>c[0]==='make')[1],{talkSlug:'talk',sessionId:'run',home:'/secondary-vault',sections:['Demo'],animate:{b:'animate',c:'keep'}});await page.evaluate(()=>window.progress({step:'words'}));await page.waitForFunction(()=>document.querySelector('.pr-foot-note')?.textContent==='Step 2 of 4');await shot('progress');await button('Cancel').click();await page.getByRole('dialog').waitFor({state:'detached'});assert.equal((await calls()).filter(c=>c[0]==='cancel').length,1)})
  await test('missing transcription disables make and opens the right settings',async()=>{await reset({ok:true,hasWords:false,canTranscribe:false,ffmpegFound:true});await open();await page.getByText(/No transcription set up/).waitFor();assert.equal(await button('Make package').isDisabled(),true);await button('Set one up in Settings → Transcription').click();assert.deepEqual((await calls()).at(-1),['settings','transcription']);await shot('no-transcription');await button('Cancel').click()})
  await test('write error retry, exact prompt copy and Finder target',async()=>{await reset();await open();await page.getByText('Ready',{exact:true}).waitFor();await button('Make package').click();await page.evaluate(()=>window.pending({ok:false,error:'The disk is full.'}));await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/disk is full/);await button('Show talk folder').click();assert.deepEqual((await calls()).at(-1),['talkFolder']);await shot('write-error');await button('Try again').click();await page.evaluate(()=>window.pending({ok:true,folder:'/secondary-vault/talk/video-packs/new-version',prompt:'Exact PROMPT.md\nUse the recorded voice.',durationMs:30000}));await button('Copy prompt for your agent').waitFor();await button('Copy prompt for your agent').click();assert.deepEqual((await calls()).at(-1),['copy','Exact PROMPT.md\nUse the recorded voice.']);await button('Show in Finder').click();assert.deepEqual((await calls()).at(-1),['finder','/secondary-vault/talk/video-packs/new-version']);await shot('done');await button('Close').click();assert.equal(await button('Animated video…').evaluate(el=>el===document.activeElement),true)})
  await test('legacy unknown segment timing never invents a gap',async()=>{await page.evaluate(()=>window.legacy=true);await reset();await open();await page.getByText('Ready',{exact:true}).waitFor();assert.equal(await page.locator('.av-gap').count(),0);assert.equal(await button('Make package').isEnabled(),true);await button('Cancel').click();await page.evaluate(()=>window.legacy=false)})
  await test('saved trims update whole duration, section lengths and per-slide time',async()=>{await page.evaluate(()=>window.trims=[{start:0,end:10000},{start:15000,end:17000}]);await reset();await open();await page.getByText('Ready',{exact:true}).waitFor();assert.match(await page.locator('.pr-foot-note').innerText(),/0:18 · 2 slides/);assert.equal(await button('Whole Run · 0:18').count(),1);assert.equal(await page.locator('.av-slide').count(),2);assert.match(await page.locator('.av-slide').first().innerText(),/Code · 0:08/);assert.match(await page.locator('.av-sections label').filter({hasText:'Demo'}).innerText(),/0:18/);await button('Cancel').click();await page.evaluate(()=>window.trims=[])})
  await test('focus stays in modal; unmount cancels its own busy operation',async()=>{await reset();await open();await page.getByText('Ready',{exact:true}).waitFor();await button('Make package').focus();await page.keyboard.press('Tab');assert.equal(await button('Whole Run · 0:30').evaluate(el=>el===document.activeElement),true);await button('Make package').click();await page.evaluate(()=>window.unmount());await page.waitForFunction(()=>window.calls.some(c=>c[0]==='cancel'));assert.equal((await calls()).filter(c=>c[0]==='cancel').length,1)})
  await test('small viewport and reduced motion keep all actions reachable',async()=>{await reset();await page.setViewportSize({width:600,height:620});await open();await page.getByText('Ready',{exact:true}).waitFor();assert.equal(await button('Make package').isEnabled(),true);assert.equal(await page.getByRole('dialog').evaluate(el=>el.getBoundingClientRect().right<=innerWidth && el.getBoundingClientRect().bottom<=innerHeight),true);await button('Cancel').click();assert.deepEqual(errors,[])})
  await test('pending video for loading A is cancelled when selection becomes ready B',async()=>{
    await reset()
    await page.evaluate(()=>{window.loading=true;window.fixture(true)})
    await page.waitForFunction(()=>document.querySelector('button[title="The slides are still loading."]')?.disabled)
    await page.evaluate(()=>window.requestVideo())
    await page.evaluate(()=>window.switchRun())
    await page.waitForFunction(()=>!document.querySelector('button[title="The slides are still loading."]'))
    assert.equal(await page.getByRole('dialog').count(),0)
    await open();await page.getByText('Ready',{exact:true}).waitFor()
    assert.equal((await calls()).filter(c=>c[0]==='status').at(-1)[1].sessionId,'run-b')
    await button('Cancel').click()
  })
  await test('native menu request waits for Studio action registration',async()=>{
    await reset(undefined,false)
    await page.waitForFunction(()=>document.querySelector('button[title="This Run has no audio."]')?.disabled)
    await page.evaluate(()=>window.requestVideo())
    await page.evaluate(()=>window.fixture(true))
    await page.getByRole('dialog').waitFor()
    await page.getByRole('button',{name:'Cancel',exact:true}).click()
  })
  await test('pending request is discarded when Studio unmounts',async()=>{
    await reset(undefined,false)
    await page.waitForFunction(()=>document.querySelector('button[title="This Run has no audio."]')?.disabled)
    await page.evaluate(()=>window.requestVideo())
    await page.evaluate(()=>window.unmount())
    await page.waitForFunction(()=>!document.querySelector('.tws-ts-head button[title="This Run has no audio."]'))
    await page.evaluate(()=>window.fixture(true))
    await page.getByRole('button',{name:'Animated video…',exact:true}).waitFor()
    assert.equal(await page.getByRole('dialog').count(),0)
  })
  console.log(`PASS animated video sheet: ${checks} checks`)
} finally {await browser?.close();rmSync(scratch,{recursive:true,force:true})}
