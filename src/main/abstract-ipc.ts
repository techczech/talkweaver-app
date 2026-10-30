import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { abstractPaths } from './vault-paths.ts'
import { parseAbstractDocument, serializeAbstractDocument } from './abstract-document.ts'
import { createDeliverySummaries } from './delivery-summaries.ts'
import { mkdirBelowRoot } from './vault-availability.ts'

let summaryRoot: string | null = null
// Re-stat on each panel open, retaining parsed summaries for unchanged Run files.
const summaries = createDeliverySummaries({ vaultRoot: () => summaryRoot, revalidateMs: 0 })

/** Keep file presence independent of YAML validity and recorded history. */
export function readAbstract(vaultRoot: string | null | undefined, talkPath: unknown) {
  const target = abstractPaths(vaultRoot, talkPath)
  if (!target.ok) throw new Error(`Cannot read abstract: ${target.error}`)
  summaryRoot = vaultRoot ?? null
  const recordedRuns = summaries.bySlug().get(target.slug) ?? []
  const base = { slug: target.slug, source: target.source, candidates: target.candidates, recordedRuns }
  if (!target.readPath) return { ...base, raw: null, frontmatter: {}, body: '', parseError: null }
  const raw = readFileSync(target.readPath, 'utf8')
  try {
    return { ...base, ...parseAbstractDocument(raw), parseError: null }
  } catch (error) {
    return { ...base, raw, frontmatter: {}, body: raw, parseError: error instanceof Error ? error.message : String(error) }
  }
}

/** Resolve again at Save, validate before creating anything, and preserve the raw document. */
export function writeAbstract(vaultRoot: string | null | undefined, talkPath: unknown, raw: string): boolean {
  const target = abstractPaths(vaultRoot, talkPath)
  if (!target.ok) throw new Error(`Cannot write abstract: ${target.error}`)
  if (target.candidates.length) throw new Error(`Several abstracts found: ${target.candidates.join(', ')}`)
  const text = serializeAbstractDocument(raw)
  const folder = dirname(target.writePath)
  if (!existsSync(folder)) mkdirBelowRoot(vaultRoot as string, folder, {
    isDirectory: (path) => { try { return statSync(path).isDirectory() } catch { return false } },
    mkdir: (path) => { mkdirSync(path, { recursive: true }) }
  })
  writeFileSync(target.writePath, text, 'utf8')
  return true
}
