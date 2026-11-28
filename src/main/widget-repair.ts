import { parseVersion, STORE_DIR } from '../../compiler/scripts/lib/13-slide-ledger.mjs'
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { resolveSlideId } from '../../compiler/scripts/lib/slide-id.mjs'
import { listSlideBlocks } from '../../compiler/scripts/lib/slide-blocks.mjs'
import { logicalTriggerBlockAfterHeading, parseTriggerGroups } from '../shared/trigger-line.ts'
import { slideFiles } from '../shared/slide-handling/query.ts'
import { pathStaysInside } from './path-containment.ts'
import { scanTalkFoldersSync } from './talk-scan.mjs'
import { copySlideLocalFile, copySlideLocalFiles, hasSlideLocalFile, slideLocalFileDigest } from './slide-local-files.ts'

type Talk = { slug: string; title: string; outlinePath: string }
type LocatedTalk = Talk & { dir: string }
export type WidgetRepairMatch = { source: LocatedTalk } | { candidates: string[] }

function sourceSlug(lines: string[], start: number): string | undefined {
  const block = logicalTriggerBlockAfterHeading(lines, start)
  const header = [lines[start], ...(block ? lines.slice(block.start, block.end) : [])]
  return header.flatMap(parseTriggerGroups).flatMap(({ raw }) => {
    const value = /^from\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s}]+))$/i.exec(raw.trim())
    return value ? [value[1] ?? value[2] ?? value[3]] : []
  })[0]
}

function locatedTalks(vault: string, target: string, talks: readonly Talk[]): LocatedTalk[] {
  return talks.flatMap((talk) => {
    const source = pathStaysInside(vault, talk.outlinePath)
    return source && dirname(source) !== dirname(target) ? [{ ...talk, outlinePath: source, dir: dirname(source) }] : []
  })
}

function readOutline(path: string): string | null {
  try {
    const stat = statSync(path)
    return stat.isFile() && stat.size <= 2 * 1024 * 1024 ? readFileSync(path, 'utf8') : null
  } catch { return null }
}

function outlineHasId(talk: LocatedTalk, ids: ReadonlySet<string>): boolean {
  if (!ids.size) return false
  const outline = readOutline(talk.outlinePath)
  if (!outline || ![...ids].some((id) => outline.includes(`{id=${id}}`))) return false
  const lines = outline.split('\n')
  return listSlideBlocks(outline).some(({ start, end }) => {
    const id = resolveSlideId(lines, start, end)?.id
    return id !== undefined && ids.has(id)
  })
}

function historyPaths(vault: string, ids: ReadonlySet<string>): Set<string> {
  const paths = new Set<string>()
  for (const id of ids) {
    // Read only. The normal ledger listing can create and migrate the store.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue
    const folder = pathStaysInside(vault, join(vault, STORE_DIR, id))
    if (!folder) continue
    let records
    try { records = readdirSync(folder, { withFileTypes: true }) } catch { continue }
    for (const record of records) {
      if (!record.isFile() || !record.name.endsWith('.md')) continue
      const path = pathStaysInside(folder, join(folder, record.name))
      const text = path && readOutline(path)
      if (!text) continue
      const version = parseVersion(text)
      if (version.id !== id || !version.outline || isAbsolute(version.outline)) continue
      const source = pathStaysInside(vault, join(vault, version.outline))
      if (source) paths.add(source)
    }
  }
  return paths
}

function chooseSource(matches: readonly LocatedTalk[], ref: string): WidgetRepairMatch | null {
  if (!matches.length) return null
  const ordered = [...matches].sort((a, b) => a.title.localeCompare(b.title) || a.outlinePath.localeCompare(b.outlinePath))
  if (ordered.length === 1) return { source: ordered[0] }
  const digest = slideLocalFileDigest(ordered[0].dir, ref)
  if (digest && ordered.slice(1).every((match) => slideLocalFileDigest(match.dir, ref) === digest)) {
    return { source: ordered[0] }
  }
  return { candidates: ordered.map(({ title, slug }) =>
    ordered.filter((source) => source.title === title).length > 1 ? `${title} (${slug})` : title) }
}

