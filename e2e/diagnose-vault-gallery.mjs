// Hidden source Electron; every runtime write is confined to the integration fixture.
import assert from 'node:assert/strict'
import {_electron as electron} from 'playwright'
import {mkdirSync,mkdtempSync,cpSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {resolve,join} from 'node:path'
const repo=resolve('.'),evidence=join(repo,'evidence/vault-gallery/redesign-repairs/e2e')
mkdirSync(evidence,{recursive:true})
const fixture=mkdtempSync(join(evidence,'fixture-')),vault=join(fixture,'vault'),userData=join(fixture,'userData'),home=join(fixture,'home')
let app
const results=[]
const pass=name=>{results.push(name);console.log('PASS '+name)}
try {
 for(const path of [userData,home,join(fixture,'tmp'),join(fixture,'trash')])mkdirSync(path,{recursive:true})
 cpSync(join(repo,'e2e/fixtures/slide-set-aside'),join(vault,'target'),{recursive:true})
 writeFileSync(join(userData,'config.json'),JSON.stringify({vaultRoot:vault,editorViewMode:'markdown'}))
 assert.equal(JSON.parse(readFileSync(join(userData,'config.json'))).vaultRoot,vault)
 const env={...process.env,HOME:home,TMPDIR:join(fixture,'tmp'),NODE_COMPILE_CACHE:join(fixture,'compile-cache'),TW_E2E:'1',TW_REC_TEST:'1',TW_E2E_TRASH_DIR:join(fixture,'trash')};delete env.ELECTRON_RUN_AS_NODE
 app=await electron.launch({args:['.',`--user-data-dir=${userData}`,'--use-mock-keychain'],cwd:repo,env})
 assert.equal(await app.evaluate(({app})=>app.getPath('userData')),userData);assert(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())));pass('fixture config confirmed before launch; actual userData path and hidden windows confirmed')
 const page=await app.firstWindow();await page.locator('.vault-gallery-entry').waitFor()
 const menuEntry=await app.evaluate(({Menu})=>{const find=items=>{for(const item of items){if(item.label==='Vault Gallery')return item;const nested=item.submenu&&find(item.submenu.items);if(nested)return nested}};const item=find(Menu.getApplicationMenu().items);if(!item)return false;item.click();return true});assert(menuEntry);await page.getByRole('dialog',{name:'Vault Gallery',exact:true}).waitFor();await page.getByRole('button',{name:'Return to talk'}).click();pass('actual registry-derived native menu opens gallery before a talk is selected')
 await page.locator('[data-talk-slug="target"]').first().dblclick();await page.locator('.cm-content').waitFor()
 await page.locator('.cm-content').click();await page.keyboard.press('Meta+End');await page.keyboard.type(' gallery continuity');await page.keyboard.press('Shift+ArrowLeft');await page.keyboard.press('Shift+ArrowLeft')
 const before=await page.locator('.cm-content').evaluate(el=>{window.galleryEditor=el;const selection=getSelection();return {text:el.textContent,anchor:selection.anchorOffset,focus:selection.focusOffset,scroll:el.closest('.cm-scroller').scrollTop}})
 await page.evaluate(()=>window.dispatchEvent(new Event('tw-vault-gallery')));await page.getByRole('dialog',{name:'Vault Gallery',exact:true}).waitFor();await page.getByRole('button',{name:'Show all talks'}).waitFor()
 await page.getByRole('button',{name:'Return to talk'}).click()
 await page.evaluate(()=>new Promise(requestAnimationFrame))
 const after=await page.locator('.cm-content').evaluate(el=>({same:el===window.galleryEditor,text:el.textContent,scroll:el.closest('.cm-scroller').scrollTop,selection:[getSelection().anchorOffset,getSelection().focusOffset]}))
 assert(after.same);assert.equal(after.text,before.text);assert.equal(after.scroll,before.scroll);assert.deepEqual(after.selection,[before.anchor,before.focus]);pass('real CodeMirror node, edited text and scroll survive gallery roundtrip')
 await page.evaluate(()=>window.dispatchEvent(new Event('tw-vault-gallery')));await page.getByRole('button',{name:'Show all talks'}).waitFor()
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:join(evidence,'electron-overview-1440.png')})
 const gallery=page.getByRole('dialog',{name:'Vault Gallery',exact:true}),bar=gallery.getByRole('toolbar',{name:'Actions'})
 await page.getByRole('button',{name:'Show all talks'}).click();const rows=gallery.getByRole('grid',{name:'Talks and folders'}).locator('.vg-row[data-identity]');await rows.first().waitFor();await page.screenshot({path:join(evidence,'electron-list-1440.png')})
 await rows.first().click();await bar.getByRole('button',{name:'Details',exact:true}).click();await gallery.getByRole('complementary',{name:'Details'}).waitFor();await page.screenshot({path:join(evidence,'electron-details-1440.png')})
 await bar.getByRole('button',{name:'Handouts',exact:true}).click();await page.getByRole('dialog',{name:/Published handouts:/}).waitFor();await page.screenshot({path:join(evidence,'electron-handouts-1440.png')});await page.getByRole('button',{name:'Close handouts'}).click();pass('real selected-talk Details and publication-status sheet open and close')
 await page.keyboard.press('Escape');await bar.getByRole('button',{name:'New folder',exact:true}).click();await page.screenshot({path:join(evidence,'electron-management-1440.png')});await page.getByRole('button',{name:'Cancel',exact:true}).click();pass('existing new-folder dialog cancellation returns to gallery')
 await gallery.getByRole('button',{name:'Gallery',exact:true}).click();await gallery.getByRole('listbox',{name:'Talks and folders'}).waitFor();await page.screenshot({path:join(evidence,'electron-gallery-1440.png')});await gallery.getByRole('button',{name:'List',exact:true}).click()
 await page.setViewportSize({width:390,height:844});assert(await page.locator('.vault-gallery').evaluate(el=>el.scrollWidth<=el.clientWidth));await page.screenshot({path:join(evidence,'electron-list-390.png')});pass('actual Electron overview, List, Gallery; 390px has no gallery overflow')

 await page.setViewportSize({width:1440,height:1000})
 await bar.getByRole('button',{name:'New folder',exact:true}).click()
 const prompt=page.getByRole('dialog',{name:/New folder in/});await prompt.locator('input').fill('Integration folder');await prompt.getByRole('button',{name:'Create',exact:true}).click()
 await bar.getByRole('button',{name:'New folder',exact:true}).waitFor({state:'visible'})
 await rows.first().click();await bar.getByRole('button',{name:'Move',exact:true}).click()
 const moving=page.getByRole('dialog',{name:'Move talk within this vault'});await moving.getByRole('option',{name:/^Integration folder/}).click();await moving.getByRole('button',{name:'Move here',exact:true}).click()
 const moved=join(vault,'Integration folder/target/target-outline.md')
 await page.waitForFunction(()=>[...document.querySelectorAll('.vault-gallery [data-identity]')].some(el=>el.getAttribute('data-identity').includes('Integration folder/target/target-outline.md')))
 assert(readFileSync(moved,'utf8').includes('gallery continuity'));await page.getByRole('button',{name:'Return to talk'}).click()
 await page.locator('.cm-content').click();await page.keyboard.press('Meta+End');await page.keyboard.type(' post move typing')
 await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('post move typing'))
 await page.keyboard.press('Meta+s')
 const savedDeadline=Date.now()+30000;while(!readFileSync(moved,'utf8').includes('post move typing') && Date.now()<savedDeadline)await new Promise(r=>setTimeout(r,100))
 writeFileSync(join(evidence,'electron-moved-outline.md'),readFileSync(moved,'utf8'));writeFileSync(join(evidence,'electron-moved-editor.txt'),await page.locator('.cm-content').innerText())
 assert(readFileSync(moved,'utf8').includes('post move typing'));pass('real folder creation and active-talk move preserve latest text; adopted editor accepts typing and saves at destination')

 const secondWindow=app.waitForEvent('window');await page.evaluate(()=>window.tw.windows.open());const second=await secondWindow
 await second.waitForFunction(()=>Boolean(window.tw?.windows));const claim=await second.evaluate(path=>window.tw.windows.claimTalk(path),moved);assert.equal(claim.ok,false);assert(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())));await second.close();pass('actual second hidden editor window cannot claim the talk already held by the adopted editor')
 const vaults=await page.evaluate(()=>window.tw.vault.galleryCatalogue(8123));const id=vaults.vaults[0].id
 const inventory=await page.evaluate(vaultId=>window.tw.vault.galleryInventory({vaultId,relativePath:'',generation:Date.now()+10000,recursive:true,confirmedRoot:true}),id)
 writeFileSync(join(evidence,'electron-inventory.json'),JSON.stringify(inventory,null,2));assert(['complete','partial'].includes(inventory.state));assert(inventory.counted>0);pass('actual Electron IPC and native utility complete explicit fixture-root inventory with nonzero checked entries')

}catch(error){console.error(error);throw error}finally {if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app?.close().catch(()=>{});rmSync(fixture,{recursive:true,force:true});writeFileSync(join(evidence,'electron-results.json'),JSON.stringify(results,null,2))}
