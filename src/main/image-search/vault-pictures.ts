// The image drawer's "In your talks" tab, and the contained scan of a vault's pictures behind it.
//
// Pictures already in Dominik's talks are the files in the `_assets` folder of every open vault. Nothing is
// stored: a search lists the folders, reads each picture's `_assets/<id>.yml` sidecar through the one sidecar
// reader (passed in, so there is no second parser), and counts which talks name `img-<id>`. The answer is
// kept in memory for a few seconds, so typing in the drawer does not walk the vault on every key.
//
// Containment (ADR-0036): a picture counts only when it is a plain file reached through plain folders
// below the vault root. A link anywhere below the root, on the folder or on the file, is refused, as
// image-import.ts refuses it. Files that are not pictures (extension and first bytes) are skipped.

import { lstatSync, readdirSync, readFileSync } from 'fs'
import { basename, dirname, extname, join, relative, sep } from 'path'
import type { ImageFile } from './provider.ts'
import { isImageFile } from './image-file.ts'
import type { ImageSearchHit, VaultPictureResult } from '../../shared/image-search.ts'

export const VAULT_PICTURE_EXTS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif'])
/** The longest query main will look at; the IPC refuses anything longer. */
export const MAX_VAULT_QUERY = 200
/** The most pictures one answer carries. */
export const MAX_VAULT_HITS = 120
const CACHE_MS = 15_000

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path) } catch { return null }
}

/** `dir` is a plain folder below `root` (itself reached through plain folders only, no link on the way). */
function plainFolderBelow(root: string, dir: string): boolean {
  const rel = relative(root, dir)
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) return false
  let at = root
  for (const part of rel.split(sep)) {
    at = join(at, part)
    const st = lstatOrNull(at)
    if (!st || !st.isDirectory()) return false // a link (lstat does not follow it) is not a directory
  }
  return true
}

/** The picture files directly in `dir`, which must be a plain folder below the vault root; links and non-files are left out. */
function picturesIn(vaultRoot: string, dir: string): string[] {
  if (!plainFolderBelow(vaultRoot, dir)) return []
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: string[] = []
  for (const name of names) {
    if (!VAULT_PICTURE_EXTS.has(extname(name).toLowerCase())) continue
    const full = join(dir, name)
    if (lstatOrNull(full)?.isFile()) out.push(full)
  }
  return out
}

/** Every picture file in the vault's pool (`_assets`) and in each talk's own `assets/` folder: what the
 *  image-text pass reads. Contained: nothing reached through a link below the vault root. */
export function gatherVaultImages(vaultRoot: string, talkOutlinePaths: string[]): string[] {
  const out = picturesIn(vaultRoot, join(vaultRoot, '_assets'))
  for (const outline of talkOutlinePaths) out.push(...picturesIn(vaultRoot, join(dirname(outline), 'assets')))
  return out
}

/** A name the vault's pool may serve: a picture `img-<hash>.<ext>`, or a clip's poster `vid-<hash>.jpg`. */
const SERVED_POOL_NAME = /^(?:img-[0-9a-f]{7,}\.(?:webp|png|jpe?g|gif)|vid-[0-9a-f]{7}\.jpg)$/i

/**
 * The one containment check for a file of a vault's pool (`<vault>/_assets/<id>.<ext>`), used by the
 * twasset:// handler and by the In your talks import. Tries `exts` in order and answers the first that is a
 * pool name, reached through plain folders below the vault root, and is itself a plain file (lstat: a link,
 * on `_assets` or on the file, is refused, never followed). Null when none passes.
 */
export function containedPoolFile(vaultRoot: string, id: string, exts: readonly string[]): string | null {
  const assetsDir = join(vaultRoot, '_assets')
  if (!plainFolderBelow(vaultRoot, assetsDir)) return null
  for (const ext of exts) {
    const name = id + '.' + ext
    if (!SERVED_POOL_NAME.test(name)) continue
    const full = join(assetsDir, name)
    if (lstatOrNull(full)?.isFile()) return full
  }
  return null
}

