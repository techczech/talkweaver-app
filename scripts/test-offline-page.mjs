import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, renameSync, lstatSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildOfflinePage, OFFLINE_PAGE_CSP } from '../src/main/offline-page-policy.ts'
import { importInWorkingFolder } from '../src/main/html-page-import-core.ts'
import { saveOfflinePage } from '../src/main/offline-page.ts'
const dirty = { title: '</title><script>bad()</script>', tree: { tag: 'div', style: { color: 'red;background:url(https://bad/)', 'font-family': '\\75rl(https://bad/)', 'background-image': 'url(https://bad/)', padding: '1px' }, children: [{ tag: 'script', children: [{ text: 'bad()' }] }, { text: '<img src=x onerror=bad()>' }, { tag: 'img', image: 0 }, { tag: 'img', image: 1 }, { tag: 'p', style: { color: 'rgb(1, 2, 3)' }, children: [{ text: 'Kept text' }] }] } }
const result = buildOfflinePage(dirty, ['data:image/png;base64,AAAA', 'data:image/svg+xml;base64,AAAA'], [{ url: 'https://example.org/data.json', body: '{"x":"</pre><script>bad()</script>"}' }])
assert.ok(result.html.includes(OFFLINE_PAGE_CSP))
assert.ok(!result.html.includes('<script'))
assert.ok(!result.html.includes('onerror=' + '"'))
assert.ok(!result.html.includes('style="color:red;'))
assert.ok(result.html.includes('color:rgb(1, 2, 3)'))
assert.ok(result.html.includes('&lt;img'))
assert.ok(result.html.includes('Kept text'))
assert.equal(result.images, 1)
assert.equal(result.dataFiles, 1)
assert.equal(result.omitted, 2)
const root = mkdtempSync(join(tmpdir(), 'tw-offline-unit-'))
try {
  const outlinePath = join(root, 'talk-outline.md'); writeFileSync(outlinePath, '# Talk\n')
  let imported = 0, source
  const deps = {
    writableTalkRoot: () => root,
    capture: async () => result,
    runImport: async job => {
      imported++; source = job.source
      const copied = readFileSync(job.source, 'utf8')
      assert.equal(copied, result.html)
      assert.ok(!copied.includes('<script'))
      assert.equal(job.alwaysCopy, true)
      return { ok: true, embedPath: 'assets/offline-page.html', how: 'copied', localReferences: [] }
    }
  }
  const saved = await saveOfflinePage({ outlinePath, source: 'https://example.org/' }, deps)
  assert.equal(saved.ok, true); assert.equal(imported, 1); assert.equal(existsSync(source), false)
  assert.equal((await saveOfflinePage({ outlinePath: '../x', source: 'https://example.org/' }, deps)).ok, false)
  let rootNow = root
  const changed = await saveOfflinePage({ outlinePath, source: 'https://example.org/' }, { ...deps, writableTalkRoot: () => rootNow, capture: async () => { rootNow = ''; return result } })
  assert.equal(changed.ok, false); assert.equal(imported, 1)
  const failed = await saveOfflinePage({ outlinePath, source: 'https://example.org/' }, { ...deps, capture: async () => { throw Error('private detail') } })
  assert.equal(failed.ok, false); assert.ok(!failed.message.includes('private detail'))
  // A vault-root fallback is not talk authority: no source runs for outside/missing outlines.
  let captures = 0
  const outside = join(root, '..', `outside-${Date.now()}-outline.md`)
  writeFileSync(outside, '# Outside\n')
  try {
    for (const bad of [outside, join(root, 'missing-outline.md')]) {
      const denied = await saveOfflinePage({ outlinePath: bad, source: 'assets/private.html' }, {
        ...deps, capture: async () => { captures++; return result }
      })
      assert.equal(denied.ok, false)
    }
    assert.equal(captures, 0, 'validate an existing vault-contained talk before any source execution')
    assert.equal(imported, 1)
  } finally { rmSync(outside) }

  // Same inode, different bytes: size is checked even if the original mtime is restored.
  utimesSync(outlinePath, 1600000000, 1600000000)
  const starting = lstatSync(outlinePath)
  const resized = await saveOfflinePage({ outlinePath, source: 'https://example.org/' }, {
    ...deps, capture: async () => {
      writeFileSync(outlinePath, '# A longer outline on the same inode\n')
      utimesSync(outlinePath, 1600000000, 1600000000)
      assert.equal(lstatSync(outlinePath).ino, starting.ino)
      assert.equal(lstatSync(outlinePath).mtimeMs, starting.mtimeMs)
      return result
    }
  })
  assert.equal(resized.ok, false, 'same-inode size change refuses capture even with restored mtime')
  assert.equal(imported, 1)

  const beforeTouch = lstatSync(outlinePath)
  const touched = await saveOfflinePage({ outlinePath, source: 'https://example.org/' }, {
    ...deps, capture: async () => {
      utimesSync(outlinePath, 1600000010, 1600000010)
      assert.equal(lstatSync(outlinePath).ino, beforeTouch.ino)
      assert.equal(lstatSync(outlinePath).size, beforeTouch.size)
      return result
    }
  })
  assert.equal(touched.ok, false, 'mtime change refuses capture even with the same inode and size')
  assert.equal(imported, 1)

  const original = lstatSync(outlinePath)
  const replaced = await saveOfflinePage({ outlinePath, source: 'https://example.org/' }, {
    ...deps, capture: async (_input, target) => {
      assert.equal(target.outline.ino, original.ino)
      renameSync(outlinePath, outlinePath + '.held')
      writeFileSync(outlinePath, '# Replacement\n')
      return result
    }
  })
  assert.equal(replaced.ok, false, 'same-path outline replacement during capture refuses the save')
  assert.equal(imported, 1, 'replacement outline never receives an asset')
  assert.equal(readFileSync(outlinePath, 'utf8'), '# Replacement\n')

  const directory = join(root, 'directory-swap'); mkdirSync(directory)
  const nestedOutline = join(directory, 'talk-outline.md'); writeFileSync(nestedOutline, '# Original\n')
  const swapDirectory = () => {
    renameSync(directory, directory + '-held'); mkdirSync(directory)
    // Preserve the outline inode, so only the retained directory identity detects this swap.
    renameSync(join(directory + '-held', 'talk-outline.md'), nestedOutline)
  }
  const directoryChanged = await saveOfflinePage({ outlinePath: nestedOutline, source: 'https://example.org/' }, {
    ...deps, capture: async () => { swapDirectory(); return result }
  })
  assert.equal(directoryChanged.ok, false, 'talk directory replacement during capture refuses the save')
  assert.equal(imported, 1)
  assert.equal(existsSync(join(directory, 'assets')), false)

  if (process.platform === 'darwin') {
    const editedDir = join(root, 'late-edit'); mkdirSync(editedDir)
    const editedOutline = join(editedDir, 'talk-outline.md'); writeFileSync(editedOutline, '# Before\n')
    const lateEdit = await saveOfflinePage({ outlinePath: editedOutline, source: 'https://example.org/' }, {
      ...deps,
      runImport: async job => {
        const before = lstatSync(editedOutline)
        assert.deepEqual(job.outlineVersion, { size: before.size, mtimeMs: before.mtimeMs })
        writeFileSync(editedOutline, '# Later edit on the same inode\n')
        assert.equal(lstatSync(editedOutline).ino, before.ino)
        const cwd = process.cwd()
        try { process.chdir(editedDir); return importInWorkingFolder(job) }
        finally { process.chdir(cwd) }
      }
    })
    assert.equal(lateEdit.ok, false, 'the utility writer also refuses a later same-inode edit')
    assert.equal(existsSync(join(editedDir, 'assets')), false)

    const lateDir = join(root, 'late-swap'); mkdirSync(lateDir)
    const lateOutline = join(lateDir, 'talk-outline.md'); writeFileSync(lateOutline, '# Late original\n')
    let authority
    const late = await saveOfflinePage({ outlinePath: lateOutline, source: 'https://example.org/' }, {
      ...deps,
      capture: async (_input, target) => { authority = target; return result },
      runImport: async job => {
        assert.deepEqual(job.outline, authority.outline, 'the original job is retained through capture')
        assert.deepEqual(job.talkDirectory, authority.directory)
        renameSync(lateDir, lateDir + '-held'); mkdirSync(lateDir)
        renameSync(join(lateDir + '-held', 'talk-outline.md'), lateOutline)
        const cwd = process.cwd()
        try { process.chdir(lateDir); return importInWorkingFolder(job) }
        finally { process.chdir(cwd) }
      }
    })
    assert.equal(late.ok, false, 'the utility writer independently refuses a later directory swap')
    assert.equal(existsSync(join(lateDir, 'assets')), false)
  }

} finally { rmSync(root, { recursive: true, force: true }) }
console.log('PASS: offline HTML reconstruction, active-content refusal, bounded assets, guarded import, early talk authority, retained outline/directory identities, size/mtime and late same-inode edits and stale-vault refusal')
