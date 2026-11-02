// Contract tests for the vault browser's final repairs (normal-file-list design): All talks, Gallery focus, the actions menu, reloads on window focus,
// search and listing slots, the write lock, size truth and closed-vault details, on the real renderer with a main-faithful inventory.
// Derived from the independent re-review probes (evidence/vault-gallery/redesign-re-review/run-re-review.mjs, harness diff in
// evidence/vault-gallery/browser-final-repairs/logs/derived-harness.diff), with their `record` turned into assertions and new probes added.
// VG_SRC (relative to the checkout) points the same test at another source tree to prove it fails there; VG_RESULTS names a JSON file for the per-probe results.
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { guardedHarnessSource, harnessSource } from './lib/vault-gallery-final-fixture.mjs'
const repo = resolve(import.meta.dirname, '..'), src = resolve(repo, process.env.VG_SRC ?? 'src')
const tmp = mkdtempSync(join(tmpdir(), 'tw-vg-browser-final-'))
let browser; const results = []
const record = (id, contract, holds, observed) => { results.push({ id, contract, holds: !!holds, observed }); console.log(`${holds ? 'HOLD' : 'FAIL'} ${id}: ${contract}\n     ${JSON.stringify(observed)}`) }
const open = async ({ w = 1160, h = 740, init, guarded = false } = {}) => {
  const context = await browser.newContext({ viewport: { width: w, height: h } })
  if (init) await context.addInitScript(init)
  await context.route('http://tw.test/**', r => { const u = r.request().url(); r.fulfill(u.endsWith('bundle.js') ? { contentType: 'text/javascript', path: join(tmp, guarded ? 'guarded.js' : 'bundle.js') } : u.endsWith('bundle.css') ? { contentType: 'text/css', path: join(tmp, 'bundle.css') } : { contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/bundle.css"><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script>' }) })
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)))
  await page.goto('http://tw.test/'); const g = page.getByRole('dialog', { name: 'Vault Gallery' }); await g.waitFor()
  const s = {
    page, g, errors, grid: g.getByRole('grid', { name: 'Talks and folders' }), tiles: g.getByRole('listbox', { name: 'Talks and folders' }), bar: g.getByRole('toolbar', { name: 'Actions' }), close: () => context.close(),
    tick: (n = 130) => page.waitForTimeout(n),
    calls: (f = 'c=>c') => page.evaluate(`(${f})(window.calls)`),
    ctl: code => page.evaluate(code),
    disk: t => page.evaluate(x => { window.ctl.tree = x }, t),
    enter: async () => { await g.getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'Review Library', exact: true }).dblclick() },
    tree: re => g.getByRole('tree').getByRole('treeitem', { name: re }).click(),
    row: n => s.grid.getByRole('row', { name: n, exact: true }),
    rows: n => s.grid.getByRole('row', { name: n, exact: true }).count(),
    tile: n => s.tiles.getByRole('option', { name: n, exact: true }),
    active: () => page.evaluate(() => { const e = document.activeElement; return { tag: e?.tagName, label: e?.getAttribute('aria-label') ?? e?.getAttribute('placeholder') ?? null, inGallery: !!e?.closest('.vault-gallery') } }),
    status: () => g.locator('.vg-sizestatus').innerText().catch(() => null),
    body: () => page.locator('body').innerText(),
    details: () => g.getByRole('complementary', { name: 'Details' }).innerText()
  }
  return s
}
const WORK = /^Work \d/
// A real vault's root listing: talk folders, category folders, a loose file, assets, a system area, a link.
const DISK = {
  welcome: { dir: 1 }, 'welcome/welcome-outline.md': { kind: 'file', logical: 90, allocated: 4096 }, scratch: { dir: 1 },
  Work: { dir: 1 }, Archive: { dir: 1 }, Empty: { dir: 1 }, 'file.txt': { kind: 'file', logical: 13, allocated: 4096 }, assets: { dir: 1 }, _PRESENTATIONS: { dir: 1 }, link: { kind: 'link', reason: 'Links are not followed' },
  'Work/alpha': { dir: 1 }, 'Work/alpha/alpha-outline.md': { kind: 'file', logical: 90, allocated: 4096 }, 'Work/disk-only': { dir: 1 }, 'Work/file.txt': { kind: 'file', logical: 13, allocated: 4096 },
  'Work/deep': { dir: 1 }, 'Work/deep/needle.txt': { kind: 'file', logical: 7, allocated: 4096 }, 'Work/sub': { dir: 1 }
}
const showSystem = s => s.g.getByRole('button', { name: 'Show assets and system folders' }).click()
const hold = (s, kind) => s.ctl(`ctl.hold${kind}=true`)

