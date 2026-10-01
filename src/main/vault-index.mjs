// Persisted talk index, one snapshot per vault (several-vaults ticket 02; design:
// docs/design/2026-09-29-multi-vault/architecture.md, "Impact surface → Vault index").
//
// Contract:
//   - A vault is `{ id, root, open? }` (the registry's Vault; `open` defaults to true).
//   - Each vault has its own snapshot file `<dir>/<id>.json` = `{ id, root, entries }` and its own
//     in-memory copy. Nothing one vault does (refresh, invalidate, a failed write) reads or writes
//     another vault's snapshot.
//   - A snapshot answers only for the vault id AND root it was written for; a mismatch is a miss.
//   - A closed vault (`open === false`) is never scanned or written: refresh/cached/metadata answer
//     empty and leave its snapshot file where it is, so reopening it paints from it at once.
//   - The single-vault snapshot of older builds (`legacyCachePath`, `{ root, entries }`) seeds the
//     vault whose root it names until that vault's first refresh writes its own file. It is never
//     rewritten or deleted (an older build sharing the profile still reads it).
//   - refresh never rejects because of the cache write (best-effort; see test-vault-index-resilience).
//   - Conflict copies (ticket 09): the walk names each talk folder's sync-conflict candidates from the
//     listing it already read, and notes Git markers in the outline (read in full only when its mtime
//     changed). Only a folder with either is handed to `scanConflicts` (which may move byte-identical
//     copies to the Trash); each talk carries `conflicts`, the number of copies left to compare.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { TALK_SCAN_MAX_DEPTH, isSkippedScanDir, pickOutlineEntry } from './talk-scan.mjs'
import { conflictCandidateNames, hasGitConflictMarkers } from './conflict-copies.mjs'

function publicTalk(entry) {
  const { mtimeMs: _mtimeMs, birthtimeMs: _birthtimeMs, subtitle: _subtitle, event: _event, gitMarkers: _gitMarkers, ...talk } = entry
  return talk
}

function parseFrontmatter(head, fallback) {
  const values = { title: fallback, subtitle: null, event: null }
  if (!head.startsWith('---')) return values
  const end = head.indexOf('\n---', 3)
  const block = end === -1 ? head.slice(3) : head.slice(3, end)
  for (const key of ['title', 'subtitle', 'event']) {
    const match = block.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'm'))
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, '').trim()
    if (value) values[key] = value
  }
  return values
}

/** The outline's first 2 KB (what the frontmatter is parsed from, as before) and whether the whole
 *  file holds Git conflict markers: one read of the file. */
async function readOutline(path) {
  const buffer = await readFile(path)
  return { head: buffer.subarray(0, 2048).toString('utf8'), gitMarkers: hasGitConflictMarkers(buffer.toString('utf8')) }
}

