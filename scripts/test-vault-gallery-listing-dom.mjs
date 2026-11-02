// Direct listing vs measurement, Refresh and Check again, driven with deferred scans and emitted progress.
import assert from 'node:assert/strict'
import { startHarness, DISK, emitProgress } from './lib/vault-gallery-repair-harness.mjs'
const h = await startHarness()
try {
  // Measuring a selected talk keeps the folder's disk-only and system rows; Stop keeps them.
  const s = await h.open(); await s.tree0(DISK); await s.enter(); await s.tree(/^Work \d/)
  await s.row('disk-only').waitFor()
  await s.g.getByRole('button', { name: 'Show assets and system folders' }).click(); await s.row('file.txt').waitFor()
  await s.ctl('ctl.holdRecursive=true')
  await s.row('Alpha talk').click(); await s.g.getByRole('button', { name: 'Measure this talk' }).click(); await s.settle()
  assert.deepEqual([await s.rows('disk-only'), await s.rows('file.txt')], [1, 1], 'rows stay while a child measures')
  await emitProgress(s, { entries: [{ relativePath: 'Work/alpha/x.png', kind: 'file', logical: 1, allocated: 4096 }] }); await s.settle()
  assert.deepEqual([await s.rows('disk-only'), await s.rows('file.txt')], [1, 1], 'a progress event keeps the listing')
  assert.equal(await s.row('Alpha talk').getAttribute('aria-selected'), 'true', 'selection survives')
  await s.g.getByRole('button', { name: 'Stop', exact: true }).click(); await s.settle()
  assert.deepEqual([await s.rows('disk-only'), await s.rows('file.txt')], [1, 1], 'Stop keeps the listing')
  await s.ctl('ctl.release&&ctl.release()'); await s.close()

  // Measuring the folder: progress carries only entries visited so far; direct rows and a selected disk-only row stay.
  const p = await h.open(); await p.tree0(DISK); await p.enter(); await p.tree(/^Work \d/); await p.row('disk-only').waitFor()
  await p.row('disk-only').click()
  await p.ctl('ctl.holdRecursive=true'); await p.g.getByRole('button', { name: 'Measure this folder' }).click(); await p.settle()
  await emitProgress(p, { relativePath: 'Work', entries: [{ relativePath: 'Work/alpha', kind: 'folder', logical: null, allocated: null }] }); await p.settle()
  assert.equal(await p.rows('disk-only'), 1); assert.equal(await p.row('disk-only').getAttribute('aria-selected'), 'true')
  await p.g.getByRole('button', { name: 'Stop', exact: true }).click(); await p.settle()
  assert.equal(await p.rows('disk-only'), 1); assert.equal(await p.row('disk-only').getAttribute('aria-selected'), 'true')
  await p.close()

  // Refresh is a cached re-read: no host refresh, no host listing; Check again uses the recheck path only.
  const r = await h.open(); await r.tree0(DISK); await r.enter(); await r.tree(/^Work \d/); await r.row('disk-only').waitFor()
  const catalogues = await r.calls('c=>c.catalogue'), inv = (await r.calls('c=>c.inv')).length
  await r.g.getByRole('button', { name: 'Refresh' }).click(); await r.settle()
  assert.deepEqual(await r.calls('c=>[c.refresh,c.listTalks]'), [0, 0], 'footer Refresh never lists talks on the host')
  assert.ok((await r.calls('c=>c.catalogue')) > catalogues, 'it re-reads the cached catalogue'); assert.ok((await r.calls('c=>c.inv')).length > inv, 'and the directory listing')
  assert.equal(await r.rows('disk-only'), 1, 'rows are not blanked by Refresh')
  await r.g.getByRole('treeitem', { name: /All vaults/ }).click()
  await r.g.getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'Offline drive', exact: true }).click()
  await r.g.getByRole('button', { name: 'Check again' }).click(); await r.settle()
  assert.deepEqual(await r.calls('c=>[c.refresh,c.recheck,c.listTalks]'), [0, 1, 0], 'Check again uses the existing recheck path')
  assert.deepEqual(r.errors, []); await r.close()
  console.log('PASS measurement never removes the listing or selection (progress and Stop), Refresh is a cached re-read, Check again rechecks only')
} finally { await h.close() }