async function allTalks() {
  const s = await open(); await s.disk(DISK); await s.enter(); await s.grid.waitFor(); await s.tree(/^All talks/); await s.tick()
  const names = await s.grid.locator('.vg-row .vg-c-name .vg-tx').allTextContents()
  const stray = names.filter(n => ['Work', 'Archive', 'Empty', 'file.txt', 'assets', '_PRESENTATIONS', 'link'].includes(n))
  const headers = await s.grid.getByRole('columnheader').allInnerTexts()
  record('A1-all-talks-is-talks-only', 'Approved a06/a07: All talks is the flat list of talks with Location. Root folders, loose files, assets, system folders and links are not rows, whatever the disk listing holds', stray.length === 0 && headers.includes('Slides'), { strayRows: stray, headers, rows: names.length })
  await s.close()
}
async function galleryFocus() {
  const gallery = () => localStorage.setItem('tw.vaultGallery.view', 'Gallery')
  const s = await open({ init: gallery }); await s.disk(DISK); await s.enter(); await s.tiles.waitFor()
  await s.tile('Work').click(); await s.tile('Work').focus(); await s.page.keyboard.press('Enter')
  await s.page.waitForFunction(() => /Work/.test(document.querySelector('nav[aria-label="Location"]').innerText)); await s.tick(250)
  const first = await s.active(); await s.page.keyboard.press('ArrowRight'); await s.tick(); const one = await s.active(); await s.page.keyboard.press('ArrowRight'); await s.tick(); const two = await s.active()
  record('F1-gallery-arrows-after-enter', 'Gallery: after Enter on a folder, arrow keys walk the tiles (focus moves to the next tile and stays there)', one.label !== first.label && two.label !== one.label && two.label !== first.label, { first: first.label, afterRight: one.label, afterRightAgain: two.label })
  const box = s.page.getByPlaceholder('Search this folder'); await box.click(); await s.page.keyboard.type('dee', { delay: 60 }); await s.tick(250)
  record('F2-gallery-typing-after-enter', 'Gallery: after Enter on a folder, typing a query that keeps the first tile on screen keeps the text and the focus', (await box.inputValue()) === 'dee' && (await s.active()).tag === 'INPUT', { value: await box.inputValue(), active: await s.active() })
  await s.close()
  const l = await open(); await l.disk(DISK); await l.enter(); await l.row('Work').click(); await l.row('Work').focus(); await l.page.keyboard.press('Enter'); await l.page.waitForFunction(() => /Work/.test(document.querySelector('nav[aria-label="Location"]').innerText)); await l.tick(250)
  const lbox = l.page.getByPlaceholder('Search this folder'); await lbox.click(); await l.page.keyboard.type('alp', { delay: 60 }); await l.tick(250)
  record('F3-list-typing-after-enter-control', 'Control: the same typing in List keeps text and focus', (await lbox.inputValue()) === 'alp' && (await l.active()).tag === 'INPUT', { value: await lbox.inputValue(), active: await l.active() }); await l.close()
  const e = await open(); await e.disk(DISK); await e.enter(); await e.row('Empty').click(); await e.row('Empty').focus(); await e.page.keyboard.press('Enter'); await e.page.waitForFunction(() => /Empty/.test(document.querySelector('nav[aria-label="Location"]').innerText)); await e.tick(250)
  const inEmpty = await e.active(); await e.page.keyboard.press('Escape'); await e.tick()
  record('F4-enter-empty-folder', 'After Enter on an empty folder keyboard focus stays inside the gallery, so Escape still works', inEmpty.inGallery, { active: inEmpty, galleryStillOpenAfterEscape: await e.g.count() === 1 })
  // DERIVED: Escape now closes the gallery from an empty folder (that is the contract F4 checks), so F5 starts a second gallery in the same state.
  const e2 = await open(); await e2.disk(DISK); await e2.enter(); await e2.row('Empty').click(); await e2.row('Empty').focus(); await e2.page.keyboard.press('Enter'); await e2.page.waitForFunction(() => /Empty/.test(document.querySelector('nav[aria-label="Location"]').innerText)); await e2.tick(250); await e.close()
  const treeItem = e2.g.getByRole('tree').getByRole('treeitem', { name: WORK }); await treeItem.focus(); await e2.page.keyboard.press('Enter'); await e2.tick(250); const afterTree = await e2.active()
  record('F5-focus-request-not-left-armed', 'A focus request left over from an empty folder does not later pull focus out of the tree', /^Work/.test(afterTree.label ?? '') || afterTree.tag === 'BUTTON', { afterTree }); await e2.close()
}
async function focusLeftover() {
  const e = await open(); await e.disk(DISK); await e.enter(); await e.grid.waitFor(); await hold(e, 'Listing')
  await e.row('Empty').click(); await e.row('Empty').focus(); await e.page.keyboard.press('Enter'); await e.page.waitForFunction(() => window.ctl.release); await e.tick()
  await e.ctl('ctl.holdListing=false'); const treeItem = e.g.getByRole('tree').getByRole('treeitem', { name: WORK }); await treeItem.focus(); await e.page.keyboard.press('Enter'); await e.tick(400)
  const after = await e.active()
  record('F6-armed-focus-dropped-on-other-navigation', 'Enter on a folder whose rows have not arrived, then choosing another folder in the tree, does not later pull focus into the new list', after.tag !== 'DIV' || !/^(Alpha|Beta|Delta|deep|disk-only|sub)/.test(after.label ?? ''), { after }); await e.close()
}
async function menu() {
  const a = await open(); await a.disk(DISK); await a.enter(); await a.tree(WORK); await a.grid.waitFor(); await a.row('Alpha talk').click({ button: 'right' }); await a.tick()
  const items = (await a.g.getByRole('menu').getByRole('menuitem').allInnerTexts().catch(() => [])).filter(Boolean), visible = await a.g.getByRole('menu').getByRole('menuitem').evaluateAll(l => l.filter(e => e.getClientRects().length).map(e => e.textContent)).catch(() => [])
  record('M4-right-click-same-actions', 'Approved a18 and design round: right-click and ⋯ open the same actions as the toolbar (Open talk, View handouts, Preview, Copy location, Rename, Duplicate, Move, Bin), headed "Actions for this talk", at the pointer', visible.length >= 8 && visible.some(t => /Open talk/.test(t)) && visible.some(t => /Move to Bin/.test(t)), { visible })
  await a.close()
  const b = await open(); await b.disk(DISK); await b.enter(); await b.tree(WORK); await b.grid.waitFor(); await showSystem(b); await b.row('file.txt').waitFor()
  await b.row('file.txt').click({ button: 'right' }); await b.tick(); await b.row('Alpha talk').click(); await b.tick()
  record('M1-menu-does-not-arm-on-entry', 'Right-click on a file row has no menu; the next plain click on a talk does not pop a menu open', await b.g.getByRole('menu').count() === 0, { menusAfterPlainClick: await b.g.getByRole('menu').count() }); await b.close()
  const c = await open(); await c.disk(DISK); await c.enter(); await c.tree(WORK); await c.grid.waitFor(); await c.row('Alpha talk').click({ button: 'right' }); await c.tick(); await c.row('Beta talk').click({ position: { x: 6, y: 6 } }); await c.tick()
  record('M2-click-closes-menu', 'Prototype: choosing another row closes the contextual menu', await c.g.getByRole('menu').count() === 0, { menusAfterClick: await c.g.getByRole('menu').count() }); await c.close()
  const n = await open({ w: 800, h: 600 }); await n.disk(DISK); await n.enter(); await n.grid.waitFor(); await n.row('Archive').waitFor(); await n.row('Welcome to the review vault').click()
  await n.ctl('ctl.holdTalk=true'); await n.row('Welcome to the review vault').dblclick(); await n.page.waitForFunction(() => window.calls.talk.length >= 1); await n.tick()
  await n.row('Archive').click({ button: 'right' }); await n.tick()
  const rename = n.g.getByRole('menu').getByRole('menuitem', { name: 'Rename' }), enabled = await rename.count() ? await rename.isEnabled() : false
  let promptOpened = false, writes = null, error = null
  if (enabled) { await rename.click(); await n.tick(); promptOpened = await n.page.locator('.vg-management-layer').count() === 1
    if (promptOpened) { const box = n.page.getByRole('textbox').last(); await box.fill('Renamed under lock'); await box.press('Enter'); await n.tick(); writes = await n.calls('c=>c.writes'); error = await n.g.getByRole('alert').count() } }
  record('M3-right-click-under-lock', 'While the lock is held the right-click menu cannot start an action that is then dropped without a word (toolbar ⋯ is disabled in the same state)', !enabled || !promptOpened, { renameEnabled: enabled, promptOpened, writesAfterSubmit: writes, alerts: error }); await n.close()
}
async function reload() {
  const m = await open({ init: () => localStorage.setItem('tw.vaultGallery.details', 'open') }); await m.disk(DISK); await m.enter(); await m.tree(WORK); await m.grid.waitFor(); await hold(m, 'Recursive')
  await m.g.getByRole('button', { name: 'Measure this folder' }).click(); await m.page.waitForFunction(() => window.ctl.release); await m.tick()
  await m.ctl("ctl.emit({counted:64,entries:[{relativePath:'Work/deep/needle.txt',kind:'file',logical:7,allocated:4096}]})"); await m.tick()
  const before = await m.status(), cancels = await m.calls('c=>c.cancelInv.length'); await m.ctl('ctl.setRev(2)'); await m.tick(260); const after = await m.status()
  record('R1-focus-reload-keeps-measurement', 'App re-supplies state.vaults on every window focus. Returning to the app does not stop a running measurement or drop what it found', /Measuring/.test(after ?? ''), { before, after, cancelsAdded: (await m.calls('c=>c.cancelInv.length')) - cancels }); await m.close()
  const r = await open(); await r.disk(DISK); await r.enter(); await r.grid.waitFor()
  await r.page.getByPlaceholder('Search this vault').fill('needle'); await r.g.getByRole('button', { name: 'Search whole vault' }).click(); await r.g.getByRole('button', { name: 'Measure whole vault' }).click(); await r.row('needle.txt').waitFor()
  await r.ctl('ctl.setRev(2)'); await r.tick(260)
  record('R2-focus-reload-keeps-confirmed-search', 'Returning to the app keeps a completed whole-vault search', await r.rows('needle.txt') === 1, { rows: await r.rows('needle.txt'), banner: /Search whole vault/.test(await r.body()) }); await r.close()
  const l = await open(); await l.disk(DISK); await l.enter(); await l.tree(/^All talks/); await l.grid.waitFor(); await l.tick()
  const set = await l.page.evaluate(() => { const c = [...document.querySelectorAll('.vault-gallery *')].find(x => /auto|scroll/.test(getComputedStyle(x).overflowY) && x.scrollHeight > x.clientHeight + 40 && x.closest('.vg-main')); if (!c) return null; c.scrollTop = 300; window.__sc = c.className; return c.scrollTop })
  await l.ctl('ctl.setRev(2)'); await l.tick(260)
  const top = await l.page.evaluate(() => document.getElementsByClassName(window.__sc?.split(' ')[0])[0]?.scrollTop ?? null)
  record('R3-focus-reload-keeps-scroll', 'Returning to the app keeps the list scroll position', set > 0 && top === set, { set, after: top, scroller: await l.page.evaluate(() => window.__sc) }); await l.close()
  const f = await open(); await f.disk(DISK); await f.enter(); await f.tree(WORK); await f.grid.waitFor(); await f.row('Beta talk').click(); await f.row('Beta talk').focus(); const was = await f.active()
  await f.ctl('ctl.setRev(2)'); await f.tick(260); const now = await f.active(); const selected = await f.row('Beta talk').getAttribute('aria-selected').catch(() => null); await f.page.keyboard.press('ArrowDown'); await f.tick()
  record('R4-focus-reload-keeps-keyboard', 'Returning to the app keeps keyboard focus on the row, so arrows keep working', now.inGallery && now.label === was.label, { was, now, selected, selectionAfterArrow: await f.grid.locator('.vg-row.sel').getAttribute('aria-label').catch(() => null) }); await f.close()
}
async function search() {
  const s = await open(); await s.disk(DISK); await s.enter(); await s.tree(WORK); await s.grid.waitFor(); await hold(s, 'Recursive')
  const box = s.page.getByPlaceholder('Search this folder'); await box.fill('needle'); await s.page.waitForFunction(() => window.ctl.release); await s.tick()
  const n = await s.calls('c=>c.cancelInv.length'); await s.g.getByRole('button', { name: 'Clear search' }).click(); await s.tick()
  record('S1-clear-stops-scan', 'Clearing the search stops the recursive scan it started', (await s.calls('c=>c.cancelInv.length')) > n, { cancelsAdded: (await s.calls('c=>c.cancelInv.length')) - n, footer: await s.status() }); await s.close()
  const t = await open(); await t.disk(DISK); await t.enter(); await t.tree(WORK); await t.grid.waitFor(); await hold(t, 'Listing')
  await t.g.getByRole('button', { name: 'Refresh' }).click(); await t.page.waitForFunction(() => window.ctl.release); await t.tick()
  await t.ctl('ctl.holdRecursive=true'); await t.page.getByPlaceholder('Search this folder').fill('needle'); await t.tick()
  const issued = (await t.calls('c=>c.inv')).filter(r => r.recursive).length
  await t.ctl('ctl.holdListing=false;ctl.release()'); await t.tick(); const issued2 = (await t.calls('c=>c.inv')).filter(r => r.recursive).length
  record('S2-scan-waits-for-listing', 'Main has one slot: a search typed while a listing runs waits for it instead of cancelling it', issued === 0 && issued2 === 1, { whileListing: issued, afterListing: issued2 })
  await t.ctl('ctl.release()'); await t.row('needle.txt').waitFor()
  record('S3-delivered-through-the-chain', 'The chained search still delivers its match', await t.rows('needle.txt') === 1, { superseded: await t.calls('c=>c.superseded||0') }); await t.close()
  const k = await open(); await k.disk(DISK); await k.enter(); await k.tree(WORK); await k.grid.waitFor()
  const bx = k.page.getByPlaceholder('Search this folder'); await hold(k, 'Recursive'); await bx.click(); await k.page.keyboard.type('needl', { delay: 10 }); await k.tick()
  await k.ctl('ctl.holdRecursive=false;ctl.release&&ctl.release()'); await k.tick(300); await k.ctl('ctl.release&&ctl.release()'); await k.tick()
  record('S4-rapid-typing', 'Rapid typing with real cancellation resolves to one delivered result and no generation refusal', await k.rows('needle.txt') === 1 && (await k.calls('c=>c.superseded||0')) === 0, { rows: await k.rows('needle.txt'), superseded: await k.calls('c=>c.superseded||0'), recursive: (await k.calls('c=>c.inv')).filter(r => r.recursive).length }); await k.close()
  const z = await open(); await z.disk(DISK); await z.enter(); await z.tree(WORK); await z.grid.waitFor(); await showSystem(z); await z.row('file.txt').waitFor(); await z.row('disk-only').click(); await hold(z, 'Listing')
  await z.g.getByRole('button', { name: 'Refresh' }).click(); await z.page.waitForFunction(() => window.ctl.release); await z.tick()
  await z.ctl("ctl.emit({counted:64,entries:[{relativePath:'Work/alpha',kind:'folder',logical:null,allocated:null}]})"); await z.tick()
  record('Z1-listing-progress-keeps-rows', 'A re-list of a folder with 64 or more entries emits progress; the rows already shown stay until the listing ends', await z.rows('disk-only') === 1 && await z.rows('file.txt') === 1, { diskOnly: await z.rows('disk-only'), file: await z.rows('file.txt'), toolbar: await z.bar.getByRole('button').allInnerTexts() }); await z.close()
  const h = await open({ init: () => localStorage.setItem('tw.vaultGallery.details', 'open') }); await h.disk(DISK); await h.enter(); await h.ctl('ctl.handoutHold=true'); await h.tree(WORK); await h.grid.waitFor(); await h.tick(200)
  await h.ctl('ctl.heldHandouts.length=0'); await h.row('Beta talk').click(); await h.bar.getByRole('button', { name: 'Handouts', exact: true }).click(); await h.tick(); const heldNow = await h.ctl('ctl.heldHandouts.length')
  await h.page.keyboard.press('Escape').catch(() => { }); await h.ctl('ctl.handoutHold=false;ctl.rootGen=8'); await h.g.getByRole('button', { name: 'Refresh' }).click(); await h.tick(300)
  const fresh = await h.row('Beta talk').locator('.vg-c-hand').innerText(); await h.ctl('ctl.heldHandouts.splice(0).forEach(r=>r())'); await h.tick(); const final = await h.row('Beta talk').locator('.vg-c-hand').innerText()
  record('H1-handouts-generation-guard', 'A handout reply from before a Refresh cannot overwrite the current status', heldNow > 0 && fresh === final, { heldNow, fresh, final }); await h.close()
}
async function busy() {
  const start = async (o = {}) => { const s = await open(o); await s.disk(DISK); await s.enter(); await (s.tiles.or(s.grid)).first().waitFor(); await s.tree(WORK); await (s.tiles.or(s.grid)).first().waitFor(); return s }
  const moveHeld = async s => { await s.ctl('ctl.holdMove=true'); await s.bar.getByRole('button', { name: 'Move', exact: true }).click(); const d = s.page.getByRole('dialog', { name: 'Move talk within this vault' }); await d.getByRole('option', { name: /^Archive/ }).click(); await d.getByRole('button', { name: 'Move here' }).click(); await s.page.waitForFunction(() => window.calls.writes.some(w => w[0] === 'move')); await s.tick() }
  const g = await start({ init: () => localStorage.setItem('tw.vaultGallery.view', 'Gallery') }); await g.tile('Alpha talk').click(); await moveHeld(g); const t0 = await g.calls('c=>c.talk.length')
  await g.tile('Beta talk').dblclick(); await g.tile('Beta talk').focus(); await g.page.keyboard.press('Enter'); await g.tick()
  record('B1-gallery-tile-routes', 'Double-click and Enter on a Gallery tile start nothing during a write', await g.calls('c=>c.open.length') === 0 && (await g.calls('c=>c.talk.length')) === t0, { opens: await g.calls('c=>c.open.length'), resolves: (await g.calls('c=>c.talk.length')) - t0 })
  const stillLocked = await g.bar.getByRole('button', { name: 'Open talk' }).isDisabled(); await g.ctl('ctl.held.splice(0).forEach(r=>r())'); await g.tick(); await g.close()
  record('B2-lock-holds-while-write-runs', 'Toolbar stays locked for the whole write', stillLocked, { stillLocked })
  const o = await start({ init: () => localStorage.setItem('tw.vaultGallery.view', 'Gallery') }); await o.tile('Alpha talk').click(); await o.tile('Alpha talk').focus(); await o.ctl('ctl.holdTalk=true'); await o.page.keyboard.press('Enter'); await o.page.keyboard.press('Enter'); await o.tick()
  record('B3-gallery-double-enter', 'Double Enter on a tile resolves one talk', await o.calls('c=>c.talk.length') === 1, { talkCalls: await o.calls('c=>c.talk.length') }); await o.ctl('ctl.holdTalk=false;ctl.held.splice(0).forEach(r=>r())'); await o.tick(); await o.close()
  const r = await start(); await r.row('Alpha talk').click(); await r.ctl('ctl.holdTalk=true'); await r.bar.getByRole('button', { name: 'Open talk' }).click(); await r.tick()
  const refreshEnabled = await r.g.getByRole('button', { name: 'Refresh' }).isEnabled()
  if (refreshEnabled) await r.g.getByRole('button', { name: 'Refresh' }).click(); await r.tick(); await r.ctl('ctl.holdTalk=false;ctl.held.splice(0).forEach(r=>r())'); await r.tick()
  record('B4-refresh-during-open', 'Refresh cannot silently abandon an open that is already running', !refreshEnabled || (await r.calls('c=>c.open.length')) === 1 || (await r.g.getByRole('alert').count()) > 0, { refreshEnabled, opensReachedHost: await r.calls('c=>c.open.length'), alerts: await r.g.getByRole('alert').count() }); await r.close()
  const v = await open(); await v.disk(DISK); await v.enter(); await v.grid.waitFor(); await v.tick(); await v.tree(WORK); await v.row('Alpha talk').click(); await v.ctl('ctl.holdMove=true'); await v.bar.getByRole('button', { name: 'Move', exact: true }).click(); const d = v.page.getByRole('dialog', { name: 'Move talk within this vault' }); await d.getByRole('option', { name: /^Archive/ }).click(); await v.ctl('ctl.setRev(2)'); await v.tick(260)
  record('B5-move-dialog-survives-reload', 'The Move dialog and its chosen destination survive a vault-list change', await d.getByRole('option', { name: /^Archive/ }).getAttribute('aria-selected').catch(() => null) === 'true', { selected: await d.getByRole('option', { name: /^Archive/ }).getAttribute('aria-selected').catch(() => null) }); await v.close()
}
async function truth() {
  const inv = (rel, over) => `ctl.inv=(r,b)=>r.recursive&&r.relativePath===${JSON.stringify(rel)}?${JSON.stringify(over)}:{}`
  const details = () => localStorage.setItem('tw.vaultGallery.details', 'open')
  const s = await open({ init: details }); await s.disk(DISK); await s.enter(); await s.grid.waitFor(); await s.tick()
  await s.ctl(inv('Work', { state: 'partial', excluded: 1, allocationUnknown: 1, logicalBytes: 300000000, allocatedBytes: null, entries: [{ relativePath: 'Work/a.png', kind: 'file', logical: 200000000, allocated: 210000000 }, { relativePath: 'Work/b.png', kind: 'file', logical: 100000000, allocated: 252900000 }, { relativePath: 'Work/lnk', kind: 'link', logical: null, allocated: null }] }))
  await s.row('Work').click(); await s.g.getByRole('button', { name: 'Measure this folder' }).click(); await s.tick()
  const d = await s.details(), cell = await s.row('Work').locator('.vg-c-size').innerText(), foot = await s.status()
  record('T1-floor-rounds-down', 'Partial: row and Details show ≥ 462 MB (462.9 MB rounded down), explained, never an exact total and never a measured count', cell === '≥ 462 MB' && /Size on disk\s+≥ 462 MB/.test(d) && /Incomplete|incomplete/.test(d) && !/of \d+ sizes measured/.test(foot ?? '') , { cell, foot, details: d.replace(/\s+/g, ' ').slice(0, 170) }); await s.close()
  const q = await open({ init: details }); await q.disk(DISK); await q.enter(); await q.tree(WORK); await q.grid.waitFor(); await q.tick()
  await q.ctl("ctl.inv=(r,b)=>r.recursive&&r.relativePath==='Work'?{state:'partial',excluded:1,allocationUnknown:1,allocatedBytes:null,entries:[{relativePath:'Work/deep',kind:'folder',logical:null,allocated:null},{relativePath:'Work/deep/needle.txt',kind:'file',logical:7,allocated:9000000}]}:r.recursive?{state:'complete',allocatedBytes:4096,logicalBytes:90,entries:[{relativePath:r.relativePath+'/x',kind:'file',logical:90,allocated:4096}]}:{}")
  await q.page.getByPlaceholder('Search this folder').fill('deep'); await q.row('deep').waitFor(); await q.page.getByPlaceholder('Search this folder').press('Tab'); await q.tick()
  const floorCell = await q.row('deep').locator('.vg-c-size').innerText(); await q.row('needle.txt').click().catch(() => { })
  await q.row('deep').click(); await q.g.getByRole('button', { name: /Measure this/ }).click(); await q.tick()
  const foot2 = await q.status(); const m = foot2?.match(/(\d+) of (\d+) sizes measured/)
  record('T2-footer-never-counts-floor', 'A floor is never counted as a measured size in the footer', !m || floorCell.startsWith('≥') , { floorCell, foot: foot2 }); await q.close()
  const c = await open({ init: details }); await c.disk(DISK); await c.enter(); await c.tree(WORK); await c.grid.waitFor(); await hold(c, 'Recursive'); await c.g.getByRole('button', { name: 'Measure this folder' }).click(); await c.page.waitForFunction(() => window.ctl.release); await c.tick()
  await c.ctl("ctl.emit({recursive:true,counted:64,logicalBytes:7,allocatedBytes:5400000,entries:[{relativePath:'Work/deep',kind:'folder',logical:null,allocated:null},{relativePath:'Work/deep/needle.txt',kind:'file',logical:7,allocated:5400000}]})"); await c.tick()
  await c.g.getByRole('button', { name: 'Stop', exact: true }).click(); await c.tick(); const stopped = await c.details()
  record('T3-stop-keeps-honest-floor', 'Stop with progress: the folder shows a floor from what was measured, marked incomplete, never an exact size', /Size on disk\s+≥ 5\.4 MB/.test(stopped) && /ncomplete/.test(stopped), { details: stopped.replace(/\s+/g, ' ').slice(0, 170), foot: await c.status() }); await c.close()
  const x = await open({ init: details }); await x.disk(DISK); await x.enter(); await x.grid.waitFor(); await showSystem(x); await x.row('assets').waitFor(); await x.row('assets').click()
  await x.ctl("ctl.inv=(r,b)=>r.recursive&&r.relativePath==='assets'?{state:'complete',logicalBytes:50000000,allocatedBytes:52000000,entries:[{relativePath:'assets/a.png',kind:'file',logical:50000000,allocated:52000000}]}:{}")
  await x.g.getByRole('button', { name: /Measure this/ }).click(); await x.tick()
  const sized = await x.row('assets').locator('.vg-c-size').innerText(), det = await x.details()
  record('T4-inspect-folder-measure-shows', 'Measure on a selected assets or system folder delivers its size to the row and Details (the status table says Details shows size for a system folder)', /52 MB/.test(sized) && /52 MB/.test(det), { sized, details: det.replace(/\s+/g, ' ').slice(0, 130), foot: await x.status() }); await x.close()
  const cl = await open({ init: details }); await cl.tree(/Past workshops/); await cl.tick()
  const clText = await cl.details()
  record('C1-closed-vault-details-wording', 'Closed vault from the tree: Details gives no hint to select rows that do not exist (a29)', !/Select a talk or folder/.test(clText), { details: clText.replace(/\s+/g, ' ').slice(0, 170), toolbar: await cl.bar.getByRole('button').allInnerTexts() }); await cl.close()
  const ov = await open({ init: details }); await ov.disk(DISK); await ov.g.getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'Review Library', exact: true }).click(); await ov.tick(); const n0 = (await ov.calls('c=>c.inv')).filter(r => r.recursive).length
  await ov.g.getByRole('button', { name: 'Measure vault' }).click(); await ov.g.getByRole('group', { name: 'Confirm whole-vault measurement' }).waitFor({ timeout: 2000 }).catch(() => { }); const asked = await ov.g.getByRole('group', { name: 'Confirm whole-vault measurement' }).count(), n1 = (await ov.calls('c=>c.inv')).filter(r => r.recursive).length
  if (asked) await ov.g.getByRole('button', { name: 'Measure whole vault' }).click(); await ov.tick(); const last = await ov.calls('c=>c.inv.filter(r=>r.recursive).at(-1)')
  record('C2-overview-measure-explicit', 'Measure vault from the overview asks first, then runs one confirmed root scan', asked === 1 && n1 === n0 && last?.confirmedRoot === true && last?.relativePath === '', { asked, scansBeforeConfirm: n1 - n0, last }); await ov.close()
  const rn = await open(); await rn.disk(DISK); await rn.enter(); await rn.grid.waitFor(); await rn.row('Archive').click(); await rn.bar.getByRole('button', { name: 'Rename', exact: true }).click(); const box = rn.page.getByRole('textbox').last(); await box.fill('Archive 2'); await box.press('Enter'); await rn.tick(300)
  const crumb = await rn.g.getByRole('navigation', { name: 'Location' }).innerText()
  record('C3-folder-rename-context', 'Renaming a folder keeps you where you are and selects the renamed row', /Review Library\s*$/.test(crumb) && await rn.row('Archive 2').getAttribute('aria-selected').catch(() => null) === 'true', { crumb: crumb.replace(/\s+/g, ' '), selected: await rn.row('Archive 2').getAttribute('aria-selected').catch(() => null), writes: await rn.calls('c=>c.writes') }); await rn.close()
  const a = await open(); await a.disk(DISK); await a.enter(); await a.grid.waitFor(); await a.tick(); const hidden = [await a.rows('assets'), await a.rows('_PRESENTATIONS')]; await showSystem(a); await a.tick(); const shown = [await a.rows('assets'), await a.rows('_PRESENTATIONS')]
  await a.row('_PRESENTATIONS').click(); const pb = await a.bar.getByRole('button').allInnerTexts(); await a.row('assets').click(); const ab = await a.bar.getByRole('button').allInnerTexts()
  await a.row('assets').dblclick(); await a.tick(); const inside = await a.bar.getByRole('button').allInnerTexts()
  record('C4-real-classification', 'With the kinds the native classifier really sends (assets=assets, _PRESENTATIONS=folder): hidden with the toggle off, one row each with it on, no management, nothing created inside', hidden.join() === '0,0' && shown.join() === '1,1' && ![...pb, ...ab, ...inside].some(t => /Rename|Bin|Move|Duplicate|New /.test(t)), { hidden, shown, presentations: pb, assets: ab, inside }); await a.close()
}

