// Stored-file search through the real gallery (ports the original hard contracts to the normal list):
// folder search is recursive and delivers disk files, no false empty while it runs or after partial coverage,
// query updates and Refresh keep the match, the root asks first and stays non-recursive on Refresh.
import assert from 'node:assert/strict'
import { startHarness, DISK } from './lib/vault-gallery-repair-harness.mjs'
const h = await startHarness()
try {
  // ---- folder search
  const s = await h.open(); await s.tree0(DISK); await s.enter(); await s.tree(/^Work \d/); await s.grid.waitFor()
  await s.page.getByPlaceholder('Search this folder').fill('alpha'); await s.settle()
  assert.equal(await s.rows('Alpha talk'), 1, 'catalogue talks are found')
  await s.ctl('ctl.holdRecursive=true')
  await s.page.getByPlaceholder('Search this folder').fill('needle')
  await s.page.waitForFunction(() => window.calls.inv.at(-1).recursive === true); await s.settle()
  assert.deepEqual([(await s.lastInv()).relativePath, (await s.lastInv()).recursive], ['Work', true], 'folder search issues the recursive request')
  let body = await s.text()
  assert.doesNotMatch(body, /No results|Nothing matches/, 'no false empty while the search runs')
  assert.match(body, /Searching/i)
  await s.ctl('ctl.release()'); await s.settle()
  await s.row('needle.txt').waitFor()
  assert.equal(await s.page.getByText('No results').count(), 0)
  // the match is inspect-only and shows without the assets toggle
  await s.row('needle.txt').click()
  assert.equal(await s.bar.getByRole('button', { name: /Rename|Move|Duplicate|Bin/ }).count(), 0)
  // query update keeps the match
  await s.page.getByPlaceholder('Search this folder').fill('needle.tx'); await s.settle()
  await s.page.waitForFunction(() => window.ctl.release || true); await s.ctl('ctl.release&&ctl.release()'); await s.settle()
  assert.equal(await s.rows('needle.txt'), 1, 'query update retains the nested match')
  // Refresh re-asks recursively, keeps the query and the match, and never asks the host
  const before = (await s.calls('c=>c.inv')).length
  await s.g.getByRole('button', { name: 'Refresh' }).click(); await s.settle()
  const after = (await s.calls('c=>c.inv')).slice(before)
  assert.ok(after.some(r => r.recursive && r.relativePath === 'Work'), 'Refresh re-issues the recursive folder request')
  assert.equal(await s.rows('needle.txt'), 1, 'the match stays while Refresh re-scans')
  await s.ctl('ctl.release&&ctl.release()'); await s.settle()
  assert.equal(await s.rows('needle.txt'), 1, 'and after it')
  assert.equal(await s.page.getByPlaceholder('Search this folder').inputValue(), 'needle.tx')
  assert.deepEqual(await s.calls('c=>[c.refresh,c.listTalks]'), [0, 0], 'Refresh is not a host listing')
  // a stopped or incomplete search never claims there is nothing
  await s.page.getByPlaceholder('Search this folder').fill('zzz-none'); await s.page.waitForFunction(() => window.calls.inv.at(-1).recursive)
  await s.g.getByRole('button', { name: 'Stop', exact: true }).click(); await s.settle()
  body = await s.text()
  assert.doesNotMatch(body, /No results(?! so far)/, 'a stopped search is incomplete, not empty'); assert.match(body, /No results so far/); assert.match(body, /incomplete|Stopped/i)
  await s.ctl('ctl.release&&ctl.release()'); await s.settle()
  assert.deepEqual(s.errors, []); await s.close()

  // ---- partial coverage with a hit: shown, flagged incomplete
  const p = await h.open(); await p.tree0(DISK); await p.enter(); await p.tree(/^Work \d/)
  await p.ctl("ctl.inv=(r,e)=>r.recursive?{state:'partial',reason:'Directory coverage incomplete at Work/locked: EACCES',unreadable:1}:{}")
  await p.page.getByPlaceholder('Search this folder').fill('needle'); await p.row('needle.txt').waitFor()
  assert.match(await p.text(), /incomplete/i); await p.close()

  // ---- vault root: typing never scans, confirmation first, then results are delivered; Refresh stays non-recursive
  const r = await h.open(); await r.tree0(DISK); await r.enter()
  const n = (await r.calls('c=>c.inv')).length
  await r.page.getByPlaceholder('Search this vault').fill('needle'); await r.g.getByRole('button', { name: 'Search whole vault' }).waitFor()
  assert.equal((await r.calls('c=>c.inv')).length, n, 'typing at the root starts no scan')
  assert.equal(await r.rows('needle.txt'), 0)
  await r.ctl('ctl.holdRecursive=true')
  await r.g.getByRole('button', { name: 'Search whole vault' }).click()
  await r.g.getByRole('group', { name: 'Confirm whole-vault measurement' }).waitFor()
  assert.equal((await r.calls('c=>c.inv')).length, n, 'confirmation comes first')
  await r.g.getByRole('button', { name: 'Measure whole vault' }).click(); await r.page.waitForFunction(() => window.ctl.release)
  assert.deepEqual([(await r.lastInv()).relativePath, (await r.lastInv()).recursive, (await r.lastInv()).confirmedRoot], ['', true, true])
  assert.doesNotMatch(await r.text(), /No results/)
  await r.ctl('ctl.release()'); await r.row('needle.txt').waitFor()
  await r.g.getByRole('button', { name: 'Refresh' }).click(); await r.settle()
  const last = await r.lastInv()
  assert.deepEqual([last.recursive, last.confirmedRoot], [false, false], 'root Refresh with a query stays non-recursive')
  assert.deepEqual(await r.calls('c=>[c.refresh,c.listTalks]'), [0, 0])
  assert.deepEqual(r.errors, []); await r.close()
  console.log('PASS folder and whole-vault stored-file search: recursive request, delivered rows, no false empty, query update and Refresh keep the match, root asks first and Refresh stays non-recursive')
} finally { await h.close() }