async function readJson(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const isVault = (vault) => Boolean(vault && typeof vault.id === 'string' && vault.id && typeof vault.root === 'string' && vault.root)
const isOpen = (vault) => isVault(vault) && vault.open !== false
// Vault ids are registry-generated UUIDs and name the file as they are; any other id is hashed, so
// no id can name a file outside dir.
const fileNameFor = (id) => /^[A-Za-z0-9_-]+$/.test(id) ? id : 'x-' + createHash('sha256').update(id).digest('hex').slice(0, 32)

export function createVaultIndex({ dir, legacyCachePath = null, batchSize = 32, scanConflicts = null }) {
  /** vault id → { id, root, entries } (entries [] when there is no snapshot yet) */
  const snapshots = new Map()

  function snapshotPath(id) {
    return join(dir, `${fileNameFor(String(id))}.json`)
  }

  async function load(vault) {
    const held = snapshots.get(vault.id)
    if (held) return held
    let value = await readJson(snapshotPath(vault.id))
    if (!value || value.id !== vault.id) {
      const legacy = legacyCachePath ? await readJson(legacyCachePath) : null
      value = legacy && legacy.root === vault.root && Array.isArray(legacy.entries)
        ? { id: vault.id, root: vault.root, entries: legacy.entries }
        : { id: vault.id, root: '', entries: [] }
    }
    // A concurrent load for the same vault may have landed first; keep the one already held.
    const winner = snapshots.get(vault.id) ?? value
    snapshots.set(vault.id, winner)
    return winner
  }

  async function hitEntries(vault) {
    if (!isOpen(vault)) return null
    const value = await load(vault)
    return value.root === vault.root && Array.isArray(value.entries) ? value.entries : null
  }

  async function cached(vault) {
    const entries = await hitEntries(vault)
    return entries ? entries.map(publicTalk) : []
  }

  async function cachedState(vault) {
    const entries = await hitEntries(vault)
    return { hit: Boolean(entries), talks: entries ? entries.map(publicTalk) : [] }
  }

  async function metadata(vault) {
    const entries = await hitEntries(vault)
    if (!entries) return {}
    return Object.fromEntries(entries.map((entry) => [entry.slug, {
      createdMs: entry.birthtimeMs ?? entry.mtimeMs ?? 0,
      editedMs: entry.mtimeMs ?? 0,
      subtitle: entry.subtitle ?? null,
      event: entry.event ?? null
    }]))
  }

  async function refresh(vault, onBatch = () => {}) {
    if (!isOpen(vault)) return [] // closed (or malformed) vaults are never scanned or written
    const { id, root } = vault
    const previous = await hitEntries(vault)
    const byPath = new Map((previous ?? []).map((entry) => [entry.outlinePath, entry]))
    const entries = []
    let pending = []
    let sentFirst = false

    async function emitPending(done = false) {
      if (pending.length === 0 && !(done && !sentFirst)) return
      const batch = pending.map(publicTalk)
      pending = []
      onBatch(batch, !sentFirst, done)
      sentFirst = true
      await new Promise((resolve) => setImmediate(resolve))
    }

    async function scanDir(folder, depth = 0) {
      // Depth limit, skip rule and outline pick are shared with the synchronous walk in the
      // main process (talk-scan.mjs), so every listed talk also gets slide text.
      if (depth > TALK_SCAN_MAX_DEPTH) return
      let dirents
      try { dirents = await readdir(folder, { withFileTypes: true }) } catch { return }
      const outline = pickOutlineEntry(dirents, basename(folder))
      if (outline) {
        const outlinePath = join(folder, outline.name)
        const slug = outline.name.replace(/-outline\.md$/, '')
        const fallback = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        try {
          const fileStat = await stat(outlinePath)
          const prior = byPath.get(outlinePath)
          let frontmatter
          let gitMarkers
          if (prior?.mtimeMs === fileStat.mtimeMs && typeof prior.gitMarkers === 'boolean') {
            frontmatter = { title: prior.title, subtitle: prior.subtitle ?? null, event: prior.event ?? null }
            gitMarkers = prior.gitMarkers
          } else {
            const read = await readOutline(outlinePath)
            frontmatter = parseFrontmatter(read.head, fallback)
            gitMarkers = read.gitMarkers
          }
          const names = dirents.filter((entry) => entry.isFile()).map((entry) => entry.name)
          const candidates = conflictCandidateNames(names, outline.name, { loose: true }) // the scanner applies the machine rule
          let conflicts = candidates.length + (gitMarkers ? 1 : 0)
          if (conflicts > 0 && scanConflicts) {
            try {
              const counted = await scanConflicts({ vault, folder, outlineName: outline.name, slug, names })
              if (typeof counted === 'number') conflicts = counted
            } catch {
              // The scanner failing leaves every candidate counted: shown, never hidden.
            }
          }
          const indexed = {
            name: slug, path: folder, outlinePath, slug,
            title: frontmatter.title, subtitle: frontmatter.subtitle, event: frontmatter.event,
            mtimeMs: fileStat.mtimeMs, birthtimeMs: fileStat.birthtimeMs,
            gitMarkers, conflicts
          }
          entries.push(indexed)
          pending.push(indexed)
          if (pending.length >= batchSize) await emitPending(false)
        } catch {
          // A file that disappears during a scan belongs to the next refresh, not this snapshot.
        }
        return
      }
      for (const entry of dirents) {
        if (!entry.isDirectory() || isSkippedScanDir(entry.name)) continue
        await scanDir(join(folder, entry.name), depth + 1)
      }
    }

    await scanDir(root)
    entries.sort((a, b) => a.title.localeCompare(b.title))
    const snapshot = { id, root, entries }
    snapshots.set(id, snapshot)
    // The cache is best-effort: the entries are already computed and returned below, so a
    // failed write (e.g. EMFILE under FD pressure) must NEVER reject refresh() — that rejection,
    // if it lost its handler to an overlapping scan, aborted the whole main process.
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(snapshotPath(id), JSON.stringify(snapshot), 'utf8')
    } catch (error) {
      try { console.warn('[vault-index] cache write skipped:', error?.message ?? error) } catch {}
    }
    await emitPending(true)
    return entries.map(publicTalk)
  }

  /** Drop the in-memory snapshot of one vault (all vaults when id is omitted); the next read
   *  reloads it from that vault's file. Never touches another vault or any file. */
  function invalidate(id) {
    if (id === undefined || id === null) snapshots.clear()
    else snapshots.delete(id)
  }

  /** A folder scan outside the walk (the open talk's folder changed) found `conflicts` copies: the
   *  held snapshot's entry takes the number. Returns the public talk, or null when the vault holds no
   *  such talk in memory. Nothing is written to disk (the next refresh recounts). */
  function setConflicts(vaultId, outlinePath, conflicts) {
    const held = snapshots.get(vaultId)
    const entry = held?.entries?.find((e) => e.outlinePath === outlinePath)
    if (!entry) return null
    entry.conflicts = conflicts
    return publicTalk(entry)
  }

  return { cached, cachedState, metadata, refresh, invalidate, snapshotPath, setConflicts }
}
