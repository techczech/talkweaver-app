// Slides across vaults (several-vaults ticket 06; architecture.md, "Slide ledger" and invariant 1).
//
// prepareCrossVaultInsert() turns a slide picked in the Slide Browser from ANOTHER vault into the
// markdown to insert into the open talk, and does the writes that insertion needs in the TARGET vault:
//   - media: every image or video the slide shows is read from the SOURCE vault (containment against
//     the source root) and written into the target vault's `_assets` pool (containment against the
//     target root). Pool refs (`img-…`, `vid-…`) keep their content-addressed name; relative and
//     absolute refs are materialised into the pool and rewritten to the pool id. A sidecar is written
//     fresh — only alt and caption travel; a source sidecar's own fields (source, note) never do.
//   - ids: an incoming `{id=…}` that the target vault already knows is re-stamped with a fresh id; an
//     unstamped heading gets one, so every inserted slide can carry its provenance.
//   - every other image or link target (inline or reference-style: a missing file, a PDF, a `file:`
//     URL, an absolute or `../` path) is cut to its file name, or dropped when it has none — a path
//     never travels verbatim. Web links, anchors and pool ids are kept.
//   - provenance: returned, not written. `origin` ({vault_id, vault_name, slide_id, inserted_by})
//     is for the target vault's slide ledger, recorded on the first save; `privateRecord` (source talk
//     title and outline path) is for this Mac's app data only.
// Nothing this module writes into the target vault names an absolute path or a path in the source
// vault. It takes its tools as arguments, so the unit test drives it with the real compiler libs.
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { basename, dirname, extname, isAbsolute, join } from 'path'
import { pathStaysInside } from './path-containment.ts'

export type VaultSide = { id: string; name: string; root: string }
/** What the target vault's ledger records about a slide from another vault. `inserted_by` is the
 *  inserting person's display name for the target vault, omitted when they have none. */
export type SlideOrigin = { vault_id: string; vault_name: string; slide_id: string; inserted_by?: string }
/** What only this Mac keeps (app data, keyed by `<targetVaultId>/<slideId>`). */
export type PrivateProvenance = {
  source_vault_id: string
  source_vault_name: string
  source_slide_id: string
  source_talk_title: string
  source_outline_path: string
  inserted_at: string
  /** Who inserted it (as in `origin`), so the origin can be rebuilt from this record. */
  inserted_by?: string
}
export type InsertedSlide = { id: string; sourceId: string; restamped: boolean; origin: SlideOrigin; privateRecord: PrivateProvenance }

export interface CrossVaultTools {
  listSlideBlocks(text: string): Array<{ start: number; end: number }>
  stampMissingIds(text: string, rng?: () => number, opts?: { preferred?: Map<string, string> | null }): { text: string; stamped: Array<{ id: string }> }
  idLineIndex(lines: string[], headingIdx: number, endIdx?: number): number
  mintId(rng: () => number, taken: Set<string>): string
  /** Every slide id the target vault already knows (ledger folders + outline tokens). */
  idsInVault(root: string): Set<string>
}

export type CrossVaultInput = {
  source: VaultSide
  target: VaultSide
  sourceOutlinePath: string
  sourceTalkTitle: string
  markdown: string
  /** The inserting person's display name for the target vault ('' or absent: not recorded). */
  insertedBy?: string
  /** Ids already in the target talk's live text (unsaved buffer included) or promised by an insert
   *  not yet saved: never reused. */
  extraTaken?: Iterable<string>
}

export type CrossVaultResult =
  | { ok: true; markdown: string; slides: InsertedSlide[]; materialized: number; skipped: number }
  | { ok: false; error: string }

const ID_TOKEN_RE = /\{id=([A-Za-z0-9_-]+)\}/
const IMAGE_REF_RE = /!\[[^\]]*\]\(([^)]+)\)/g
// HTML inside slide markdown: the tags whose targets can name a file, and the attributes that do.
const HTML_TAG_RE = /<(img|a|video|source|iframe)\b[^>]*>/gi
// An unquoted value runs to `>` or to whitespace before the next `name=`, so `src=/a b/c.png>` is one.
const HTML_ATTR_RE = /(\s)(src|href|poster)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'>][^>]*?)(?=\s+[A-Za-z_:][-\w:.]*\s*=|\s*\/?>))/gi

