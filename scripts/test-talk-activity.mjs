// Per-talk Activity list (several-vaults ticket 09; src/main/talk-activity.ts header).
// Seam: createTalkActivity({ dir }) over a temp app-data folder; plus the Inspector's time column.
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { createTalkActivity, activityFileName } from '../src/main/talk-activity.ts'
import { activityTime } from '../src/renderer/src/components/talkActivityModel.ts'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok  ${name}`) }

const base = mkdtempSync(join(tmpdir(), 'tw-talk-activity-'))
const dir = join(base, 'userData', 'talk-activity')
const line = (title, at) => ({ at, kind: 'identical-copy-removed', title, detail: 'd' })

try {
  await test('append writes userData/talk-activity/<vaultId>/<slug>.jsonl; list answers newest first', async () => {
    const store = createTalkActivity({ dir })
    const told = []
    const off = store.onAppend((v, s) => told.push(`${v}/${s}`))
    await store.append('vault-1', 'ai-workshop', line('first', '2026-09-30T09:00:00Z'))
    await store.append('vault-1', 'ai-workshop', line('second', '2026-09-30T09:14:00Z'))
    off()
    await store.append('vault-1', 'ai-workshop', line('third', '2026-09-30T09:20:00Z'))
    assert.equal(relative(dir, store.fileFor('vault-1', 'ai-workshop')), join('vault-1', 'ai-workshop.jsonl'))
    assert.deepEqual((await store.list('vault-1', 'ai-workshop')).map((e) => e.title), ['third', 'second', 'first'])
    assert.deepEqual((await store.list('vault-1', 'ai-workshop', 1)).map((e) => e.title), ['third'])
    assert.deepEqual(told, ['vault-1/ai-workshop', 'vault-1/ai-workshop'])
  })

  await test('talks are kept apart by vault and slug; an unknown talk has no lines', async () => {
    const store = createTalkActivity({ dir })
    await store.append('vault-2', 'ai-workshop', line('other vault', '2026-09-30T10:00:00Z'))
    assert.deepEqual((await store.list('vault-2', 'ai-workshop')).map((e) => e.title), ['other vault'])
    assert.equal((await store.list('vault-1', 'ai-workshop')).length, 3)
    assert.deepEqual(await store.list('vault-1', 'nothing'), [])
    assert.deepEqual(await store.list('', 'x'), [])
  })

  await test('no vault id or slug can name a file outside the folder', async () => {
    const store = createTalkActivity({ dir })
    for (const [v, s] of [['../../etc', 'x'], ['v', '../../../escape'], ['v', '.hidden'], ['v/w', 's']]) {
      await store.append(v, s, line('t', '2026-09-30T10:00:00Z'))
      const rel = relative(dir, store.fileFor(v, s))
      assert.ok(!rel.startsWith('..') && rel.split('/').length === 2, rel)
    }
    assert.equal(activityFileName('ai-workshop'), 'ai-workshop')
    assert.match(activityFileName('../x'), /^x-[0-9a-f]{32}$/)
    assert.ok(!existsSync(join(base, 'escape.jsonl')))
  })

  await test('a torn line is skipped, the rest still read; a malformed entry is refused', async () => {
    const store = createTalkActivity({ dir })
    appendFileSync(store.fileFor('vault-1', 'ai-workshop'), '{"at":"2026-09-30T11:00:00Z","kind":"x","ti')
    appendFileSync(store.fileFor('vault-1', 'ai-workshop'), '\n' + JSON.stringify(line('after', '2026-09-30T12:00:00Z')) + '\n')
    assert.deepEqual((await store.list('vault-1', 'ai-workshop')).map((e) => e.title), ['after', 'third', 'second', 'first'])
    await assert.rejects(store.append('vault-1', 'ai-workshop', { kind: 'x' }))
  })

  await test('the time column: today, yesterday, a date', () => {
    const now = new Date(2026, 8, 30, 12, 0)
    assert.equal(activityTime(new Date(2026, 8, 30, 9, 14).toISOString(), now), '09:14')
    assert.equal(activityTime(new Date(2026, 8, 29, 18, 40).toISOString(), now), 'yesterday 18:40')
    assert.equal(activityTime(new Date(2026, 8, 12, 8, 5).toISOString(), now), '12 Sep 08:05')
    assert.equal(activityTime(new Date(2025, 0, 2, 8, 5).toISOString(), now), '2 Jan 2025 08:05')
    assert.equal(activityTime('not a date', now), '')
  })

  assert.ok(readdirSync(dir).length >= 2)
  assert.ok(readFileSync(createTalkActivity({ dir }).fileFor('vault-2', 'ai-workshop'), 'utf8').endsWith('\n'))
} finally {
  rmSync(base, { recursive: true, force: true })
}
console.log(`\n${passed} passed`)