/**
 * The file a `twasset://<id>[?vault=<vaultId>]` request serves: with `?vault`, that open vault's pool;
 * without, the current vault's. Legacy `img-img-…` ids are tolerated. A clip (vid-…) serves its poster.
 * Every answer passes containedPoolFile; null means serve nothing.
 */
export function twassetFileFor(url: string, currentVaultRoot: string | undefined, openVaults: VaultRef[]): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  const wanted = u.searchParams.get('vault')
  const vaultRoot = wanted ? openVaults.find((v) => v.id === wanted)?.root : currentVaultRoot
  if (!vaultRoot) return null
  const id = u.hostname.replace(/^img-img-/, 'img-')
  return containedPoolFile(vaultRoot, id, /^vid-/.test(id) ? ['jpg'] : ['webp', 'png', 'jpg', 'jpeg', 'gif'])
}

export type VaultPicture = { id: string; ext: string; absPath: string; mtimeMs: number }

const POOL_NAME = /^(img-[0-9a-f]{7,})\.(webp|png|jpe?g|gif)$/i

/** The pictures in `<vault>/_assets`, newest first: plain files named `img-<hash>.<ext>` with picture bytes. */
export function scanVaultPool(vaultRoot: string): VaultPicture[] {
  const out: VaultPicture[] = []
  for (const absPath of picturesIn(vaultRoot, join(vaultRoot, '_assets'))) {
    const m = POOL_NAME.exec(basename(absPath))
    const st = lstatOrNull(absPath)
    if (!m || !st || !isImageFile(absPath)) continue
    out.push({ id: m[1].toLowerCase(), ext: m[2].toLowerCase(), absPath, mtimeMs: Number(st.mtimeMs) })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1))
}

export type VaultRef = { id: string; root: string; name?: string }
export type PictureSidecar = { alt: string; caption: string; source: string; tags: string[] }
export type TalkRef = { title: string; outlinePath: string }

export type VaultPictureDeps = {
  /** The open vaults, in order. */
  vaults(): VaultRef[]
  /** The one sidecar reader (asset:read-sidecar's), asked for a given vault. */
  readSidecar(vaultRoot: string, id: string): PictureSidecar | null
  /** The talks of a vault, with their outline paths. */
  talks(vaultRoot: string): TalkRef[]
  /** An outline's text; null when it cannot be read. */
  readOutline?(outlinePath: string): string | null
  now?(): number
}

export type VaultPictureSearch = {
  search(query: unknown): VaultPictureResult
  /** The file behind a `twasset://img-<id>?vault=<vaultId>` thumbnail, when it is a picture of an open vault. */
  fileFor(thumbUrl: string): Promise<ImageFile | null>
}

type Entry = { vault: VaultRef; pic: VaultPicture; sidecar: PictureSidecar | null; usedIn: ImageSearchHit['usedIn']; haystack: string }

export function vaultPictureUrl(id: string, vaultId: string): string {
  return `twasset://${id}?vault=${encodeURIComponent(vaultId)}`
}

/** Parse `twasset://img-<id>?vault=<vaultId>`; null for anything else. */
export function parseVaultPictureUrl(url: string): { id: string; vaultId: string } | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'twasset:') return null
  const vaultId = u.searchParams.get('vault')
  const id = u.hostname.toLowerCase()
  if (!vaultId || !/^img-[0-9a-f]{7,}$/.test(id)) return null
  return { id, vaultId }
}

const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

