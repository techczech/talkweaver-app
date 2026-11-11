import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
const base=join(process.cwd(),'scripts/vault-gallery/handouts-completion');const dir=mkdtempSync(join(base,'.dom-'));let browser
process.env.TMPDIR=dir
try {
 await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Sheet from './src/renderer/src/components/vault-gallery/GalleryHandoutSheet';window.calls=[];window.tw={shell:{openExternal:async url=>{window.calls.push(url);return true}}};function App(){const[show,setShow]=useState(false);return <><div><button onClick={()=>setShow(true)}>View handouts</button></div>{show&&<Sheet title="Fixture" value={{status:'published',partial:false,note:null,records:[{key:'one',kind:'talk',title:'Fixture',link:'https://example.org/fixture/',site:'site-missing',publishedAt:'2020-01-02T00:00:00Z',dateSource:'local'}]}} close={()=>setShow(false)}/>}</>};createRoot(document.getElementById('root')).render(<App/>);`},bundle:true,platform:'browser',jsx:'automatic',outfile:join(dir,'bundle.js')})
 browser=await chromium.launch({headless:true,executablePath:process.env.TW_HEADLESS_SHELL});const page=await browser.newPage();await page.setContent('<div id="root"></div>');await page.addScriptTag({path:join(dir,'bundle.js')})
 await page.getByRole('button',{name:'View handouts',exact:true}).click()
 const sheet=page.getByRole('dialog')
 await sheet.waitFor()
 assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Close handouts')
 await page.keyboard.press('Shift+Tab')
 assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Open recorded handout')
 await page.keyboard.press('Tab')
 assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Close handouts')
 await page.getByRole('button',{name:'Open recorded handout'}).click()
 assert.deepEqual(await page.evaluate(()=>window.calls),['https://example.org/fixture/'])
 assert.equal(await sheet.getByText('Recorded addresses are not checked for live availability.').count(),1)
 assert.equal(await sheet.getByText(/Local page modified:/).count(),1)
 assert.equal(await sheet.getByText(/Recorded date:/).count(),0)
 await page.keyboard.press('Escape')
 assert.equal(await sheet.count(),0)
 assert.equal(await page.evaluate(()=>document.activeElement.textContent),'View handouts')
 assert.equal(await page.locator('[inert]').count(),0)
 console.log('PASS sheet focus entry, tab wrapping, allowed opener, recorded-only wording, Escape and focus restoration')
}finally{await browser?.close();rmSync(dir,{recursive:true,force:true})}