/** Every src / href / poster value in the HTML tags that can name a file. */
function htmlTargets(markdown: string): string[] {
  const out: string[] = []
  for (const tag of markdown.matchAll(HTML_TAG_RE)) {
    for (const a of tag[0].matchAll(HTML_ATTR_RE)) out.push((a[5] ?? a[6] ?? a[7] ?? '').trim())
  }
  return out.filter(Boolean)
}

/** The same tags with each src / href / poster value passed through `map` (quotes kept). */
function mapHtmlTargets(markdown: string, map: (target: string) => string): string {
  return markdown.replace(HTML_TAG_RE, (tag) => tag.replace(HTML_ATTR_RE, (_w, sp: string, name: string, eq: string, _v: string, dq?: string, sq?: string, bare?: string) => {
    const value = map((dq ?? sq ?? bare ?? '').trim())
    const quote = sq !== undefined ? "'" : '"'
    return `${sp}${name}${eq}${quote}${value}${quote}`
  }))
}
const POOL_RE = /^(img-(?:img-)?[0-9a-f]{7}|vid-[0-9a-f]{7})$/
const MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|svg|mp4|mov|m4v|webm)$/i
const IMAGE_EXTS = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'svg']
const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm']
const POSTER_EXTS = ['png', 'jpg', 'jpeg', 'webp']

export async function prepareCrossVaultInsert(
  input: CrossVaultInput,
  tools: CrossVaultTools,
  opts: { toWebp: (buf: Buffer) => Promise<Buffer>; rng?: () => number; now?: () => Date; warn?: (msg: string) => void }
): Promise<CrossVaultResult> {
  const { source, target } = input
  const warn = opts.warn ?? ((msg: string) => console.warn('[cross-vault-insert]', msg))
  if (!source.id || !target.id || source.id === target.id) return { ok: false, error: 'Not a cross-vault insert.' }
  if (!pathStaysInside(source.root, input.sourceOutlinePath)) return { ok: false, error: 'The slide’s talk is not in its vault.' }
  const media = await copySlideMedia({
    readRoot: source.root, writeRoot: target.root, srcDir: dirname(input.sourceOutlinePath),
    markdown: input.markdown, toWebp: opts.toWebp, warn
  })
  const scrubbed = scrubSourceRoot(cutUntravelledRefs(media.markdown), source.root)
  const ids = assignTargetIds(scrubbed, tools, [...tools.idsInVault(target.root), ...(input.extraTaken ?? [])], opts.rng ?? Math.random)
  const insertedAt = (opts.now ?? (() => new Date()))().toISOString()
  const insertedBy = input.insertedBy?.trim() ?? ''
  const slides: InsertedSlide[] = ids.slides.map((s) => ({
    ...s,
    origin: { vault_id: source.id, vault_name: source.name, slide_id: s.sourceId, ...(insertedBy ? { inserted_by: insertedBy } : {}) },
    privateRecord: {
      source_vault_id: source.id,
      source_vault_name: source.name,
      source_slide_id: s.sourceId,
      source_talk_title: input.sourceTalkTitle,
      source_outline_path: input.sourceOutlinePath,
      inserted_at: insertedAt,
      ...(insertedBy ? { inserted_by: insertedBy } : {})
    }
  }))
  return { ok: true, markdown: ids.markdown, slides, materialized: media.materialized, skipped: media.skipped }
}

/**
 * Give every slide block in `markdown` an id the target vault does not already use. A kept or
 * re-stamped id's `sourceId` is the id it had in the source vault ('' for a heading that had none).
 */
