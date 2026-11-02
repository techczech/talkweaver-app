// Truth states and interaction details of the vault browser: lower bounds, whole-vault total, closed and unavailable vaults,
// assets/system inspection only, folder rename context, Space preview demand, null facts, focus and right-click.
import assert from 'node:assert/strict'
import { startHarness, DISK } from './lib/vault-gallery-repair-harness.mjs'
const h = await startHarness()
const details = s => s.g.getByRole('complementary', { name: 'Details' }).innerText()
const openDetails = () => { localStorage.setItem('tw.vaultGallery.details', 'open') }
try {
  // partial size: a floor, never Unknown and never an exact total
  const s = await h.open({ init: openDetails }); await s.tree0(DISK); await s.enter()
  await s.ctl("ctl.inv=(r,e)=>r.recursive&&r.relativePath==='Work'?{state:'partial',reason:'Directory coverage incomplete at Work/locked: EACCES',unreadable:1,logicalBytes:300000000,allocatedBytes:null,entries:[{relativePath:'Work/a.png',kind:'file',logical:200000000,allocated:210000000},{relativePath:'Work/b.png',kind:'file',logical:100000000,allocated:112500000},{relativePath:'Work/locked',kind:'other',logical:null,allocated:null}]}:{}")
  await s.row('Work').click(); await s.g.getByRole('button', { name: 'Measure this folder' }).click(); await s.settle()
  assert.match(await s.row('Work').locator('.vg-c-size').innerText(), /^≥ 322 MB$/, 'row shows a rounded-down floor')
  const d = await details(s); assert.match(d, /Size on disk\s+≥ 322 MB/); assert.doesNotMatch(d, /Size on disk\s+(Unknown|\d)/); assert.match(d, /Incomplete/i)
  assert.match(await s.g.locator('.vg-sizestatus').innerText(), /^(?!1 of)/, 'a floor is not counted as measured')
  assert.match(await s.g.locator('.vg-sizestatus').innerText(), /^0 of \d+ sizes measured|partial/i)
  // Details of a folder carries the mosaic and folders inside
  assert.match(d, /Folders inside/); await s.page.keyboard.press('Escape')
  // completed whole-vault scan: Details shows the root total
  await s.ctl("ctl.inv=(r,e)=>r.recursive&&r.relativePath===''?{state:'complete',logicalBytes:4e9,allocatedBytes:4.2e9,entries:[{relativePath:'Work',kind:'folder',logical:null,allocated:null},{relativePath:'Work/a.png',kind:'file',logical:4e9,allocated:4.2e9}]}:{}")
  await s.g.getByRole('button', { name: 'Measure this folder' }).click(); await s.g.getByRole('button', { name: 'Measure whole vault' }).click(); await s.settle()
  assert.match(await details(s), /Size on disk\s+4\.2 GB/, 'completed whole-vault total is shown'); await s.close()
  const q = await h.open({ init: openDetails }); await q.tree0(DISK); await q.enter()
  await q.ctl("ctl.inv=(r,e)=>r.recursive&&r.relativePath===''?{state:'partial',reason:'alias',allocatedBytes:null,entries:[{relativePath:'a.png',kind:'file',logical:5e6,allocated:5.4e6},{relativePath:'alias',kind:'alias',logical:null,allocated:null}]}:{}")
  await q.g.getByRole('button', { name: 'Measure this folder' }).click(); await q.g.getByRole('button', { name: 'Measure whole vault' }).click(); await q.settle()
  assert.match(await details(q), /Size on disk\s+≥ 5\.4 MB/, 'a partial whole-vault scan shows the true known floor'); await q.close()

  // closed and not-connected vaults: actions and honest counts
  const o = await h.open({ init: openDetails })
  await o.g.getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'Past workshops', exact: true }).click(); await o.settle()
  assert.doesNotMatch(await details(o), /\b0 known/, 'a closed vault is not stated as holding zero talks')
  await o.tree(/Past workshops/); await o.settle()
  const closed = await o.bar.getByRole('button').allInnerTexts()
  assert.ok(closed.some(b => /Open vault/.test(b)) && closed.some(b => /Vault settings/.test(b)), `closed vault from the tree offers Open vault and Vault settings: ${closed}`)
  assert.doesNotMatch(await details(o), /\b0 known/)
  await o.tree(/Offline drive/); await o.settle()
  const off = await o.bar.getByRole('button').allInnerTexts()
  assert.ok(off.some(b => /Check again/.test(b)) && off.some(b => /Vault settings/.test(b)), `not-connected vault keeps its actions: ${off}`)
  await o.close()

  // overview Details: actions and wording
  const v = await h.open({ init: openDetails })
  await v.g.getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'Library', exact: true }).click(); await v.settle()
  const ov = v.g.getByRole('complementary', { name: 'Details' })
  for (const b of ['Copy location', 'Measure vault']) await ov.getByRole('button', { name: b }).waitFor()
  assert.doesNotMatch(await ov.innerText(), /Select a talk or folder/); await v.close()

  // assets and system folders: inspect-only whatever the registry says; one row each; hidden until the toggle
  const a = await h.open(); await a.tree0(DISK); await a.enter(); await a.settle()
  assert.equal(await a.rows('assets'), 0, 'assets is hidden with the toggle off even though the registry lists it')
  assert.equal(await a.rows('_PRESENTATIONS'), 0, 'system folders are hidden with the toggle off')
  assert.equal(await a.g.getByRole('tree').getByRole('treeitem', { name: /^assets/ }).count(), 0)
  await a.g.getByRole('button', { name: 'Show assets and system folders' }).click()
  for (const n of ['assets', '_PRESENTATIONS']) { assert.equal(await a.rows(n), 1, `${n} is one row`); await a.row(n).click()
    const b = await a.bar.getByRole('button').allInnerTexts(); assert.ok(!b.some(x => /Rename|Bin|Move|Duplicate/.test(x)), `${n} offers no management: ${b}`)
  }
  await a.row('assets').dblclick(); await a.settle()
  assert.equal(await a.bar.getByRole('button', { name: 'New talk' }).count(), 0, 'nothing is created inside assets')
  assert.equal(await a.bar.getByRole('button', { name: 'New folder' }).count(), 0)
  assert.deepEqual(await a.calls('c=>c.writes'), []); await a.close()

  // right-click opens the same menu; a folder rename keeps the current folder and selects the renamed row
  const c = await h.open(); await c.enter(); await c.tree(/^Work \d/)
  await c.row('Alpha talk').click({ button: 'right' }); await c.g.getByRole('menu').getByRole('menuitem', { name: 'Copy location' }).waitFor(); await c.page.keyboard.press('Escape')
  await c.g.getByRole('treeitem', { name: /^Library/ }).click(); await c.row('Archive').click()
  await c.bar.getByRole('button', { name: 'Rename', exact: true }).click()
  const box = c.page.getByRole('textbox').last(); await box.fill('Archive 2'); await box.press('Enter'); await c.settle()
  assert.deepEqual((await c.calls('c=>c.writes')).map(w => w[0]), ['renameFolder'])
  assert.match(await c.g.getByRole('navigation', { name: 'Location' }).innerText(), /Library\s*$/, 'still in the folder you were in')
  await c.close()

  // a settled null facts reply is unavailable, not Reading… forever
  const n = await h.open(); await n.enter(); await n.ctl("ctl.factsNull.add('Work/beta/beta-outline.md')"); await n.tree(/^Work \d/); await n.row('Beta talk').waitFor(); await n.page.waitForTimeout(400)
  assert.equal(await n.row('Beta talk').locator('.vg-skel').count(), 0); await n.close()

  // Space on a selected talk asks for its own title slide
  const p = await h.open(); await p.enter(); await p.tree(/^Work \d/); await p.row('Alpha talk').click(); await p.row('Alpha talk').focus(); await p.settle()
  const asked = (await p.calls('c=>c.facts')).filter(f => f[2]).length
  await p.page.keyboard.press('Space'); await p.page.waitForFunction(n => window.calls.facts.filter(f => f[2]).length > n, asked)
  await p.page.getByRole('region', { name: /Title preview/ }).or(p.page.getByText(/Title preview (pending|unavailable)/).first()).waitFor(); await p.close()

  // focus: a toolbar button keeps focus across a re-render; after Enter on a folder the new list is keyboard-reachable
  const f = await h.open(); await f.enter(); await f.tree(/^Work \d/); await f.row('Alpha talk').click()
  const openBtn = f.bar.getByRole('button', { name: 'Open talk' }); await openBtn.focus(); await f.page.evaluate(() => { window.__b = document.activeElement })
  await f.g.getByRole('button', { name: 'Show assets and system folders' }).evaluate(el => el.click()); await f.settle()
  assert.equal(await f.page.evaluate(() => document.activeElement === window.__b), true, 'toolbar button keeps focus across a re-render')
  await f.g.getByRole('treeitem', { name: /^Library/ }).click(); const w = f.row('Work'); await w.click(); await w.focus(); await f.page.keyboard.press('Enter')
  await f.page.waitForFunction(() => /Work/.test(document.querySelector('nav[aria-label="Location"]').innerText)); await f.settle()
  await f.page.keyboard.press('ArrowDown'); await f.settle()
  assert.equal(await f.grid.locator('.vg-row.sel').count(), 1, 'arrows work in the new list after Enter on a folder')
  await f.page.keyboard.press('Escape'); await f.settle(); assert.equal(await f.g.count(), 1, 'Escape clears the selection, not the gallery')
  assert.deepEqual(f.errors, []); await f.close()
  console.log('PASS lower bound and whole-vault total, closed/unavailable vaults, assets and system inspect-only, right-click, folder rename context, null facts, Space preview, focus')
} finally { await h.close() }
