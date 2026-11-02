import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abstractPaths } from '../src/main/vault-paths.ts'
import { parseAbstractDocument, serializeAbstractDocument } from '../src/main/abstract-document.ts'
import { readAbstract, writeAbstract } from '../src/main/abstract-ipc.ts'

const scratch = mkdtempSync(join(tmpdir(), 'tw-abstract-'))
const vault = join(scratch, 'vault')
const folder = join(vault, 'Different folder name')
const named = join(folder, 'actual-slug-abstract.md')
const bare = join(folder, 'abstract.md')
mkdirSync(folder, { recursive: true })
writeFileSync(join(folder, 'actual-slug-outline.md'), '# Talk\n')
let checks = 0
function test(name, run) {
  run()
  checks++
  console.log(`pass ${name}`)
}
const raw = `---
title: 'An abstract'
deliveries:
  - event: Oxford
    date: 2026-10-20
  - venue: Woodstock
    date: 2026-11-01
    status: planned
custom:
  nested: [one, two]
# Retain this comment
other: true
---

## Abstract

  Text with trailing spaces.  
Český text.\r

`
try {
  test('resolver: neither abstract exists', () => {
    assert.deepEqual(abstractPaths(vault, folder), { ok: true, readPath: null, writePath: named, slug: 'actual-slug', source: null, candidates: [] })
    assert.equal(readAbstract(vault, folder).raw, null)
  })
  test('read: invalid YAML preserves the existing file', () => {
    const invalid = '---\ntitle: AI: what next\n---\nReal abstract'
    writeFileSync(named, invalid)
    const result = readAbstract(vault, folder)
    assert.equal(result.raw, invalid)
    assert.equal(typeof result.parseError, 'string')
    assert.ok(result.parseError.length)
    rmSync(named)
  })
  test('resolver: only slug abstract exists', () => {
    writeFileSync(named, raw)
    assert.equal(abstractPaths(vault, folder).readPath, named)
  })
  test('resolver: both abstracts exist, slug wins', () => {
    writeFileSync(bare, 'Legacy body')
    assert.equal(abstractPaths(vault, folder).readPath, named)
  })
  test('resolver: bare fallback migrates on first write without changing bare', () => {
    rmSync(named)
    const target = abstractPaths(vault, folder)
    assert.equal(target.readPath, bare)
    assert.equal(target.writePath, named)
    assert.equal(readAbstract(vault, folder).source, 'bare')
    assert.equal(writeAbstract(vault, folder, readAbstract(vault, folder).raw), true)
    assert.equal(readFileSync(bare, 'utf8'), 'Legacy body')
    assert.equal(readFileSync(named, 'utf8'), 'Legacy body\n')
    assert.equal(abstractPaths(vault, folder).readPath, named)
  })
  test('parser: nested deliveries and unknown keys survive a byte-preserving write', () => {
    const first = parseAbstractDocument(raw)
    assert.equal(writeAbstract(vault, folder, first.raw), true)
    const written = readFileSync(named, 'utf8')
    const second = parseAbstractDocument(written)
    assert.deepEqual(second.frontmatter.deliveries, [
      { event: 'Oxford', date: '2026-10-20' },
      { venue: 'Woodstock', date: '2026-11-01', status: 'planned' }
    ])
    assert.deepEqual(second.frontmatter.custom, { nested: ['one', 'two'] })
    assert.equal(second.frontmatter.other, true)
    assert.deepEqual(Object.keys(second.frontmatter), Object.keys(first.frontmatter))
    assert.equal(second.body, first.body)
    assert.equal(written, raw)
  })
  test('parser: edited text keeps metadata and body whitespace', () => {
    const edited = raw.replace('Český text.', 'Revised text.')
    assert.equal(writeAbstract(vault, folder, edited), true)
    const written = readFileSync(named, 'utf8')
    assert.equal(written, edited)
    assert.deepEqual(parseAbstractDocument(written).frontmatter, parseAbstractDocument(raw).frontmatter)
  })
  test('parser: plain body and absent trailing newline', () => {
    assert.deepEqual(parseAbstractDocument('  Body  '), { raw: '  Body  ', body: '  Body  ', frontmatter: {} })
    assert.equal(serializeAbstractDocument('  Body  '), '  Body  \n')
    assert.equal(serializeAbstractDocument(raw.trimEnd()), raw.trimEnd() + '\n')
  })
  test('parser: CRLF, empty mapping and closing delimiter at EOF', () => {
    assert.equal(parseAbstractDocument('---\r\ntitle: Talk\r\n---\r\n\r\nBody  \r\n').body, '\r\nBody  \r\n')
    assert.deepEqual(parseAbstractDocument('---\n---\nBody').frontmatter, {})
    assert.equal(parseAbstractDocument('---\ntitle: Talk\n---').body, '')
  })
  test('parser: malformed YAML refuses a write', () => {
    assert.throws(() => serializeAbstractDocument('---\ndeliveries: [\n---\nBody'))
    assert.throws(() => serializeAbstractDocument('---\n- not-a-map\n---\nBody'))
  })
  test('read: recorded deliveries and planned runs stay separate from authored deliveries', () => {
    const runs = join(vault, '_PRESENTATIONS', 'actual-slug')
    mkdirSync(runs, { recursive: true })
    for (const run of [
      { id: 'delivered', startedAt: '2026-10-19T12:00:00Z', eventTitle: 'Recorded event', context: 'Seminar' },
      { id: 'planned', status: 'planned', plannedDate: '2026-11-01', context: 'Workshop' },
      { id: 'rehearsal', kind: 'rehearsal' },
      { id: 'recording', kind: 'recording' }
    ]) writeFileSync(join(runs, run.id + '.json'), JSON.stringify(run))
    writeFileSync(named, raw)
    const result = readAbstract(vault, folder)
    assert.deepEqual(result.recordedRuns.map(({ runId, status, date, eventTitle, context }) => ({ runId, status, date, eventTitle, context })), [
      { runId: 'planned', status: 'planned', date: '2026-11-01', eventTitle: '', context: 'Workshop' },
      { runId: 'delivered', status: 'delivered', date: '2026-10-19', eventTitle: 'Recorded event', context: 'Seminar' }
    ])
    assert.equal(result.frontmatter.deliveries.length, 2)
    assert.equal(serializeAbstractDocument(result.raw), raw)
    assert.equal(readFileSync(named, 'utf8'), raw)
    writeFileSync(join(runs, 'planned.json'), JSON.stringify({ id: 'planned', status: 'planned', plannedDate: '2026-12-02', eventTitle: 'Changed event' }))
    assert.equal(readAbstract(vault, folder).recordedRuns[0].eventTitle, 'Changed event')
  })
  test('resolver: refuses outside vault and prefers a folder-matching outline', () => {
    assert.equal(abstractPaths(vault, scratch).error, 'outside-vault')
    const empty = join(vault, 'empty')
    mkdirSync(empty)
    assert.equal(abstractPaths(vault, empty).slug, 'empty')
    writeFileSync(join(empty, 'one-outline.md'), '')
    assert.equal(abstractPaths(vault, empty).slug, 'one')
    writeFileSync(join(empty, 'empty-outline.md'), '')
    assert.equal(abstractPaths(vault, empty).slug, 'empty')
  })
  test('resolver: unique older slug is read and updated without creating a duplicate', () => {
    rmSync(named)
    const older = join(folder, 'older-slug-abstract.md')
    writeFileSync(older, raw)
    const target = abstractPaths(vault, folder)
    assert.equal(target.readPath, older)
    assert.equal(target.writePath, older)
    assert.equal(readAbstract(vault, folder).raw, raw)
    assert.equal(writeAbstract(vault, folder, 'Updated older abstract'), true)
    assert.equal(readFileSync(older, 'utf8'), 'Updated older abstract\n')
    assert.equal(existsSync(named), false)
    rmSync(older)
  })
  test('resolver: several older abstracts prevent reads and writes, even with a bare fallback', () => {
    const names = ['first-abstract.md', 'second-abstract.md']
    for (const name of names) writeFileSync(join(folder, name), raw)
    const result = readAbstract(vault, folder)
    assert.equal(result.raw, null)
    assert.deepEqual(result.candidates, names)
    assert.throws(() => writeAbstract(vault, folder, 'Must not write'), /Several abstracts found/)
    assert.equal(existsSync(named), false)
    for (const name of names) {
      assert.equal(readFileSync(join(folder, name), 'utf8'), raw)
      rmSync(join(folder, name))
    }
  })
  test('resolver: exact outline slug wins over multiple older files', () => {
    const older = ['first-abstract.md', 'second-abstract.md']
    for (const name of older) writeFileSync(join(folder, name), 'Older body')
    writeFileSync(named, raw)
    assert.equal(readAbstract(vault, folder).raw, raw)
    assert.equal(writeAbstract(vault, folder, 'Canonical edit'), true)
    assert.equal(readFileSync(named, 'utf8'), 'Canonical edit\n')
    for (const name of older) {
      assert.equal(readFileSync(join(folder, name), 'utf8'), 'Older body')
      rmSync(join(folder, name))
    }
  })
  test('write: outside paths and missing vault roots create nothing', () => {
    assert.throws(() => writeAbstract(vault, join(scratch, 'escape'), 'No'))
    assert.equal(existsSync(join(scratch, 'escape')), false)
    const missingRoot = join(scratch, 'unavailable-vault')
    assert.throws(() => writeAbstract(missingRoot, join(missingRoot, 'talk'), 'No'), /vault folder is not available/)
    assert.equal(existsSync(missingRoot), false)
  })
  test('write: missing talk folder is created inside an existing vault', () => {
    const missing = join(vault, 'new-parent', 'new-talk')
    assert.equal(readAbstract(vault, missing).raw, null)
    assert.equal(writeAbstract(vault, missing, 'New abstract'), true)
    assert.equal(readFileSync(join(missing, 'new-talk-abstract.md'), 'utf8'), 'New abstract\n')
    assert.equal(readAbstract(vault, missing).raw, 'New abstract\n')
    assert.equal(writeAbstract(vault, missing, 'Second save'), true)
    assert.equal(readAbstract(vault, missing).raw, 'Second save\n')
  })
  test('write: invalid YAML leaves the existing file unchanged and creates no missing folder', () => {
    const invalid = '---\ntitle: AI: what next\n---\nReal abstract'
    writeFileSync(named, invalid)
    assert.throws(() => writeAbstract(vault, folder, invalid))
    assert.equal(readFileSync(named, 'utf8'), invalid)
    const missing = join(vault, 'invalid-new-talk')
    assert.throws(() => writeAbstract(vault, missing, invalid))
    assert.equal(existsSync(missing), false)
  })
  test('resolver: neither canonical nor fallback can escape through a symlink', () => {
    const outside = join(scratch, 'outside.md')
    writeFileSync(outside, 'Private')
    rmSync(named)
    symlinkSync(outside, named)
    assert.equal(abstractPaths(vault, folder).error, 'outside-vault')
    rmSync(named)
    rmSync(bare)
    symlinkSync(outside, bare)
    assert.equal(abstractPaths(vault, folder).error, 'outside-vault')
    assert.equal(existsSync(named), false)
  })
  console.log(`Abstract contract: ${checks} checks passed`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