export function assignTargetIds(
  markdown: string, tools: Pick<CrossVaultTools, 'listSlideBlocks' | 'stampMissingIds' | 'idLineIndex' | 'mintId'>,
  takenIds: Iterable<string>, rng: () => number = Math.random
): { markdown: string; slides: Array<{ id: string; sourceId: string; restamped: boolean }> } {
  const incoming = new Set([...markdown.matchAll(new RegExp(ID_TOKEN_RE.source, 'g'))].map((m) => m[1]))
  const stamped = tools.stampMissingIds(markdown, rng)
  const fresh = new Set(stamped.stamped.map((s) => s.id))
  const lines = stamped.text.split('\n')
  const taken = new Set(takenIds)
  const slides: Array<{ id: string; sourceId: string; restamped: boolean }> = []
  for (const block of tools.listSlideBlocks(stamped.text)) {
    const at = tools.idLineIndex(lines, block.start, block.end)
    if (at < 0) continue
    const current = lines[at].match(ID_TOKEN_RE)?.[1]
    if (!current) continue
    const sourceId = fresh.has(current) && !incoming.has(current) ? '' : current
    let id = current
    if (taken.has(id) || slides.some((s) => s.id === id)) {
      id = tools.mintId(rng, new Set([...taken, ...slides.map((s) => s.id), ...incoming, ...fresh]))
      lines[at] = lines[at].replace(ID_TOKEN_RE, `{id=${id}}`)
    }
    taken.add(id)
    slides.push({ id, sourceId, restamped: id !== current && sourceId !== '' })
  }
  return { markdown: lines.join('\n'), slides }
}

/**
 * Copy every image and video a slide shows from the vault it was read in (`readRoot`) into another
 * vault's pool (`writeRoot/_assets`), and rewrite the refs to pool ids. Sources outside `readRoot`
 * and destinations outside `writeRoot` are refused. A ref that cannot travel keeps its text, except
 * an absolute path inside the source vault, which is cut to its file name so it names no folder there.
 */