export function createVaultPictureSearch(deps: VaultPictureDeps): VaultPictureSearch {
  const now = deps.now ?? Date.now
  const readOutline = deps.readOutline ?? ((p: string) => { try { return readFileSync(p, 'utf8') } catch { return null } })
  let cache: { at: number; key: string; entries: Entry[] } | null = null

  function load(): Entry[] {
    const vaults = deps.vaults()
    const key = vaults.map((v) => v.id + '\0' + v.root).join('\n')
    if (cache && cache.key === key && now() - cache.at < CACHE_MS) return cache.entries
    const entries: Entry[] = []
    for (const vault of vaults) {
      const pics = scanVaultPool(vault.root)
      if (!pics.length) continue
      // Used-in: the talks of THIS vault that name each id (an id is a name in its own vault's pool).
      const wanted = new Set(pics.map((p) => p.id))
      const users = new Map<string, Map<string, string>>()
      for (const talk of deps.talks(vault.root)) {
        const text = readOutline(talk.outlinePath)
        if (!text) continue
        for (const m of text.matchAll(/img-(?:img-)?([0-9a-f]{7,})/gi)) {
          const id = 'img-' + m[1].toLowerCase()
          if (!wanted.has(id)) continue
          let talks = users.get(id)
          if (!talks) users.set(id, (talks = new Map()))
          talks.set(talk.outlinePath, talk.title)
        }
      }
      for (const pic of pics) {
        const sidecar = deps.readSidecar(vault.root, pic.id)
        const usedIn = [...(users.get(pic.id) ?? [])].map(([talkPath, talkTitle]) => ({ talkTitle, talkPath, slide: 0 }))
        const haystack = [sidecar?.caption, sidecar?.alt, ...(sidecar?.tags ?? []), pic.id + '.' + pic.ext].filter(Boolean).join(' ').toLowerCase()
        entries.push({ vault, pic, sidecar, usedIn, haystack })
      }
    }
    cache = { at: now(), key, entries }
    return entries
  }

  function hitOf(e: Entry): ImageSearchHit {
    const name = e.pic.id + '.' + e.pic.ext
    const title = e.sidecar?.caption?.trim() || e.sidecar?.alt?.trim() || name
    const detail = [e.sidecar?.tags?.length ? e.sidecar.tags.join(', ') : '', e.vault.name ?? ''].filter(Boolean).join(' · ')
    return {
      key: `vault:${e.vault.id}:${e.pic.id}`,
      source: 'vault-image',
      thumbUrl: vaultPictureUrl(e.pic.id, e.vault.id),
      title,
      detail,
      ocrText: '',
      match: 'words',
      score: 1,
      usedIn: e.usedIn,
      date: new Date(e.pic.mtimeMs).toISOString().slice(0, 10)
    }
  }

  return {
    search(query) {
      const q = typeof query === 'string' ? query.slice(0, MAX_VAULT_QUERY) : ''
      const terms = words(q)
      const all = load()
      // Every query word must start a word of the caption, alt text, tags or file name (case-insensitive).
      const matched = terms.length === 0 ? all : all.filter((e) => {
        const hay = words(e.haystack)
        return terms.every((t) => hay.some((h) => h.startsWith(t)))
      })
      // Newest first; the scan already sorted each vault that way, so a stable sort across vaults is enough.
      const ordered = [...matched].sort((a, b) => b.pic.mtimeMs - a.pic.mtimeMs)
      return { vaults: deps.vaults().length, hits: ordered.slice(0, MAX_VAULT_HITS).map(hitOf) }
    },
    async fileFor(thumbUrl) {
      const parsed = parseVaultPictureUrl(thumbUrl)
      if (!parsed) return null
      const vault = deps.vaults().find((v) => v.id === parsed.vaultId)
      if (!vault) return null
      // Asked again now, not taken from the last search: the file must still be a plain picture in the pool.
      const absPath = containedPoolFile(vault.root, parsed.id, ['webp', 'png', 'jpg', 'jpeg', 'gif'])
      if (!absPath || !isImageFile(absPath)) return null
      return { absPath, provenance: { source: 'vault-pictures', note: 'copied from another vault: ' + (vault.name ?? vault.id) } }
    }
  }
}
