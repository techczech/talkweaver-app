// Main-window Pathways on a COPY of a bundled fixture talk. All Electron windows stay hidden.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
const repo = resolve('.')
const scratch = mkdtempSync(join(tmpdir(), 'tw-pathways-main-'))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
const slug = 'garden-notes'
const outline = join(vault, slug, `${slug}-outline.md`)
mkdirSync(userData, { recursive: true })
cpSync(join(repo, 'resources/example-vault', slug), join(vault, slug), { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'plain' }))
const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE
let app, checks = 0
const pass = label => { checks++; console.log('PASS '+label) }
try {
  await ensureFreshBuild(repo)
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'], cwd: repo, env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(25000)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const hidden = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible()))
  assert.equal(await hidden(), true); pass('editor opens hidden on its own profile')
  await page.getByText('Garden notes', { exact: true }).first().dblclick()
  await page.locator('.cm-content').waitFor()
  await page.waitForTimeout(2000) // allow ordinary initial id stamping/autosave to settle
  const original = readFileSync(outline, 'utf8')
  const sameOutline = () => assert.equal(readFileSync(outline, 'utf8'), original, 'pathway edit leaves outline bytes identical')
  const oldCount = (await app.windows()).length
  // The existing generated Deck menu now navigates in the editor window.
  await page.getByRole('button', { name:'Talk', exact:true }).click()
  await page.getByRole('menuitem', { name:/Pathways/ }).click()
  await page.locator('[data-pathway-dock]').waitFor()
  assert.equal((await app.windows()).length, oldCount); pass('Deck Pathways opens the dock in the same window')
  await page.getByTestId('grid-toggle').click()
  await page.keyboard.press('Meta+Alt+p')
  await page.locator('[data-pathway-dock]').waitFor()
  assert.equal((await app.windows()).length,oldCount); pass('default open-Pathways key selects the main-window view')
  const dock = page.locator('[data-pathway-dock]')
  await dock.getByRole('button', { name:'New', exact:true }).click()
  await page.getByRole('dialog', { name:'New pathway', exact:true }).getByLabel('Pathway name', { exact:true }).fill('Short probe')
  await page.getByRole('button', { name:'Create', exact:true }).click()
  const manifestPath = join(vault, '_PRESENTATIONS', slug, 'manifest.json')
  const manifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'))
  const waitIds = async ids => {
    await page.waitForFunction(ids => [...document.querySelectorAll('[data-pathway-row]')].map(e=>e.dataset.pathwayRow).join(',') === ids.join(','), ids)
    assert.deepEqual(manifest().pathways[0].slideIds, ids)
  }
  await page.waitForFunction(()=>document.querySelector('[data-pathway-dock] select')?.textContent.includes('Short probe'))
  const badge=page.getByRole('button',{name:'Open pathways for Garden notes',exact:true})
  await badge.waitFor()
  assert.equal(await badge.textContent(),'1'); pass('pathway mutation pushes the talk badge count')
  assert.equal(await badge.getAttribute('title'),'Pathways: Short probe'); pass('talk badge tooltip lists the manifest name')
  await page.getByTestId('grid-toggle').click(); await badge.click(); await dock.waitFor()
  assert.equal((await app.windows()).length,oldCount); pass('talk badge navigates to that talk’s main-window dock')
  sameOutline(); pass('create stores a manifest pathway without touching the outline')
  const names = ['Where the plot is','What we grow','Seedlings in May','The plant stall']
  const ids = ['g1','g2','s15','s14']
  const card = title => page.locator('.grid-cell', { hasText:title }).first()
  // Deliberately select backwards: Add must still append in talk order.
  for (const name of [...names].reverse()) await card(name).locator('[data-grid-tick]').check()
  await page.keyboard.press('Meta+Alt+a')
  await page.getByRole('dialog',{name:'Add to pathway',exact:true}).waitFor()
  await page.getByRole('button',{name:'Cancel',exact:true}).click()
  pass('default Add to pathway key opens the destination chooser')
  await page.locator('[data-batch-action="add-to-pathway"]').click()
  await page.getByRole('button', { name:'Short probe (0 slides)', exact:true }).click()
  await waitIds(ids)
  sameOutline(); pass('batch adds four slides in talk order and outline bytes stay identical')
  assert.deepEqual(await page.locator('[data-pathway-badge]').allTextContents(),['1','2','3','4'])
  assert.equal(await page.locator('.grid-cell[data-search-dim="true"]').count(),0)
  pass('only members are numbered; non-members stay undimmed')
  await page.getByTestId('grid-toggle').click()
  await dock.waitFor({state:'detached'})
  const beforePlainPresent=(await app.windows()).length
  await page.keyboard.press('Meta+Alt+Enter')
  await dock.waitFor()
  await page.getByText('Choose a pathway, then Present this pathway.',{exact:true}).waitFor()
  await page.waitForTimeout(300)
  assert.equal((await app.windows()).length,beforePlainPresent)
  assert.equal(existsSync(join(vault,slug,`${slug}-pathway-${manifest().pathways[0].id}-present.html`)),false)
  assert.deepEqual(manifest().pathways[0].slideIds,ids)
  pass('Present in plain Grid opens Pathways with a notice and never invokes presentation')
  await page.getByTestId('grid-toggle').click()
  await dock.waitFor({state:'detached'})
  await page.keyboard.press('Meta+Alt+a')
  await dock.waitFor()
  await page.getByText('Choose a pathway, then Present this pathway.',{exact:true}).waitFor()
  assert.equal(await page.getByRole('dialog',{name:'Add to pathway',exact:true}).count(),0)
  assert.deepEqual(manifest().pathways[0].slideIds,ids)
  pass('Add in plain Grid opens Pathways with a notice and leaves membership unchanged')
  await page.locator('[data-pathway-row="s14"]').focus()
  await page.keyboard.press('Meta+ArrowUp')
  const reordered = ['g1','g2','s14','s15']
  await waitIds(reordered)
  sameOutline(); pass('command-up changes pathway order immediately without editing the outline')
  await page.locator('[data-batch-action="clear"]').click()
  // Move a real outline slide using GridView's existing drag path, while the dock remains open.
  const source = await card('Where the plot is').elementHandle()
  const target = await card('Seedlings in May').elementHandle()
  await page.evaluate(([s,t])=>{
    const dt=new DataTransfer()
    for (const [el,type] of [[s,'dragstart'],[t,'dragenter'],[t,'dragover'],[t,'drop'],[s,'dragend']]) el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}))
  }, [source,target])
  for (let i=0; i<150 && readFileSync(outline,'utf8')===original; i++) await page.waitForTimeout(100)
  const movedOutline = readFileSync(outline,'utf8')
  assert.notEqual(movedOutline, original, 'grid drag changes the copied outline')
  assert.ok(movedOutline.indexOf('Where the plot is') > movedOutline.indexOf('Seedlings in May'))
  await waitIds(reordered)
  assert.deepEqual(manifest().pathways[0].slideIds,reordered)
  pass('outline moves preserve pathway membership and order')
  await dock.getByRole('button', { name:'Matrix', exact:true }).click()
  assert.equal(await page.locator('[data-pathway-matrix] th').count(),2)
  pass('matrix remains available inside the dock')
  const matrixAdd=page.getByRole('button',{name:'Add Spring jobs to Short probe',exact:true})
  await matrixAdd.click()
  await page.getByRole('button',{name:'Remove Spring jobs from Short probe',exact:true}).waitFor()
  assert(manifest().pathways[0].slideIds.includes('g3')); pass('matrix cell adds membership to the same manifest')
  await page.getByRole('button',{name:'Remove Spring jobs from Short probe',exact:true}).click()
  await matrixAdd.waitFor()
  assert.deepEqual(manifest().pathways[0].slideIds,reordered); pass('matrix cell removes membership without changing other ids')
  await dock.getByRole('button', { name:'List', exact:true }).click()
  await dock.getByRole('button', { name:'Rename', exact:true }).click()
  await page.getByRole('dialog', { name:'Rename pathway', exact:true }).getByLabel('Pathway name', { exact:true }).fill('Renamed probe')
  await page.getByRole('dialog', { name:'Rename pathway', exact:true }).getByRole('button',{name:'Rename',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('[data-pathway-dock] select')?.textContent.includes('Renamed probe'))
  assert.equal(readFileSync(outline,'utf8'),movedOutline)
  assert.deepEqual(manifest().pathways[0].slideIds,reordered); pass('rename preserves the manifest id list')
  await page.evaluate(async({outline,id,ids})=>window.tw.pathways.setSlideIds(outline,await window.tw.talk.readOutline(outline),id,[...ids,'removed-probe']),{outline,id:manifest().pathways[0].id,ids:reordered})
  await dock.locator('[data-pathway-warning]').waitFor()
  assert((await dock.locator('[data-pathway-warning]').textContent()).includes('no longer in the talk')); pass('missing ids produce the warning')
  assert((await page.locator('[data-pathway-row="removed-probe"]').textContent()).includes('Slide removed')); pass('numbered list retains a labelled missing row')
  await dock.getByRole('button',{name:'Drop missing',exact:true}).click()
  await waitIds(reordered)
  assert.equal(await dock.locator('[data-pathway-warning]').count(),0)
  assert.equal(readFileSync(outline,'utf8'),movedOutline); pass('Drop missing removes only missing ids and clears the warning')
  // Present via its actual default key while a dock row is focused.
  await page.locator('[data-pathway-row="g1"]').focus()
  const presented = app.waitForEvent('window')
  await page.keyboard.press('Meta+Alt+Enter')
  const presenter = await presented
  await presenter.waitForSelector('#presenterRoot')
  const played = await presenter.evaluate(()=>({pathway:window.__talkWeaverPathway,slides:[...document.querySelectorAll('#stage .slide')].map(s=>s.dataset.id),beats:(window.__deckBeats||[]).map(b=>b.slideId)}))
  assert.equal(played.pathway?.id,manifest().pathways[0].id); pass('presenter receives the selected pathway id')
  assert.deepEqual(played.slides,reordered); assert.deepEqual(played.beats,reordered); pass('presenter slides and beats follow pathway order')
  assert(existsSync(join(vault,slug,`${slug}-pathway-${manifest().pathways[0].id}-present.html`))); pass('filtered presenter file is written beside the copied talk')
  assert.equal(await hidden(),true); pass('every editor and presenter window remains hidden')
  assert.deepEqual(errors,[]); pass('main-window renderer reports no uncaught errors')
  const idleProbe=await app.evaluate(async()=>{
    const counter=()=>globalThis.__twPrepareCount,before=counter(),intervalMs=50
    let expected=Date.now()+intervalMs,maxDriftMs=0
    const ticker=setInterval(()=>{const now=Date.now();maxDriftMs=Math.max(maxDriftMs,now-expected);expected=now+intervalMs},intervalMs)
    await new Promise(resolve=>setTimeout(resolve,15000));clearInterval(ticker)
    return {before,after:counter(),maxDriftMs}
  })
  assert(Number.isFinite(idleProbe.before)); pass('TW_REC_TEST exposes the prepareSource miss counter')
  assert(idleProbe.maxDriftMs<250,JSON.stringify(idleProbe)); pass('idle dock keeps main-process drift below 250ms')
  assert.equal(idleProbe.after,idleProbe.before,JSON.stringify(idleProbe)); pass('idle dock does not run prepareSource')
  console.log(`${checks} main-window pathway Electron checks passed`)
} finally { await app?.close().catch(()=>{}); rmSync(scratch,{recursive:true,force:true}) }