export async function copySlideMedia({ readRoot, writeRoot, srcDir, markdown, toWebp, warn }: {
  readRoot: string; writeRoot: string; srcDir: string; markdown: string
  toWebp: (buf: Buffer) => Promise<Buffer>; warn: (msg: string) => void
}): Promise<{ markdown: string; materialized: number; skipped: number }> {
  const readPool = join(readRoot, '_assets')
  const writePool = join(writeRoot, '_assets')
  const refs = new Set<string>()
  const candidates = [
    ...[...markdown.matchAll(IMAGE_REF_RE)].map((m) => m[1].trim().replace(/\s+"[^"]*"$/, '')),
    ...htmlTargets(markdown) // <img src>, <video src|poster>, <source src>, <iframe src>, <a href>
  ]
  for (const raw of candidates) {
    if (/^(https?:|data:)/i.test(raw)) continue
    if (POOL_RE.test(raw) || MEDIA_EXT_RE.test(raw)) refs.add(raw)
  }
  let out = markdown
  let materialized = 0
  let skipped = 0
  const ensurePool = (): boolean => {
    if (!pathStaysInside(writeRoot, writePool)) return false
    if (!existsSync(writePool)) {
      // Only below a vault folder that is there: a vanished vault is never re-created (ticket 07).
      if (!existsSync(writeRoot)) return false
      mkdirSync(writePool, { recursive: true })
    }
    return true
  }
  const place = (name: string): string | null => {
    const dest = pathStaysInside(writeRoot, join(writePool, name))
    if (!dest) warn(`refused a destination outside the target vault: ${name}`)
    return dest
  }
  const writeSidecar = (id: string, originalFormat: string, sourceSidecar: string | null): void => {
    const dest = place(id + '.yml')
    if (!dest || existsSync(dest)) return
    writeFileSync(dest, [
      'id: ' + id,
      'created: ' + new Date().toISOString().slice(0, 10),
      'original_format: ' + originalFormat,
      'note: "copied from another vault"',
      'alt: ' + sidecarValue(sourceSidecar, 'alt', readRoot),
      'caption: ' + sidecarValue(sourceSidecar, 'caption', readRoot),
      'source: ""', 'tags: []'
    ].join('\n') + '\n', 'utf8')
  }
  const readSidecar = (id: string): string | null => {
    const p = pathStaysInside(readRoot, join(readPool, id + '.yml'))
    try { return p && existsSync(p) ? readFileSync(p, 'utf8') : null } catch { return null }
  }

  for (const ref of refs) {
    try {
      if (POOL_RE.test(ref)) {
        // A pool ref names its file by content: copy it (and a clip's poster) under the same name.
        const id = ref.replace(/^img-img-/, 'img-')
        const exts = id.startsWith('vid-') ? VIDEO_EXTS : IMAGE_EXTS
        let copied = false
        for (const ext of exts) {
          const from = pathStaysInside(readRoot, join(readPool, `${id}.${ext}`))
          if (!from || !existsSync(from)) continue
          if (!ensurePool()) break
          const dest = place(`${id}.${ext}`)
          if (!dest) break
          if (!existsSync(dest)) copyFileSync(from, dest)
          writeSidecar(id, ext, readSidecar(id))
          if (id.startsWith('vid-')) {
            for (const posterExt of POSTER_EXTS) {
              const poster = pathStaysInside(readRoot, join(readPool, `${id}.${posterExt}`))
              if (!poster || !existsSync(poster)) continue
              const posterDest = place(`${id}.${posterExt}`)
              if (posterDest && !existsSync(posterDest)) copyFileSync(poster, posterDest)
              break
            }
          }
          copied = true
          break
        }
        if (copied) materialized += 1
        else skipped += 1
        continue
      }
      let rel = ref
      try { rel = decodeURIComponent(ref) } catch { rel = ref }
      if (rel.toLowerCase().startsWith('file:')) {
        skipped += 1
        warn(`skipped a file URL reference: ${ref}`)
        continue
      }
      const requested = isAbsolute(rel) ? rel : join(srcDir, rel)
      const abs = pathStaysInside(readRoot, requested)
      if (!abs || !existsSync(abs)) {
        skipped += 1
        if (!abs) warn(`skipped a reference outside the source vault: ${ref}`)
        continue
      }
      const origBuf = readFileSync(abs)
      const originalFormat = extname(abs).slice(1).toLowerCase() || 'png'
      const isVideo = VIDEO_EXTS.includes(originalFormat)
      let storeBuf: Buffer = origBuf
      let storeExt = originalFormat
      if (!isVideo && originalFormat !== 'svg') {
        try {
          const webp = await toWebp(origBuf)
          if (webp.length > 0 && webp.length <= origBuf.length) { storeBuf = webp; storeExt = 'webp' }
        } catch { /* keep the original format */ }
      }
      const hash = createHash('sha256').update(storeBuf).digest('hex').slice(0, 7)
      const id = (isVideo ? 'vid-' : 'img-') + hash
      if (!ensurePool()) { skipped += 1; continue }
      const dest = place(`${id}.${storeExt}`)
      if (!dest) { skipped += 1; continue }
      if (!existsSync(dest)) writeFileSync(dest, storeBuf)
      writeSidecar(id, originalFormat, null)
      if (isVideo) {
        const stem = requested.slice(0, -extname(requested).length)
        for (const posterExt of POSTER_EXTS) {
          const candidate = `${stem}.${posterExt}`
          if (!existsSync(candidate)) continue
          const poster = pathStaysInside(readRoot, candidate)
          if (!poster) { warn(`skipped a poster outside the source vault for: ${ref}`); break }
          const posterDest = place(`${id}.${posterExt}`)
          if (posterDest && !existsSync(posterDest)) writeFileSync(posterDest, readFileSync(poster))
          break
        }
      }
      out = out.split(ref).join(id)
      materialized += 1
    } catch (e) {
      skipped += 1
      warn(`failed for ${ref}: ${String(e)}`)
    }
  }
  return { markdown: out, materialized, skipped }
}

const KEEP_TARGET_RE = /^(https?:|mailto:|data:|#)/i

/** The file name at the end of a link target ('' when there is none). */
export function targetBasename(target: string): string {
  const path = target.toLowerCase().startsWith('file:') ? target.slice('file:'.length) : target
  const parts = path.split(/[\\/]/)
  const last = parts[parts.length - 1] ?? ''
  return last === '.' || last === '..' ? '' : last
}

/**
 * Invariant 1 for everything that did not travel as a copied asset: every image and link target —
 * inline `[…](…)` / `![…](…)`, reference-style `[label]: …`, and the src / href / poster of HTML
 * <img>, <a>, <video>, <source> and <iframe> — that is not a web link, an anchor or a pool id is cut
 * to its file name, and dropped when it has none. A title after a markdown target is kept.
 */
export function cutUntravelledRefs(markdown: string): string {
  const cut = (target: string): string | null => {
    const bare = target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target
    if (!bare || KEEP_TARGET_RE.test(bare) || POOL_RE.test(bare)) return target
    const name = targetBasename(bare)
    return name ? name : null
  }
  // HTML targets first (<img src>, <a href>, <video src|poster>, <source src>, <iframe src>): a target
  // with no file name becomes "".
  const html = mapHtmlTargets(markdown, (target) => cut(target) ?? '')
  const inline = html.replace(/(!?\[[^\]]*\])\(([^)]*)\)/g, (whole, label: string, inner: string) => {
    const m = inner.match(/^\s*(<[^>]*>|[\s\S]*?)(\s+"[^"]*")?\s*$/)
    if (!m) return whole
    const next = cut(m[1].trim())
    return `${label}(${next ?? ''}${next && m[2] ? m[2] : ''})`
  })
  return inline
    .split('\n')
    .flatMap((line) => {
      // A reference definition's target is the whole rest of the line, minus an optional title.
      const m = line.match(/^(\s{0,3}\[(?!\^)[^\]]+\]:\s*)(.*)$/)
      if (!m || !m[2].trim()) return [line]
      let target: string
      let tail: string
      if (m[2].startsWith('<') && m[2].includes('>')) {
        target = m[2].slice(0, m[2].indexOf('>') + 1)
        tail = m[2].slice(target.length)
      } else {
        const t = m[2].match(/^(.*?)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/)
        target = (t?.[1] ?? m[2]).trim()
        tail = t?.[2] ?? ''
      }
      const next = cut(target)
      return next === null ? [] : [m[1] + next + tail]
    })
    .join('\n')
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The spellings of a vault root a text might carry: as stored, its real path, each as a file URL,
 *  and the URL-encoded forms of all of them. Longest first. */
export function rootSpellings(root: string): string[] {
  const plain = new Set<string>([root.replace(/[\\/]+$/, '')])
  try { plain.add(realpathSync(root).replace(/[\\/]+$/, '')) } catch { /* a missing root: the stored form only */ }
  const out = new Set<string>()
  for (const p of plain) {
    if (!p) continue
    for (const form of [p, `file://${p}`]) {
      out.add(form)
      out.add(encodeURI(form))
      out.add(encodeURIComponent(form))
    }
  }
  return [...out].sort((a, b) => b.length - a.length)
}

/**
 * The backstop for invariant 1 (srcset, <object>, <embed>, <audio>, <link>, `{bg=…}`, wiki links,
 * shortcodes, prose): every occurrence of the source vault's root in any spelling, followed by a path,
 * becomes that path's last segment; a bare root becomes ''.
 */
export function scrubSourceRoot(markdown: string, root: string): string {
  let out = markdown
  for (const form of rootSpellings(root)) {
    const re = new RegExp(`${escapeRe(form)}(?=$|[\\\\/\\s)"'<>\\]}|,]|%2[Ff]|%5[Cc]|[.;:!?](?:\\s|$))((?:[\\\\/]|%2[Ff]|%5[Cc])[^\\s)"'<>\\]}|]*)?`, 'g')
    out = out.replace(re, (_whole, tail?: string) => {
      if (!tail) return ''
      const parts = tail.split(/[\\/]|%2[Ff]|%5[Cc]/)
      return parts[parts.length - 1] ?? ''
    })
  }
  return out
}

/** A sidecar's alt or caption value, as written (quoted), unless it names the source vault's folder. */
function sidecarValue(sidecar: string | null, key: string, readRoot: string): string {
  const line = sidecar?.split('\n').find((l) => l.startsWith(key + ':'))
  const value = line ? line.slice(key.length + 1).trim() : ''
  if (!value || value.includes(readRoot) || value.includes(basename(readRoot))) return '""'
  return /^".*"$/.test(value) ? value : JSON.stringify(value)
}