/** Check the authored source first, then the same slide id, then its read-only ledger history. */
export function widgetRepairMatch(vault: string, target: string, text: string, ref: string, talks: readonly Talk[]): WidgetRepairMatch | null {
  if (hasSlideLocalFile(dirname(target), ref)) return null
  const lines = text.split('\n')
  const explicit = new Set<string>()
  const ids = new Set<string>()
  for (const { start, end } of listSlideBlocks(text)) {
    const files = slideFiles(lines.slice(start, end).join('\n'))
    if (!files.some((file) => file.ref === ref && (file.kind === 'embed' || file.kind === 'simulation'))) continue
    const from = sourceSlug(lines, start)
    if (from) explicit.add(from)
    const slideId = resolveSlideId(lines, start, end)?.id
    if (slideId) ids.add(slideId)
  }
  if (!explicit.size && !ids.size) return null
  const available = locatedTalks(vault, target, talks).filter((talk) => hasSlideLocalFile(talk.dir, ref))
  const named = available.filter((talk) => explicit.has(talk.slug))
  if (named.length) return chooseSource(named, ref)
  const namedSlide = available.filter((talk) => outlineHasId(talk, explicit))
  if (namedSlide.length) return chooseSource(namedSlide, ref)
  const sameId = available.filter((talk) => outlineHasId(talk, ids))
  if (sameId.length) return chooseSource(sameId, ref)
  const earlier = historyPaths(vault, new Set([...ids, ...explicit]))
  return chooseSource(available.filter((talk) => earlier.has(talk.outlinePath)), ref)
}

export type WidgetRepairOffer = { repairTitle: string } | { repairCandidates: string[] }

function readOutlineHead(path: string): string {
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(2048)
      return buffer.subarray(0, readSync(fd, buffer)).toString('utf8')
    } finally { closeSync(fd) }
  } catch { return '' }
}

export function readWidgetRepairOffers(vault: string, outlinePath: string, refs: readonly string[]): Map<string, WidgetRepairOffer> {
  const offers = new Map<string, WidgetRepairOffer>()
  const target = pathStaysInside(vault, outlinePath)
  const text = target && readOutline(target)
  if (!target || !text) return offers
  const talks = scanTalkFoldersSync(vault).map(({ dir, outlineName }) => {
    const slug = outlineName.replace(/-outline\.md$/, '')
    const path = join(dir, outlineName)
    const contained = pathStaysInside(vault, path)
    const head = contained ? readOutlineHead(contained) : ''
    const frontmatter = head?.startsWith('---') ? head.slice(3).split('\n---', 1)[0] : ''
    const title = frontmatter.match(/^title:[ \t]*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '').trim()
    return { slug, title: title || slug.replace(/-/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()), outlinePath: path }
  })
  for (const ref of refs) {
    const match = widgetRepairMatch(vault, target, text, ref, talks)
    if (match) offers.set(ref, 'source' in match ? { repairTitle: match.source.title } : { repairCandidates: match.candidates })
  }
  return offers
}

export function repairSlideWidget(vault: string, target: string, text: string, ref: string, talks: readonly Talk[], expectedTitle?: string): boolean {
  const match = widgetRepairMatch(vault, target, text, ref, talks)
  if (!match || !('source' in match) || (expectedTitle !== undefined && match.source.title !== expectedTitle)) return false
  return Boolean(copySlideLocalFile(match.source.dir, dirname(target), ref, true))
}

/** External pasted text can name its source with a {from} tag. */
export function copyPastedSlideFiles(vault: string, target: string, text: string, talks: readonly Talk[]): string {
  if (!slideFiles(text).some(({ ref }) => ref)) return text
  const sources = locatedTalks(vault, target, talks)
  const lines = text.split('\n')
  for (const { start, end } of listSlideBlocks(text).reverse()) {
    const block = lines.slice(start, end).join('\n')
    const refs = slideFiles(block).map(({ ref }) => ref).filter(Boolean)
    if (!refs.length) continue
    const slug = sourceSlug(lines, start)
    if (!slug) continue
    const candidates = sources.filter((talk) => talk.slug === slug)
    if (candidates.length !== 1) continue
    const copied = copySlideLocalFiles(candidates[0].dir, dirname(target), block)
    if (copied !== block) lines.splice(start, end - start, ...copied.split('\n'))
  }
  return lines.join('\n')
}