const menuOf = s => s.g.getByRole('menu')
const items = async s => (await menuOf(s).getByRole('menuitem').allInnerTexts()).filter(Boolean)
const DETAILS = () => localStorage.setItem('tw.vaultGallery.details', 'open')
const GALLERY = () => localStorage.setItem('tw.vaultGallery.view', 'Gallery')
const inWork = s => s.page.waitForFunction(() => /Work/.test(document.querySelector('nav[aria-label="Location"]').innerText))
async function finalMenus() {
  const a = await open(); await a.disk(DISK); await a.enter(); await a.tree(WORK); await a.grid.waitFor()
  const box = await a.row('Alpha talk').boundingBox(); await a.page.mouse.click(box.x + 300, box.y + 10, { button: 'right' }); await a.tick()
  const heading = await menuOf(a).locator('h4').innerText().catch(() => null), at = await menuOf(a).boundingBox().catch(() => null), labels = await items(a)
  record('N4a-menu-heading-actions-and-place', 'Right-click opens "Actions for this talk" with the eight approved actions at the pointer', heading === 'Actions for this talk' && labels.length === 8 && !!at && Math.abs(at.x - (box.x + 300)) <= 2 && Math.abs(at.y - (box.y + 10)) <= 2 && /^Open talk/.test(labels[0]) && /Move to Bin$/.test(labels.at(-1)), { heading, labels, menuAt: at && { x: at.x, y: at.y }, pointer: { x: box.x + 300, y: box.y + 10 } })
  await a.page.keyboard.press('Escape'); await a.tick(); const closed = await menuOf(a).count(), stillOpen = await a.g.count()
  record('N4b-escape-closes-menu-only', 'Escape closes the menu and leaves the gallery open', closed === 0 && stillOpen === 1, { menus: closed, gallery: stillOpen })
  await a.bar.getByRole('button', { name: 'More', exact: true }).click(); await a.tick(); const viaEllipsis = await items(a), head2 = await menuOf(a).locator('h4').innerText().catch(() => null)
  record('N4c-ellipsis-same-actions', 'The ⋯ button opens the same eight actions', viaEllipsis.length === 8 && head2 === 'Actions for this talk', { viaEllipsis, head2 })
  await a.page.evaluate(() => [...document.querySelectorAll('[role="treeitem"]')].find(e => /^Archive/.test(e.getAttribute('aria-label') ?? e.textContent ?? ''))?.click()); await a.tick()
  record('N4d-menu-closes-on-scope-change', 'Changing folder closes an open menu (no pointer press involved)', await menuOf(a).count() === 0, { menus: await menuOf(a).count(), crumb: await a.g.getByRole('navigation', { name: 'Location' }).innerText() })
  await a.close()
  const k = await open(); await k.disk(DISK); await k.enter(); await k.tree(WORK); await k.grid.waitFor(); await k.row('Alpha talk').click({ button: 'right' }); await k.tick()
  await k.page.evaluate(() => document.querySelector('[role="row"][aria-label="Beta talk"]').click()); await k.tick(); const afterRow = await menuOf(k).count()
  await k.page.evaluate(() => document.querySelector('[role="row"][aria-label="Alpha talk"]').click()); await k.tick(); const backToFirst = await menuOf(k).count()
  record('N4g-menu-belongs-to-its-row', 'Choosing another row closes the menu, and choosing the first row again does not bring it back', afterRow === 0 && backToFirst === 0, { afterRow, backToFirst }); await k.close()
  const w = await open(); await w.disk(DISK); await w.enter(); await w.tree(WORK); await w.grid.waitFor(); await w.row('Alpha talk').click(); await w.bar.getByRole('button', { name: 'More', exact: true }).click(); await w.tick()
  await w.ctl('ctl.holdTalk=true'); await w.page.evaluate(() => document.querySelector('[role="row"][aria-label="Beta talk"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await w.page.waitForFunction(() => window.calls.talk.length >= 1); await w.tick()
  const menusWhileBusy = await menuOf(w).count(), more = await w.bar.getByRole('button', { name: 'More', exact: true }).isDisabled().catch(() => null)
  await w.row('Delta').click({ button: 'right' }); await w.tick()
  const delta = await w.row('Delta').getAttribute('aria-selected')
  record('N4e-busy-closes-and-blocks-menu', 'A running action closes the menu and a right-click during it opens none and selects nothing (same lock as the buttons)', menusWhileBusy === 0 && more !== false && await menuOf(w).count() === 0 && delta === 'false', { menusWhileBusy, moreDisabled: more, afterRightClick: await menuOf(w).count(), deltaSelected: delta })
  await w.ctl('ctl.holdTalk=false;ctl.held.splice(0).forEach(r=>r())'); await w.close()
  const d = await open(); await d.disk(DISK); await d.enter(); await d.grid.waitFor(); await showSystem(d); await d.row('assets').waitFor(); await d.row('assets').click({ button: 'right' }); await d.tick()
  const dirMenu = await menuOf(d).count(), dirMore = await d.bar.getByRole('button', { name: 'More', exact: true }).count(), dirBar = await d.bar.getByRole('button').allInnerTexts(); await d.g.getByRole('button', { name: 'Details', exact: true }).click(); await d.tick(); const dirCopy = await d.g.getByRole('complementary', { name: 'Details' }).getByRole('button', { name: 'Copy location' }).count()
  await d.row('file.txt').click({ button: 'right' }); await d.tick(); const fileMenu = await menuOf(d).count(); await d.row('link').click({ button: 'right' }); await d.tick(); const linkMenu = await menuOf(d).count()
  record('N4f-inspect-only-menus', 'Approved a24: an inspect-only folder has no ⋯ and no menu (Open folder in the toolbar, Copy location in Details); a stored file or link arms no menu', dirMenu === 0 && dirMore === 0 && dirBar.some(t => /Open folder/.test(t)) && dirCopy === 1 && fileMenu === 0 && linkMenu === 0, { dirMenu, dirMore, dirBar, dirCopy, fileMenu, linkMenu }); await d.close()
}
async function finalReload() {
  const r = await open(); await r.disk(DISK); await r.enter(); await r.grid.waitFor(); await hold(r, 'Recursive'); await r.row('Work').click(); await r.g.getByRole('button', { name: 'Measure this folder' }).click(); await r.page.waitForFunction(() => window.ctl.release); await r.tick()
  const cancels = await r.calls('c=>c.cancelInv.length'); await r.ctl('ctl.rootGen=9;ctl.setRev(2)'); await r.page.waitForFunction(() => window.calls.catalogue >= 2); await r.tick(300)
  record('R5-real-root-change-resets', 'A real change of the vault set (new root generation) does stop a running measurement', (await r.calls('c=>c.cancelInv.length')) > cancels && !/Measuring/.test(await r.status() ?? ''), { cancelsAdded: (await r.calls('c=>c.cancelInv.length')) - cancels, footer: await r.status() }); await r.close()
  const h = await open(); await h.disk(DISK); await h.enter(); await h.tree(WORK); await h.grid.waitFor(); await h.tick()
  await h.ctl("window.__real=window.tw.vault.galleryCatalogue;window.tw.vault.galleryCatalogue=g=>new Promise(res=>{ctl.releaseCat=()=>window.__real(g).then(res)})"); await h.ctl('ctl.setRev(2)'); await h.tick(250)
  const rows = await h.rows('Alpha talk'), reading = /Reading known catalogue/.test(await h.body()), count = await h.grid.getByRole('row').count()
  record('N3b-rows-stay-while-catalogue-reloads', 'While a window-focus reload is waiting for its reply the rows stay on screen', rows === 1 && !reading && count > 1, { rows, reading, rowCount: count })
  await h.ctl('ctl.releaseCat()'); await h.tick(250); record('N3c-reload-reply-swaps-in', 'The reply replaces the catalogue without blanking it', await h.rows('Alpha talk') === 1, { rows: await h.rows('Alpha talk') }); await h.close()
  const f = await open(); await f.disk(DISK); await f.enter(); await f.ctl('ctl.heldFacts.set("Work/beta/beta-outline.md",[])'); await f.tree(WORK); await f.grid.waitFor(); await f.tick(250)
  const pendingBefore = await f.row('Beta talk').locator('.vg-skel').count()
  // Main cancels reads in flight when the catalogue is read again: the held reply comes back null while the new catalogue is still on its way.
  await f.ctl("window.__real=window.tw.vault.galleryCatalogue;window.tw.vault.galleryCatalogue=g=>new Promise(res=>{ctl.releaseCat=()=>window.__real(g).then(res)})"); await f.ctl('ctl.setRev(2)'); await f.tick(100)
  await f.ctl('window.tw.vault.galleryCancelFacts();ctl.heldFacts.get("Work/beta/beta-outline.md").splice(0).forEach(r=>r());ctl.heldFacts.delete("Work/beta/beta-outline.md")'); await f.tick(150)
  const markedUnknown = await f.row('Beta talk').locator('.vg-c-contents').innerText()
  await f.ctl('ctl.releaseCat()'); await f.tick(400); const unk = await f.row('Beta talk').locator('.vg-c-contents').innerText()
  record('N3d-cancelled-reads-are-asked-again', 'A reload cancels main\'s reads in flight; a row whose read was cancelled is asked for again and shows its facts, not Unknown', pendingBefore > 0 && unk !== 'Unknown' && /slides?$|^\d+$/.test(unk), { pendingBefore, whileWaiting: markedUnknown, contents: unk }); await f.close()
}
async function finalSearchAndLists() {
  const m = await open(); await m.disk(DISK); await m.enter(); await m.tree(WORK); await m.grid.waitFor()
  await m.page.getByPlaceholder('Search this folder').fill('needle'); await m.tick(250); await m.row('needle.txt').waitFor()
  await hold(m, 'Recursive'); await m.g.getByRole('button', { name: 'Measure this folder' }).click(); await m.page.waitForFunction(() => window.ctl.release); await m.tick()
  const n = await m.calls('c=>c.cancelInv.length'); await m.g.getByRole('button', { name: 'Clear search' }).click(); await m.tick()
  record('L3b-clear-keeps-explicit-measure', 'Clearing the search does not stop a Measure the person asked for', (await m.calls('c=>c.cancelInv.length')) === n && /Measuring/.test(await m.status() ?? ''), { cancelsAdded: (await m.calls('c=>c.cancelInv.length')) - n, footer: await m.status() }); await m.close()
  const p = await open(); await p.disk(DISK); await p.enter(); await p.tree(WORK); await p.grid.waitFor()
  await p.ctl("ctl.inv=(r,b)=>r.recursive&&r.relativePath==='Work'?{state:'partial',reason:'Directory coverage incomplete at Work/locked: EACCES',unreadable:1,entries:[{relativePath:'Work/deep',kind:'folder',logical:null,allocated:null},{relativePath:'Work/deep/needle.txt',kind:'file',logical:7,allocated:4096}]}:{}")
  await p.page.getByPlaceholder('Search this folder').fill('deep'); await p.row('deep').waitFor(); await p.tick(250)
  const banner = await p.g.locator('.vg-banner[role="status"]').innerText().catch(() => null)
  record('P2-partial-search-banner', 'A partial search says exactly which coverage is missing in its own banner (not only in the footer)', banner === 'Search coverage is incomplete: Directory coverage incomplete at Work/locked: EACCES. Some matches may be missing.', { banner }); await p.close()
  const q = await open({ init: DETAILS }); await q.disk(DISK); await q.enter(); await q.tree(WORK); await q.grid.waitFor()
  await q.ctl("ctl.inv=(r,b)=>r.recursive&&r.relativePath==='Work/deep'?{state:'complete',allocationUnknown:1,allocatedBytes:null,logicalBytes:12,entries:[{relativePath:'Work/deep/needle.txt',kind:'file',logical:7,allocated:null},{relativePath:'Work/deep/b.txt',kind:'file',logical:5,allocated:9000000}]}:{}")
  await q.row('deep').click(); await q.g.getByRole('button', { name: /Measure this folder/ }).click(); await q.tick(250)
  const cell = await q.row('deep').locator('.vg-c-size').innerText(), foot = await q.status(), n2 = await q.grid.getByRole('row').count() - 1
  record('T2b-footer-counts-only-exact', 'A floor from an otherwise complete scan shows as ≥ in the row and is not counted as a measured size', cell === '≥ 9 MB' && foot === `0 of ${n2} sizes measured`, { cell, foot, rows: n2 }); await q.close()
  const t = await open({ init: DETAILS }); await t.disk(DISK); await t.enter(); await t.grid.waitFor()
  await t.ctl("ctl.inv=(r,b)=>r.recursive&&r.relativePath==='Work'?{state:'partial',excluded:1,allocationUnknown:1,logicalBytes:300000000,allocatedBytes:null,entries:[{relativePath:'Work/a.png',kind:'file',logical:300000000,allocated:310000000},{relativePath:'Work/lnk',kind:'link',logical:null,allocated:null}]}:{}")
  await t.row('Work').click(); await t.g.getByRole('button', { name: 'Measure this folder' }).click(); await t.tick(250); const det = await t.details()
  record('T1b-partial-logical-floor', 'Details give a partial folder\'s File size as a floor too', /File size\s+≥ 300 MB/.test(det) && /Size on disk\s+≥ 310 MB/.test(det), { details: det.replace(/\s+/g, ' ').slice(0, 200) }); await t.close()
  const v = await open({ init: DETAILS }); await v.disk(DISK); await v.g.getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'Review Library', exact: true }).click(); await v.tick()
  await v.ctl("ctl.inv=(r,b)=>r.recursive&&r.relativePath===''?{state:'complete',logicalBytes:12345678,allocatedBytes:20000000,entries:[{relativePath:'x.bin',kind:'file',logical:12345678,allocated:20000000}]}:{}")
  const icon = await v.g.getByRole('button', { name: 'Close vault' }).locator('svg').count()
  await v.g.getByRole('button', { name: 'Measure vault' }).click(); await v.g.getByRole('button', { name: 'Measure whole vault' }).click(); await v.tick(250); const vd = await v.details()
  record('L4-vault-file-size-and-close-icon', 'A measured whole vault shows both Size on disk and File size; Close vault carries its icon', /Size on disk\s+20 MB/.test(vd) && /File size\s+12\.3 MB/.test(vd) && icon === 1, { details: vd.replace(/\s+/g, ' ').slice(0, 200), closeIcon: icon }); await v.close()
  const nf = await open(); await nf.disk(DISK); await nf.enter(); await nf.tree(WORK); await nf.grid.waitFor(); await nf.tick(250)
  const before = (await nf.calls('c=>c.inv')).filter(r => !r.recursive && r.relativePath === 'Work').length
  await nf.disk({ ...DISK, 'Work/fresh': { dir: 1 } }); await nf.bar.getByRole('button', { name: 'New folder' }).click(); const bx = nf.page.getByRole('textbox').last(); await bx.fill('fresh'); await bx.press('Enter'); await nf.tick(400)
  const after = (await nf.calls('c=>c.inv')).filter(r => !r.recursive && r.relativePath === 'Work').length
  record('N3e-new-folder-relists', 'A new folder is created and the folder is listed again, so its row shows without a manual Refresh', after > before && await nf.rows('fresh') === 1, { listingsBefore: before, listingsAfter: after, rows: await nf.rows('fresh'), writes: await nf.calls('c=>c.writes') }); await nf.close()
  const rn = await open(); await rn.disk(DISK); await rn.enter(); await rn.grid.waitFor(); await rn.row('Work').click(); await rn.bar.getByRole('button', { name: 'Rename', exact: true }).click(); const rb = rn.page.getByRole('textbox').last(); await rb.fill('Work 2'); await rb.press('Enter'); await rn.tick(400)
  const sel = await rn.row('Work 2').getAttribute('aria-selected').catch(() => null); const old = await rn.rows('Work'); await rn.row('Work 2').dblclick(); await rn.tick(300)
  record('C3b-rename-selects-and-catalogue-follows', 'Renaming a folder that holds talks selects the renamed row and the catalogue lists its talks under the new name', sel === 'true' && old === 0 && await rn.rows('Alpha talk') === 1, { selected: sel, oldRows: old, alphaUnderNew: await rn.rows('Alpha talk') }); await rn.close()
  const staleCover = async bypass => { const x = await open({ init: DETAILS }); await x.disk(DISK); await x.enter(); await x.tree(WORK); await x.grid.waitFor()
    await x.ctl(`ctl.holdPreview=true;ctl.bypassCancel=${bypass}`); await x.row('Beta talk').click(); await x.page.waitForFunction(() => window.ctl.held.length === 1)
    await x.ctl('ctl.rootGen=8;ctl.holdPreview=false;window.__stale=ctl.held.splice(0)'); await x.g.getByRole('button', { name: 'Refresh' }).click(); await x.page.waitForFunction(() => window.calls.catalogue >= 2); await x.tick(500)
    const fresh = (await x.details()).match(/Slides\s+(\d+)/)?.[1]; await x.ctl('window.__stale.forEach(r=>r())'); await x.tick(300)
    const final = (await x.details()).match(/Slides\s+(\d+)/)?.[1], img = await x.page.evaluate(() => decodeURIComponent(document.querySelector('[aria-label="Details"] img')?.src ?? '')); await x.close(); return { fresh, final, gen: img.match(/gen \d+/)?.[0] ?? null } }
  const sa = await staleCover(false), sb = await staleCover(true)
  record('S10-stale-cover-cannot-overwrite', 'A title-slide reply that left before a Refresh cannot replace the current facts (both when main cancels it and when it arrives late)', sa.fresh === sa.final && sb.fresh === sb.final && (sb.gen ?? 'gen 8') === 'gen 8' && (sa.gen ?? 'gen 8') === 'gen 8', { cancelled: sa, late: sb })
}

