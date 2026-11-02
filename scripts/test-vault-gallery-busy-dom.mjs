// One operation at a time: every activate route respects the write lock, an open never releases a running write's lock,
// double Enter claims once; management dialogs survive a vault-list change and still complete their action.
import assert from 'node:assert/strict'
import { startHarness, DISK } from './lib/vault-gallery-repair-harness.mjs'
const h = await startHarness()
try {
  const s = await h.open(); await s.enter(); await s.tree(/^Work \d/); await s.row('Alpha talk').click()
  await s.ctl('ctl.holdMove=true'); await s.bar.getByRole('button', { name: 'Move', exact: true }).click()
  const d = s.page.getByRole('dialog', { name: 'Move talk within this vault' }); await d.getByRole('option', { name: /^Archive/ }).click(); await d.getByRole('button', { name: 'Move here' }).click()
  await s.page.waitForFunction(() => window.calls.writes.some(w => w[0] === 'move')); await s.settle()
  assert.equal(await s.bar.getByRole('button', { name: 'Open talk' }).isDisabled(), true)
  const talkCalls = await s.calls('c=>c.talk.length')
  await s.row('Beta talk').dblclick(); await s.row('Beta talk').focus(); await s.page.keyboard.press('Enter'); await s.settle()
  assert.equal((await s.calls('c=>c.open.length')), 0, 'no open starts during a write, by double-click or Enter')
  assert.equal((await s.calls('c=>c.talk.length')), talkCalls, 'and no talk is even resolved')
  await s.ctl('ctl.held.splice(0).forEach(r=>r())'); await s.settle(); await s.close()

  // an open that ends does not unlock a running write; double Enter starts one open
  const t = await h.open(); await t.enter(); await t.tree(/^Work \d/); const row = t.row('Alpha talk'); await row.click(); await row.focus()
  await t.ctl('ctl.holdTalk=true'); await t.page.keyboard.press('Enter'); await t.page.keyboard.press('Enter'); await t.settle()
  assert.equal(await t.calls('c=>c.talk.length'), 1, 'double Enter claims once')
  assert.equal(await t.bar.getByRole('button', { name: 'Open talk' }).isDisabled(), true, 'toolbar is locked while the open runs')
  await t.ctl('ctl.holdTalk=false;ctl.held.splice(0).forEach(r=>r())'); await t.settle()
  assert.equal(await t.calls('c=>c.open.length'), 1)
  assert.equal(await t.bar.getByRole('button', { name: 'Open talk' }).isDisabled(), false, 'the lock is released when the open ends')
  await t.close()

  // a Rename dialog with typed text survives a vault-list change and then completes
  const m = await h.open(); await m.enter(); await m.tree(/^Work \d/); await m.row('Alpha talk').click()
  await m.bar.getByRole('button', { name: 'Rename', exact: true }).click()
  const box = m.page.getByRole('textbox').last(); await box.waitFor(); await box.fill('half typed')
  const c0 = await m.calls('c=>c.catalogue'); await m.ctl('ctl.setRev(2)'); await m.page.waitForFunction(n => window.calls.catalogue > n, c0); await m.settle()
  assert.equal(await m.page.locator('.vg-management-layer').count(), 1, 'dialog survives the reload')
  assert.equal(await m.page.getByRole('textbox').last().inputValue(), 'half typed', 'typed text survives')
  await m.page.keyboard.press('Escape'); await m.close()

  // a folder Bin confirmation survives a reload and its action still runs
  const b = await h.open(); await b.tree0(DISK); await b.enter(); await b.row('Archive').click()
  await b.bar.getByRole('button', { name: 'Move to Bin' }).click(); await b.page.getByRole('dialog').last().waitFor()
  const c1 = await b.calls('c=>c.catalogue'); await b.ctl('ctl.setRev(2)'); await b.page.waitForFunction(n => window.calls.catalogue > n, c1); await b.settle()
  await b.page.getByRole('dialog').last().getByRole('button', { name: 'Delete', exact: true }).click(); await b.settle()
  assert.deepEqual((await b.calls('c=>c.writes')).map(w => w[0]), ['deleteFolder'], 'the confirmed action ran after the reload')
  assert.deepEqual(b.errors, []); await b.close()
  console.log('PASS unified busy admission on every route, lock kept while a write runs, double Enter once, dialogs survive reload and still act')
} finally { await h.close() }
