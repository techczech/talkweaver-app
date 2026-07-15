import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

function publicTalk(entry) {
  const { mtimeMs: _mtimeMs, birthtimeMs: _birthtimeMs, subtitle: _subtitle, event: _event, ...talk } = entry
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

async function readHead(path) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(2048)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export function createVaultIndex({ cachePath, batchSize = 32 }) {
  let snapshot = null

  async function load() {
    if (snapshot) return snapshot
    try {
      const parsed = JSON.parse(await readFile(cachePath, 'utf8'))
      snapshot = parsed && typeof parsed === 'object' ? parsed : { root: '', entries: [] }
    } catch {
      snapshot = { root: '', entries: [] }
    }
    return snapshot
  }

  async function cached(root) {
    const value = await load()
    return value.root === root && Array.isArray(value.entries) ? value.entries.map(publicTalk) : []
  }

  async function cachedState(root) {
    const value = await load()
    const hit = value.root === root && Array.isArray(value.entries)
    return { hit, talks: hit ? value.entries.map(publicTalk) : [] }
  }

  async function metadata(root) {
    const value = await load()
    if (value.root !== root || !Array.isArray(value.entries)) return {}
    return Object.fromEntries(value.entries.map((entry) => [entry.slug, {
      createdMs: entry.birthtimeMs ?? entry.mtimeMs ?? 0,
      editedMs: entry.mtimeMs ?? 0,
      subtitle: entry.subtitle ?? null,
      event: entry.event ?? null
    }]))
  }

  async function refresh(root, onBatch = () => {}) {
    const previous = await load()
    const byPath = new Map(
      previous.root === root && Array.isArray(previous.entries)
        ? previous.entries.map((entry) => [entry.outlinePath, entry])
        : []
    )
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

    async function scanDir(dir, depth = 0) {
      if (depth > 3) return
      let dirents
      try { dirents = await readdir(dir, { withFileTypes: true }) } catch { return }
      const outline = dirents.find((entry) => entry.isFile() && entry.name.endsWith('-outline.md'))
      if (outline) {
        const outlinePath = join(dir, outline.name)
        const slug = outline.name.replace(/-outline\.md$/, '')
        const fallback = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        try {
          const fileStat = await stat(outlinePath)
          const prior = byPath.get(outlinePath)
          const frontmatter = prior?.mtimeMs === fileStat.mtimeMs
            ? { title: prior.title, subtitle: prior.subtitle ?? null, event: prior.event ?? null }
            : parseFrontmatter(await readHead(outlinePath), fallback)
          const indexed = {
            name: slug, path: dir, outlinePath, slug,
            title: frontmatter.title, subtitle: frontmatter.subtitle, event: frontmatter.event,
            mtimeMs: fileStat.mtimeMs, birthtimeMs: fileStat.birthtimeMs
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
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'node_modules') continue
        await scanDir(join(dir, entry.name), depth + 1)
      }
    }

    await scanDir(root)
    entries.sort((a, b) => a.title.localeCompare(b.title))
    snapshot = { root, entries }
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, JSON.stringify(snapshot), 'utf8')
    await emitPending(true)
    return entries.map(publicTalk)
  }

  function invalidate() {
    snapshot = null
  }

  return { cached, cachedState, metadata, refresh, invalidate }
}