// A running open against the catalogue it stands on: every case runs the real selectGuardedTalk.
const STEPS = ['resolve', 'leave', 'resolve', 'claim', 'resolve', 'settle:true', 'adopt']
const VAULT_CHANGED = 'The vault changed while opening this talk. Choose it again from the current catalogue.'
const openState = async s => ({ order: await s.calls('c=>c.order'), adopted: await s.calls('c=>c.adopted ?? []'), claims: await s.calls('c=>c.claim.length'), alert: await s.g.getByRole('alert').innerText().catch(() => null), gallery: await s.g.count(), active: await s.page.evaluate(() => window.__active.outlinePath), owner: await s.page.evaluate(() => window.__owner) })
const startOpen = async hold => { const s = await open({ guarded: true }); await s.disk(DISK); await s.enter(); await s.tree(WORK); await s.grid.waitFor(); await s.row('Alpha talk').click(); await s.ctl(hold); await s.bar.getByRole('button', { name: 'Open talk' }).click(); return s }
const release = s => s.ctl('ctl.holdTalk=ctl.holdLeave=ctl.holdClaim=false;ctl.held.splice(0).forEach(r=>r())')
const holdCatalogue = s => s.ctl("window.__real=window.tw.vault.galleryCatalogue;window.tw.vault.galleryCatalogue=g=>new Promise(res=>{ctl.releaseCat=()=>window.__real(g).then(res)})")
const opened = r => r.adopted.length === 1 && r.gallery === 0 && r.order.join() === STEPS.join() && !r.alert
const refused = r => r.adopted.length === 0 && r.gallery === 1 && !!r.alert?.includes(VAULT_CHANGED) && r.active.includes('previous')
// Refused after the claim: told in the one wording, nothing adopted, exactly one claim, and that claim back on the talk still open.
const refusedAfterClaim = r => refused(r) && r.alert.startsWith(VAULT_CHANGED) && r.claims === 1 && r.owner === r.active
const lockFree = s => s.bar.getByRole('button', { name: 'Open talk' }).isEnabled({ timeout: 500 }).catch(() => false)
const answerThirdResolve = code => `(()=>{const real=window.tw.vault.galleryTalk;let n=0;window.tw.vault.galleryTalk=async(...a)=>{if(++n===3){calls.order.push('resolve');${code}}return real(...a)}})()`
async function lifecycle() {
  const c = await startOpen('0'); await c.tick(300); const r0 = await openState(c)
  record('O0-open-runs-every-step-in-order', 'Control: the open resolves, waits for leaving, revalidates, claims, revalidates, settles and adopts, in that order', opened(r0), r0); await c.close()
  const a = await startOpen('ctl.holdTalk=true'); await a.page.waitForFunction(() => window.ctl.held.length === 1); await a.ctl('ctl.setRev(2)'); await a.tick(200); await release(a); await a.tick(300); const r1 = await openState(a)
  record('O1-window-focus-during-resolve', 'A window focus while an open is resolving does not abandon it: the talk opens, every step in order', opened(r1), r1); await a.close()
  const b = await startOpen('ctl.holdLeave=true'); await b.page.waitForFunction(() => window.calls.leave >= 1); await b.ctl('ctl.setRev(2)'); await b.tick(200); await release(b); await b.tick(300); const r2 = await openState(b)
  record('O2-window-focus-during-leave-sheet', 'Someone who switches apps while the leave sheet is up and then leaves gets the talk they chose', opened(r2), r2); await b.close()
  const d = await startOpen('ctl.holdTalk=true'); await d.page.waitForFunction(() => window.ctl.held.length === 1); await d.ctl('ctl.rootGen=9;ctl.setRev(2)'); await d.tick(200); await release(d); await d.tick(300); const r3 = await openState(d)
  record('O3-real-root-change-during-resolve', 'Negative control: a real change of the vault set abandons the open with a message; nothing is claimed or adopted and the lock is free again', refused(r3) && r3.claims === 0 && await d.bar.getByRole('button', { name: 'Open talk' }).isEnabled(), r3); await d.close()
  const e = await startOpen('ctl.holdLeave=true'); await e.page.waitForFunction(() => window.calls.leave >= 1); await e.ctl('ctl.rootGen=9;ctl.setRev(2)'); await e.tick(200); await release(e); await e.tick(300); const r4 = await openState(e)
  record('O4-real-root-change-during-leave-sheet', 'A real change of the vault set while the leave sheet is up: told after leaving, nothing claimed or adopted', refused(r4) && r4.claims === 0, r4); await e.close()
  const f = await startOpen('ctl.holdLeave=true'); await f.page.waitForFunction(() => window.calls.leave >= 1); await holdCatalogue(f); await f.ctl('ctl.rootGen=9;ctl.setRev(2)'); await f.tick(120); await release(f); await f.tick(300); const r5 = await openState(f)
  record('O5-main-refuses-before-the-reply', 'The vault set changed and the new catalogue has not arrived: main refuses the revalidation, and the person is told', refused(r5) && r5.claims === 0, r5); await f.close()
  const g = await startOpen('ctl.holdLeave=true'); await g.page.waitForFunction(() => window.calls.leave >= 1); await g.ctl('ctl.closeGallery()'); await g.tick(150); await release(g); await g.tick(300); const r6 = await openState(g)
  record('O6-unmount-invalidates', 'A gallery that closed while an open waited claims and adopts nothing', r6.adopted.length === 0 && r6.claims === 0 && r6.active.includes('previous'), r6); await g.close()
  const h = await startOpen('ctl.holdLeave=true'); await h.page.waitForFunction(() => window.calls.leave >= 1); await h.ctl("ctl.renames.push(['Work/alpha','Work/renamed']);ctl.setRev(2)"); await h.tick(200); await release(h); await h.tick(300); const r7 = await openState(h)
  record('O7-talk-gone-from-the-catalogue', 'The same vault set no longer lists the talk: the open stops with a message, whatever an old reply says', refused(r7) && r7.claims === 0, r7); await h.close()
  const i = await startOpen('ctl.holdLeave=true'); await i.page.waitForFunction(() => window.calls.leave >= 1); await i.ctl('ctl.foreignTalk=true'); await release(i); await i.tick(300); const r8 = await openState(i)
  record('O8-identity-of-the-target', 'A revalidation that names another vault is not adopted', refused(r8) && r8.claims === 0, r8); await i.close()
  const j = await startOpen('ctl.holdClaim=true'); await j.page.waitForFunction(() => window.calls.claim.length >= 1); await j.ctl('ctl.rootGen=9;ctl.setRev(2)'); await j.tick(200); await release(j); await j.tick(300); const r9 = await openState(j)
  record('O9-root-change-during-claim', 'The vault set changes while the claim is on its way: the claim is settled back, nothing adopted, and the person is told', r9.adopted.length === 0 && r9.gallery === 1 && !!r9.alert && !r9.order.includes('settle:true') && !r9.order.includes('adopt'), r9); await j.close()
  record('O9b-stale-claim-one-wording', 'A claim refused as stale reads the same as every other vault change, with no Error prefix', !!r9.alert?.startsWith(VAULT_CHANGED), { alert: r9.alert })
  const k = await startOpen('ctl.refuseCommit=true'); await k.tick(300); const r10 = await openState(k), catalogues = await k.calls('c=>c.catalogue'), free = await lockFree(k)
  if (free) { await k.ctl('ctl.refuseCommit=false'); await k.bar.getByRole('button', { name: 'Open talk' }).click(); await k.tick(300) }
  const retried = await openState(k)
  record('P1-settle-refused-is-told', 'Main refuses the commit before the new catalogue arrives: told, nothing adopted, no second claim, the claim back, the lock free, and a second try opens', refusedAfterClaim(r10) && r10.order.join() === STEPS.slice(0, -1).join() && catalogues === 1 && free && retried.adopted.length === 1 && retried.gallery === 0 && retried.owner === retried.active, { ...r10, catalogues, free, retried: { adopted: retried.adopted, gallery: retried.gallery, owner: retried.owner } }); await k.close()
  const refusedStep = [...STEPS.slice(0, -2), 'settle:false']
  const l = await startOpen(answerThirdResolve("throw new Error('ipc failed')")); await l.tick(300); const r11 = await openState(l), free2 = await lockFree(l)
  record('P2-confirm-revalidation-rejects-is-told', 'The check after the claim rejects: the claim is settled back, nothing adopted, told, and the lock is free', refusedAfterClaim(r11) && r11.order.join() === refusedStep.join() && free2, { ...r11, free: free2 }); await l.close()
  const m = await startOpen(answerThirdResolve('return null')); await m.tick(300); const r12 = await openState(m)
  record('P3-confirm-revalidation-null-is-told', 'Control: the check after the claim answers null: settled back, nothing adopted, told', refusedAfterClaim(r12) && r12.order.join() === refusedStep.join(), r12); await m.close()
  const n = await startOpen('ctl.holdLeave=true;ctl.declineLeave=true'); await n.page.waitForFunction(() => window.calls.leave >= 1); await n.ctl('ctl.setRev(2)'); await n.tick(200); await release(n); await n.tick(300); const r13 = await openState(n), free3 = await lockFree(n)
  record('P4-declined-leave-stays-quiet', 'Someone who declines the leave sheet, with a window focus behind it, gets no message and the lock is free', r13.adopted.length === 0 && r13.gallery === 1 && r13.claims === 0 && !r13.alert && free3, { ...r13, free: free3 }); await n.close()
  const o = await startOpen('ctl.holdLeave=true;ctl.declineLeave=true'); await o.page.waitForFunction(() => window.calls.leave >= 1); await o.ctl('ctl.rootGen=9;ctl.setRev(2)'); await o.tick(200); await release(o); await o.tick(300); const r14 = await openState(o)
  record('P5-declined-leave-with-a-real-root-change-is-told', 'A declined leave sheet while the vault set really changed: told, nothing claimed or adopted', refused(r14) && r14.claims === 0, r14); await o.close()
}
// Facts stay on screen through a reload and are asked for again; what a reload cancelled is retried.
const editFacts = s => s.page.evaluate(() => { const f = window.tw.vault.galleryFacts; window.tw.vault.galleryFacts = async (...a) => { if (window.__holdEdits) await new Promise(r => window.ctl.held.push(r)); const r = await f(...a); return r && { ...r, revision: 'edited', slideCount: 77 } } })
async function freshFacts() {
  const s = await open(); await s.disk(DISK); await s.enter(); await s.tree(WORK); await s.grid.waitFor(); await s.tick(400)
  const cell = () => s.row('Beta talk').locator('.vg-c-contents').innerText(), before = await cell()
  await editFacts(s); await s.ctl('window.__holdEdits=true;ctl.setRev(2)'); await s.page.waitForFunction(() => window.ctl.held.length >= 1, null, { timeout: 2000 }).catch(() => { }); await s.tick(120)
  const during = await cell(), skeletons = await s.grid.locator('.vg-skel').count(); await s.ctl('window.__holdEdits=false;ctl.held.splice(0).forEach(r=>r())'); await s.tick(500); const after = await cell()
  record('RV1-window-focus-shows-edited-facts', 'An outline edited while the person was away keeps its old count on screen through the reload, then shows the new one', during === before && skeletons === 0 && /77/.test(after), { before, during, skeletons, after }); await s.close()
  const r = await open(); await r.disk(DISK); await r.enter(); await r.tree(WORK); await r.grid.waitFor(); await r.tick(400); const n = await r.calls('c=>c.facts.length')
  await r.page.evaluate(() => { const f = window.tw.vault.galleryFacts; window.tw.vault.galleryFacts = async (...a) => { const v = await f(...a); return v && { ...v, revision: 'edited', slideCount: 77 } }; window.tw.vault.galleryHandouts = async () => ({ status: 'published', partial: false, note: null, records: [{ key: 'k', kind: 'talk', title: 'H', link: 'https://example.invalid/h', site: 'linked', publishedAt: null, dateSource: 'record' }] }) })
  await r.g.getByRole('button', { name: 'Refresh' }).click(); await r.tick(500); const contents = await r.row('Beta talk').locator('.vg-c-contents').innerText(), hand = await r.row('Beta talk').locator('.vg-c-hand').innerText()
  record('RF1-refresh-rereads-facts', 'Refresh shows the current slide count and handout status', /77/.test(contents) && /1 handout/.test(hand), { contents, hand, readsAdded: (await r.calls('c=>c.facts.length')) - n }); await r.close()
  const b = await open(); await b.disk(DISK); await b.enter(); await b.grid.waitFor(); await b.tree(/^All talks/); await b.grid.waitFor(); await b.tick(500); const total = await b.grid.locator('.vg-row').count(), f0 = await b.calls('c=>c.facts.length'), rec0 = await b.calls('c=>c.inv.filter(r=>r.recursive).length'); await b.ctl('calls.maxActive=0;ctl.setRev(2)'); await b.tick(700)
  const added = await b.calls(`c=>new Set(c.facts.slice(${f0}).map(f=>f[1])).size`), peak = await b.calls('c=>c.maxActive'), rec1 = await b.calls('c=>c.inv.filter(r=>r.recursive).length'), listed = await b.calls('c=>c.listTalks')
  record('RV2-reload-stays-bounded', 'A window focus re-reads only visible rows, at most two at a time, with no recursive scan and no talk listing', added > 0 && added < total && peak <= 2 && rec1 === rec0 && listed === 0, { total, added, peak, recursiveAdded: rec1 - rec0, listed }); await b.close()
  const k = await open({ init: DETAILS }); await k.disk(DISK); await k.enter(); await k.tree(WORK); await k.grid.waitFor(); await k.tick(400); await k.ctl('ctl.holdPreview=true'); await k.row('Beta talk').click(); await k.page.waitForFunction(() => window.ctl.held.length === 1)
  await holdCatalogue(k); await k.ctl('ctl.setRev(2)'); await k.tick(100); await k.ctl('ctl.holdPreview=false;window.tw.vault.galleryCancelFacts();ctl.held.splice(0).forEach(r=>r())'); await k.tick(150); await k.ctl('ctl.releaseCat()'); await k.tick(500)
  const reads = await k.calls("c=>c.facts.filter(f=>f[2]===true).length"); await k.bar.getByRole('button', { name: 'More', exact: true }).click(); await k.tick(); const disabled = await k.g.getByRole('menuitem', { name: /Preview title slide/ }).isDisabled(), img = await k.g.getByRole('complementary', { name: 'Details' }).locator('img').count()
  record('C1-cancelled-title-slide-is-asked-again', 'List with Details: a title-slide read cancelled by a window focus is asked for again and Preview stays available', !disabled && img === 1 && reads >= 2, { previewDisabled: disabled, coverShown: img, reads }); await k.close()
  const o = await open({ init: DETAILS }); await o.disk(DISK); await o.enter(); await o.tree(/^All talks/); await o.grid.waitFor(); await o.tick(400); await o.ctl('ctl.holdPreview=true'); await o.row('Welcome to the review vault').click(); await o.page.waitForFunction(() => window.ctl.held.length === 1)
  await o.page.evaluate(() => { document.querySelector('.vg-content').scrollTop = 0 }); await o.tick(200); const away = await o.row('Welcome to the review vault').evaluate(e => e.getBoundingClientRect().top > document.querySelector('.vg-content').getBoundingClientRect().bottom)
  await holdCatalogue(o); await o.ctl('ctl.setRev(2)'); await o.tick(100); await o.ctl('ctl.holdPreview=false;window.tw.vault.galleryCancelFacts();ctl.held.splice(0).forEach(r=>r())'); await o.tick(150); await o.ctl('ctl.releaseCat()'); await o.tick(500); const shown = await o.g.getByRole('complementary', { name: 'Details' }).locator('img').count()
  record('C1b-cancelled-title-slide-of-a-hidden-row', 'The chosen talk scrolled out of view gets no fresh facts from the visible rows, and its cancelled title slide is still asked for again', away && shown === 1, { away, shown }); await o.close()
  const g = await open({ init: GALLERY }); await g.disk(DISK); await g.enter(); await g.tiles.waitFor(); await g.ctl('ctl.holdPreview=true'); await g.tree(WORK); await g.tile('Beta talk').waitFor(); await g.page.waitForFunction(() => window.ctl.held.length >= 1)
  await holdCatalogue(g); await g.ctl('ctl.setRev(2)'); await g.tick(100); await g.ctl('ctl.holdPreview=false;window.tw.vault.galleryCancelFacts();ctl.held.splice(0).forEach(r=>r())'); await g.tick(150); await g.ctl('ctl.releaseCat()'); await g.tick(700)
  const tiles = await g.tiles.locator('img').count(), stuck = await g.tiles.getByText('Title preview unavailable').count()
  record('C3-gallery-cover-retried', 'Gallery: covers cancelled by a window focus are read again', tiles > 0 && stuck === 0, { tiles, stuck }); await g.close()
  const p = await open(); await p.disk(DISK); await p.enter(); await p.tree(WORK); await p.grid.waitFor(); await p.tick(400); await p.row('Beta talk').click(); await p.ctl('ctl.holdPreview=true'); await p.row('Beta talk').focus(); await p.page.keyboard.press('Space'); await p.page.waitForFunction(() => window.ctl.held.length === 1)
  await p.ctl('ctl.setRev(2)'); await p.tick(250); await p.ctl('ctl.holdPreview=false;ctl.held.splice(0).forEach(r=>r())'); await p.tick(400); const sheet = await p.g.getByRole('region', { name: /Title preview/ }).innerText().catch(() => '')
  record('C2-preview-sheet-through-window-focus', 'The open title preview gets its slide after a window focus cancelled the read', !/pending|unavailable/.test(sheet), { sheet: sheet.replace(/\s+/g, ' ') }); await p.close()
  const h = await open(); await h.disk(DISK); await h.enter(); await h.ctl('ctl.handoutHold=true'); await h.tree(/^All talks/); await h.grid.waitFor(); await h.tick(400); const off = 'Welcome to the review vault'
  await h.row(off).click(); await h.page.evaluate(() => { document.querySelector('.vg-content').scrollTop = 0 }); await h.tick(300); const hidden = await h.row(off).evaluate(e => e.getBoundingClientRect().top > document.querySelector('.vg-content').getBoundingClientRect().bottom)
  const asked0 = await h.calls('c=>c.handouts.length'); await h.bar.getByRole('button', { name: 'Handouts', exact: true }).click(); await h.page.waitForFunction(n => window.calls.handouts.length > n, asked0)
  const sheetBox = h.page.getByRole('dialog', { name: /Published handouts/ }), asked = await h.calls('c=>c.handouts.length'); await h.ctl('ctl.handoutHold=false;ctl.heldHandouts.length=0;ctl.setRev(2)'); await h.tick(400); const text = await sheetBox.innerText()
  record('C4-handouts-sheet-through-window-focus', 'An open handouts sheet whose read was cancelled by a window focus asks again, even for a row scrolled out of view', hidden && /Not published/.test(text), { hidden, asked, text: text.replace(/\s+/g, ' ').slice(0, 90) }); await h.close()
  // A revision with no title slide, then a re-ask that main answers with null: an outline it refuses while the catalogue still lists the talk.
  const answerBeta = (s, reply) => s.page.evaluate(`(()=>{const base=window.__baseFacts??(window.__baseFacts=window.tw.vault.galleryFacts);window.tw.vault.galleryFacts=(v,p,c)=>{if(p!=='Work/beta/beta-outline.md')return base(v,p,c);calls.facts.push([v,p,c,0]);return Promise.resolve(${reply})}})()`)
  const betaReads = s => s.calls("c=>c.facts.filter(f=>f[1]==='Work/beta/beta-outline.md').length")
  const q = await open({ init: GALLERY }); await q.disk(DISK); await q.enter(); await q.tiles.waitFor(); await answerBeta(q, "{revision:'rx',slideCount:12,imageCount:1,editedMs:0,coverUrl:null,preview:c?'unavailable':'pending'}"); await q.tree(WORK); await q.tile('Beta talk').waitFor(); await q.tick(500); const tileBefore = await q.tile('Beta talk').innerText()
  await answerBeta(q, 'null'); const reads0 = await betaReads(q); await q.ctl('ctl.setRev(2)'); await q.tick(700); const tileAfter = await q.tile('Beta talk').innerText(), askedAgain = await betaReads(q) - reads0
  record('Q1-reset-to-pending-then-null-reply', 'A title slide known to be unavailable, then a re-ask answered null: the tile says unavailable, not pending for good, keeps the facts it had and asks once', /Title preview unavailable/.test(tileBefore) && /Title preview unavailable/.test(tileAfter) && !/pending/.test(tileAfter) && /12 slides/.test(tileAfter) && askedAgain === 1, { tileBefore: tileBefore.replace(/\s+/g, ' ').slice(0, 60), tileAfter: tileAfter.replace(/\s+/g, ' ').slice(0, 60), askedAgain }); await q.close()
}
// Focus is one request.
async function focusOnce() {
  for (const [name, init] of [['List', undefined], ['Gallery', GALLERY]]) {
    const s = await open({ init }); await s.disk(DISK); await s.enter(); await (s.tiles.or(s.grid)).first().waitFor()
    const item = name === 'List' ? s.row('Work') : s.tile('Work'); await item.click(); await item.focus(); await s.page.keyboard.press('Enter'); await inWork(s); await s.tick(250)
    const box = s.page.getByPlaceholder('Search this folder'); await box.click(); await s.page.keyboard.type('qqq', { delay: 40 }); await s.tick(300); await s.page.keyboard.press('Backspace'); await s.page.keyboard.press('Backspace'); await s.page.keyboard.press('Backspace'); await s.tick(300); const act = await s.active(); await s.page.keyboard.type('al', { delay: 40 }); await s.tick(150)
    record(`FR1-${name}-backspace-keeps-search`, `${name}: a search that emptied the list and is backspaced away keeps focus, and the next typing goes to the box`, act.tag === 'INPUT' && (await box.inputValue()) === 'al', { act, value: await box.inputValue() })
    await box.fill('qqq'); await s.tick(300); await s.g.getByRole('button', { name: 'Clear search' }).click(); await s.tick(300)
    record(`FR2-${name}-clear-keeps-search`, `${name}: Clear search leaves focus in the search box`, (await s.active()).tag === 'INPUT', { active: await s.active() }); await s.close()
  }
  const v = await open(); await v.disk(DISK); await v.enter(); await v.grid.waitFor(); await v.row('Work').click(); await v.row('Work').focus(); await v.page.keyboard.press('Enter'); await inWork(v); await v.tick(250); await v.g.getByRole('button', { name: 'Gallery', exact: true }).click(); await v.tick(300)
  record('FR3-view-switch-keeps-toggle', 'Switching view after Enter on a folder keeps focus on the toggle', (await v.active()).tag === 'BUTTON', { active: await v.active() }); await v.close()
  const w = await open(); await w.disk({ ...DISK, Late: { dir: 1 }, 'Late/only-on-disk': { dir: 1 } }); await w.enter(); await w.grid.waitFor(); await w.tick(200); await hold(w, 'Listing'); await w.row('Late').click(); await w.row('Late').focus(); await w.page.keyboard.press('Enter'); await w.page.waitForFunction(() => window.ctl.release); await w.tick(200)
  await w.page.getByPlaceholder('Search this folder').click(); await w.page.keyboard.type('on', { delay: 30 }); await w.ctl('ctl.holdListing=false;ctl.release()'); await w.tick(300)
  record('FR4-moved-on-before-rows-arrive', 'Someone who moved to the search box before the rows arrived keeps their place', (await w.active()).tag === 'INPUT', { active: await w.active() }); await w.close()
  const f = await open(); await f.disk({ ...DISK, Late: { dir: 1 }, 'Late/only-on-disk': { dir: 1 } }); await f.enter(); await f.grid.waitFor(); await f.tick(200); await hold(f, 'Listing'); await f.row('Late').click(); await f.row('Late').focus(); await f.page.keyboard.press('Enter'); await f.page.waitForFunction(() => window.ctl.release); await f.tick(200); await f.ctl('ctl.holdListing=false;ctl.release()'); await f.tick(300)
  record('F7-rows-from-listing-take-focus', 'Enter on a folder whose only rows come from the disk listing: focus lands on the first row when it arrives, not on the panel before it', (await f.active()).label === 'only-on-disk', { active: await f.active() }); await f.close()
}
async function menuFocus() {
  const s = await open(); await s.disk(DISK); await s.enter(); await s.tree(WORK); await s.grid.waitFor(); await s.tick(300); await s.row('Alpha talk').click(); await s.bar.getByRole('button', { name: 'More', exact: true }).click(); await s.tick(); const entered = await s.page.evaluate(() => !!document.activeElement?.closest('[role=menu]'))
  await s.page.keyboard.press('Shift+Tab'); await s.tick(); const menus = await menuOf(s).count(), out = await s.active(); await s.ctl('ctl.setRev(2)'); await s.tick(300); const inMenu = await s.page.evaluate(() => !!document.activeElement?.closest('[role=menu]'))
  record('ME1-tab-leaves-menu', 'Tab closes the menu and focus stays out through a later re-render', entered && menus === 0 && !inMenu && out.inGallery, { entered, menus, out, inMenu }); await s.close()
  const p = await open(); await p.disk(DISK); await p.enter(); await p.tree(WORK); await p.grid.waitFor(); await p.row('Alpha talk').click(); await p.bar.getByRole('button', { name: 'More', exact: true }).click(); await p.tick(); await p.page.getByPlaceholder('Search this folder').click(); await p.tick()
  record('ME2-press-away-closes-menu', 'A press on something that is not a row closes the menu', await menuOf(p).count() === 0, { menus: await menuOf(p).count(), active: await p.active() }); await p.close()
  const b = await open({ w: 800, h: 600 }); await b.disk(DISK); await b.enter(); await b.grid.waitFor(); await b.tick(250); const r = b.row('Welcome to the review vault'); await r.scrollIntoViewIfNeeded(); await b.tick(); const box = await r.boundingBox(); await b.page.mouse.click(Math.min(box.x + box.width - 8, 792), Math.min(box.y + 12, 592), { button: 'right' }); await b.tick(150)
  const m = await menuOf(b).boundingBox(), n = await items(b), bin = await b.g.getByRole('menuitem', { name: /Move to Bin/ }).boundingBox()
  record('MB1-menu-inside-the-window', 'At 800x600 a right-click at the bottom right keeps all eight items inside the window', n.length === 8 && m.x >= 0 && m.y >= 0 && m.x + m.width <= 800 && bin.y + bin.height <= 600, { menu: m, count: n.length, bin }); await b.close()
  const c = await open(); await c.disk(DISK); await c.enter(); await c.tree(WORK); await c.grid.waitFor(); await hold(c, 'Recursive'); await c.page.getByPlaceholder('Search this folder').fill('needle'); await c.page.waitForFunction(() => window.ctl.release); await c.tick(); await c.g.getByRole('button', { name: 'Clear search' }).click(); await c.tick(250)
  record('L3c-clear-resets-footer', 'Clearing the search leaves no Measuring label and Refresh usable again', !/Measuring|Searching/.test(await c.status() ?? '') && await c.g.getByRole('button', { name: 'Refresh' }).isEnabled(), { footer: await c.status() }); await c.close()
  const d = await open(); await d.disk(DISK); await d.enter(); await d.tree(WORK); await d.grid.waitFor(); await d.row('Alpha talk').click(); await d.bar.getByRole('button', { name: 'Move', exact: true }).click(); const dialog = d.page.getByRole('dialog', { name: 'Move talk within this vault' }); await dialog.waitFor(); await d.tick(); await d.ctl('ctl.holdTalk=true')
  await d.page.evaluate(() => document.querySelector('[role="row"][aria-label="Beta talk"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await d.tick(); await dialog.getByRole('option', { name: /^Archive/ }).click(); await dialog.getByRole('button', { name: 'Move here' }).click(); await d.tick()
  record('ML2-refused-modal-stays', 'Scripted only (no real input reaches it past the inert gallery): a Move submitted under a held lock stays open and writes nothing', await dialog.count() === 1 && (await d.calls('c=>c.writes.length')) === 0, { dialog: await dialog.count(), writes: await d.calls('c=>c.writes') }); await d.close()
}
// The approved states of a24, a22, a29 and a18.
const STORED = { ...DISK, research: { dir: 1 }, 'Reference library': { kind: 'link', logical: 40, allocated: 4096 }, 'Workshop archive alias': { kind: 'alias', logical: 900, allocated: 4096 }, 'README.md': { kind: 'file', logical: 8000, allocated: 8192 } }
const glyph = l => l.locator('svg').first().getAttribute('class')
async function approved() {
  const details = DETAILS
  const s = await open({ init: details }); await s.disk(STORED); await s.enter(); await s.grid.waitFor(); await showSystem(s); await s.row('Reference library').waitFor(); await s.tick(200)
  const names = await s.grid.locator('.vg-row .vg-c-name .vg-tx').allTextContents(), at = n => names.indexOf(n)
  const inOrder = at('Work') < at('_PRESENTATIONS') && at('_PRESENTATIONS') < at('assets') && at('assets') < at('research') && at('research') < at('file.txt') && at('file.txt') < at('Reference library') && at('Reference library') < at('Workshop archive alias') && at('Workshop archive alias') < at('Welcome to the review vault')
  await s.grid.getByRole('button', { name: 'Name' }).click(); await s.tick(); const desc = await s.grid.locator('.vg-row .vg-c-name .vg-tx').allTextContents()
  record('V1-approved-row-order', 'Folders, system folders, files and links, then talks; sorting works inside each group and never mixes them', inOrder && desc.indexOf('Archive') < desc.indexOf('research') && desc.indexOf('research') < desc.indexOf('Workshop archive alias') && desc.indexOf('file.txt') < desc.indexOf('Welcome to the review vault'), { names, desc }); await s.grid.getByRole('button', { name: 'Name' }).click(); await s.tick()
  const icon = async n => (await glyph(s.row(n)))?.match(/lucide-([a-z-]+)/g)?.at(-1)
  const icons = { assets: await icon('assets'), research: await icon('research'), system: await icon('_PRESENTATIONS'), file: await icon('file.txt'), link: await icon('Reference library'), alias: await icon('Workshop archive alias') }
  await s.row('assets').click(); await s.tick(); const detailIcon = (await glyph(s.g.getByRole('complementary', { name: 'Details' }).locator('h2')))?.match(/lucide-([a-z-]+)/g)?.at(-1)
  record('V3-approved-icons', 'assets the image mark and research the flask (row and Details), system the archive box, a file or alias the file mark, a link the link mark', icons.assets === 'lucide-image' && icons.research === 'lucide-flask-conical' && icons.system === 'lucide-archive' && icons.file === 'lucide-file' && icons.link === 'lucide-link' && icons.alias === 'lucide-file' && detailIcon === 'lucide-image', { icons, detailIcon })
  const cells = async n => ({ contents: await s.row(n).locator('.vg-c-contents').innerText(), size: await s.row(n).locator('.vg-c-size').innerText() })
  const v4 = { assets: await cells('assets'), system: await cells('_PRESENTATIONS'), research: await cells('research'), file: await cells('file.txt'), link: await cells('Reference library'), alias: await cells('Workshop archive alias') }
  record('V4-approved-cells', 'Contents is a dash for assets and system folders; File, Link and Finder alias for stored items; a link has a dash for size', v4.assets.contents === '—' && v4.system.contents === '—' && v4.research.contents === '—' && v4.file.contents === 'File' && v4.link.contents === 'Link' && v4.alias.contents === 'Finder alias' && v4.link.size === '—' && v4.alias.size === '4.1 KB', v4); await s.close()
  const cl = await open({ init: details }); await cl.tree(/Past workshops/); await cl.tick(); const closedGlyph = await glyph(cl.g.locator('.vg-blank')), closedFoot = await cl.g.locator('.vg-status').innerText(), closedDetails = await cl.details()
  record('V5-closed-state', 'Closed vault: the folder-closed mark and a footer that says Closed', /lucide-folder-closed/.test(closedGlyph ?? '') && closedFoot.trim() === 'Closed', { closedGlyph, closedFoot }); await cl.close()
  const nc = await open({ init: details }); await nc.tree(/Offline drive/); await nc.tick(); const offGlyph = await glyph(nc.g.locator('.vg-blank')), offFoot = await nc.g.locator('.vg-status').innerText(), offDetails = await nc.details()
  record('V6-not-connected-state', 'Not connected: the footer says so and Details does not offer to open a vault that cannot open; the closed vault keeps its hint', /lucide-unplug/.test(offGlyph ?? '') && offFoot.trim() === 'Not connected' && !/Open the vault to browse/.test(offDetails) && /Open the vault to browse/.test(closedDetails), { offGlyph, offFoot, offDetails: offDetails.replace(/\s+/g, ' ').slice(0, 120) }); await nc.close()
  const ov = await open({ init: details }); const rows = ov.g.getByRole('grid', { name: 'Vaults' }); await rows.getByRole('row', { name: 'Offline drive' }).click(); await ov.tick(); const ovFoot = await ov.g.locator('.vg-status').innerText(), ovDetails = await ov.details()
  record('V6b-overview-not-connected', 'All vaults with a not-connected vault selected: still counts vaults in the footer, no hint to open it', /^4 items/.test(ovFoot.trim()) && !/Open the vault to browse/.test(ovDetails), { ovFoot }); await ov.close()
  const m = await open(); await m.disk(DISK); await m.enter(); await m.tree(WORK); await m.grid.waitFor(); await m.row('Alpha talk').click({ button: 'right' }); await m.tick()
  const hot = await menuOf(m).getByRole('menuitem').first().evaluate(e => ({ focused: e === document.activeElement, bg: getComputedStyle(e).backgroundColor })), plain = await menuOf(m).getByRole('menuitem').nth(1).evaluate(e => getComputedStyle(e).backgroundColor)
  record('V7-menu-shows-focus-after-a-mouse-right-click', 'Approved a18: the first item is highlighted after a right-click', hot.focused && hot.bg !== plain, { hot, plain }); await m.close()
  const x = await open({ init: details }); await x.disk(DISK); await x.enter(); await x.grid.waitFor(); await showSystem(x); await x.row('assets').waitFor(); await x.row('assets').click()
  await x.ctl("ctl.inv=(r,b)=>r.recursive&&r.relativePath==='assets'?{state:'partial',excluded:1,allocationUnknown:1,logicalBytes:50000000,allocatedBytes:null,entries:[{relativePath:'assets/a.png',kind:'file',logical:50000000,allocated:41500000},{relativePath:'assets/l',kind:'link',logical:null,allocated:null}]}:{}")
  await x.g.getByRole('button', { name: /Measure this/ }).click(); await x.tick(250); const det = await x.details(), cell = await x.row('assets').locator('.vg-c-size').innerText()
  record('T4b-partial-note-on-a-system-folder', 'A partly measured assets or system folder shows a floor and says the total is incomplete', cell === '≥ 41.5 MB' && /Incomplete total/.test(det), { cell, details: det.replace(/\s+/g, ' ').slice(0, 170) }); await x.close()
}
try {
  await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: harnessSource(src) }, bundle: true, outfile: join(tmp, 'bundle.js'), platform: 'browser', jsx: 'automatic', logLevel: 'error' })
  await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: guardedHarnessSource(src) }, bundle: true, outfile: join(tmp, 'guarded.js'), platform: 'browser', jsx: 'automatic', logLevel: 'error' })
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  console.log(`# src=${src}\n# browser version=${browser.version()}`)
  for (const [name, f] of Object.entries(Object.fromEntries(Object.entries({ allTalks, galleryFocus, menu, reload, search, busy, truth, finalMenus, finalReload, finalSearchAndLists, focusLeftover, lifecycle, freshFacts, focusOnce, menuFocus, approved }).filter(([name]) => !process.env.VG_ONLY || process.env.VG_ONLY.split(',').includes(name))))) {
    try { await f() } catch (e) { record(`ERR-${name}`, 'probe group finished', false, { error: String(e).split('\n').slice(0, 8).join(' / ') }) }
  }
} finally {
  await browser?.close(); rmSync(tmp, { recursive: true, force: true })
  if (process.env.VG_RESULTS) writeFileSync(process.env.VG_RESULTS, JSON.stringify({ src, results }, null, 1))
}
const failed = results.filter(r => !r.holds); console.log(`${results.length} probes, ${failed.length} contract failures: ${failed.map(f => f.id).join(' ')}`); process.exit(failed.length ? 1 : 0)
