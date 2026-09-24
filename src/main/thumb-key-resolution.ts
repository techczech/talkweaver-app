import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

// The browser knows a picture key; the renderer may have prefixed its PNG with a document ID.
const suffixIndex = new Map<string, { count: number; byKey: Map<string, string> }>()

export function resolveThumbFile(dir: string, key: string): string | null {
  const exact = join(dir, key + '.png')
  if (existsSync(exact)) return exact
  if (!existsSync(dir)) return null
  let names: string[]
  try { names = readdirSync(dir) } catch { return null }
  let entry = suffixIndex.get(dir)
  if (!entry || entry.count !== names.length) {
    const byKey = new Map<string, string>()
    for (const name of names) {
      if (!name.endsWith('.png')) continue
      const base = name.slice(0, -4)
      const match = /^[0-9a-f]{16}-(.+)$/.exec(base)
      const bare = match ? match[1] : base
      if (!byKey.has(bare)) byKey.set(bare, join(dir, name))
    }
    entry = { count: names.length, byKey }
    suffixIndex.set(dir, entry)
  }
  return entry.byKey.get(key) ?? null
}
