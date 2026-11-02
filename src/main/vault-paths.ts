// Where the vault-management, thumbnail-cache and asset-sidecar handlers may act. Each takes a
// path, a vault-relative folder, a name or a slug from the renderer; these functions turn them into
// absolute paths and refuse anything that would land outside its root — lexically or once symlinks
// are resolved — so a handler that gets `{ ok: false }` touches nothing on disk.

import { lstatSync, readdirSync, realpathSync, statSync, type Stats } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { folderRole } from '../shared/vault-gallery-browse.ts'
import { isSafeTalkSlug } from './runs.ts'
import { pathStaysInside } from './path-containment.ts'
import { pickOutlineEntry } from './talk-scan.mjs'

export { pathStaysInside }

export type VaultPathError =
  | 'no-vault'
  | 'outside-vault'
  | 'vault-root'
  | 'unsafe-name'
  | 'unsafe-slug'
  | 'unsafe-id'
  | 'not-a-talk'
  | 'inspect-only'
  | 'not-found'
export type VaultPath = { ok: true; path: string } | { ok: false; error: VaultPathError }

function refuse(error: VaultPathError): { ok: false; error: VaultPathError } {
  return { ok: false, error }
}

function staysInside(root: string, target: string, allowRoot = false): boolean {
  return pathStaysInside(root, target, allowRoot) !== null
}

/**
 * A vault-relative folder (forward- or back-slashed, as vaultRel() returns it). '' is the vault
 * root and is accepted only with `allowRoot` (create-folder's parent, move-talk's destination).
 */
export function vaultFolder(vaultRoot: string | null | undefined, rel: unknown, allowRoot = false): VaultPath {
  if (!vaultRoot) return refuse('no-vault')
  if (rel !== undefined && rel !== null && typeof rel !== 'string') return refuse('outside-vault')
  const text = typeof rel === 'string' ? rel : ''
  if (text.includes('\0') || isAbsolute(text) || /^[a-zA-Z]:/.test(text)) return refuse('outside-vault')
  const parts = text.split(/[/\\]+/).filter(Boolean)
  if (parts.some((part) => part === '..' || part === '.')) return refuse('outside-vault')
  const root = resolve(vaultRoot)
  const path = parts.length ? join(root, ...parts) : root
  if (path === root && !allowRoot) return refuse('vault-root')
  return staysInside(root, path, allowRoot) ? { ok: true, path } : refuse('outside-vault')
}

/**
 * A single folder name typed by the person (create / rename). Separators become '-' as before;
 * then '.', '..', empty and control characters are refused.
 */
export function cleanFolderName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const clean = name.trim().replace(/[/\\]/g, '-')
  if (!clean || clean === '.' || clean === '..' || /[\u0000-\u001f\u007f]/.test(clean)) return null
  return clean
}

/**
 * Assets, research and system folders are inspect-only to folder and talk management, by the browser's
 * own rule (folderRole), so the category list, the offered actions and these handlers cannot disagree.
 * The spellings a name rule can know are folded here: APFS and NTFS ignore case, APFS also reaches `s` by
 * `ſ` and `ss` by `ß` or `ẞ` (found by trying every code point on an APFS volume), and NTFS drops trailing
 * dots and spaces. This is not how a disk compares names in general: a part already on disk is judged again
 * by the name the disk stores (storedParts).
 */
export function inspectOnlyFolderName(name: string): boolean {
  return folderRole(foldedName(name)) !== 'ordinary'
}

function foldedName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/ß/g, 'ss').replace(/(?<=[^. ])[. ]+$/, '')
}

/** A talk folder by the scan's one rule; a folder that cannot be read is not a category either. */
function holdsTalk(dir: string): boolean {
  try { return pickOutlineEntry(readdirSync(dir, { withFileTypes: true }), basename(dir)) !== null } catch { return true }
}

/** The entry itself, never a link's target; null when nothing is there. */
function entryAt(path: string): Stats | null {
  try { return lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * On the way from the root to `path`, which need not exist: a link anywhere (the walks never follow one,
 * so no category lies behind it), or a plain file or a talk above the last part. Only parts below the
 * root count, so a vault reached through a link stays a vault. An answer the disk will not give refuses.
 */
function wayRefusal(root: string, path: string): VaultPathError | null {
  const parts = relative(root, path).split(sep).filter(Boolean)
  try {
    let current = root
    for (const [index, part] of parts.entries()) {
      current = join(current, part)
      const entry = entryAt(current)
      if (!entry) return null
      if (entry.isSymbolicLink()) return 'inspect-only'
      if (index < parts.length - 1 && (!entry.isDirectory() || holdsTalk(current))) return 'inspect-only'
    }
    return null
  } catch { return 'inspect-only' }
}

/**
 * The parts of `path` below the root as the disk stores them, whichever spelling asked: what a volume's own
 * aliases come down to. Only for a way wayRefusal has passed, so a real path changes nothing but the spelling.
 * Parts not on disk yet have no stored name and are left out.
 */
function storedParts(root: string, path: string): string[] {
  let deepest = path
  while (deepest !== root && !entryAt(deepest)) deepest = dirname(deepest)
  return relative(realpathSync.native(root), realpathSync.native(deepest)).split(sep).filter(Boolean)
}

/** Whether management may enter `path`: no inspect-only name below the root as asked or as stored, nothing refused on the way. */
function managementRefusal(root: string, path: string): VaultPathError | null {
  if (relative(root, path).split(sep).filter(Boolean).some(inspectOnlyFolderName)) return 'unsafe-name'
  const way = wayRefusal(root, path)
  if (way) return way
  try { return storedParts(root, path).some(inspectOnlyFolderName) ? 'unsafe-name' : null } catch { return 'inspect-only' }
}

/** Folder builders check containment before refusing inspect-only destinations. Read from disk just before the caller acts. */
function reservedChecked(vaultRoot: string, path: string): { ok: false; error: VaultPathError } | null {
  const root = resolve(vaultRoot)
  if (!staysInside(root, path)) return refuse('outside-vault')
  const error = managementRefusal(root, resolve(path))
  return error ? refuse(error) : null
}

/**
 * The existing folder rename-folder and delete-folder act on: a category folder, so a real folder that
 * is not a talk and is not inspect-only. Nothing there is left for the handler to answer. What a category
 * holds is never judged: binning one takes the talks and their assets with it.
 */
function categoryFolder(vaultRoot: string | null | undefined, folderRel: unknown): VaultPath {
  const folder = vaultFolder(vaultRoot, folderRel)
  if (!folder.ok) return folder
  const error = managementRefusal(resolve(vaultRoot as string), folder.path)
  if (error) return refuse(error)
  try {
    const entry = entryAt(folder.path)
    return !entry || (entry.isDirectory() && !holdsTalk(folder.path)) ? folder : refuse('inspect-only')
  } catch { return refuse('inspect-only') }
}

/** vault:create-folder — `<vault>/<parentRel>/<name>`. */
export function createFolderTarget(vaultRoot: string | null | undefined, name: unknown, parentRel: unknown): VaultPath {
  const clean = cleanFolderName(name)
  if (!clean) return refuse('unsafe-name')
  const parent = vaultFolder(vaultRoot, parentRel, true)
  if (!parent.ok) return parent
  const path = join(parent.path, clean)
  return reservedChecked(vaultRoot as string, path) ?? { ok: true, path }
}

/** vault:rename-folder — the folder (never the vault root) and its renamed sibling. */
export function renameFolderTargets(
  vaultRoot: string | null | undefined,
  folderRel: unknown,
  newName: unknown
): { ok: true; src: string; dest: string } | { ok: false; error: VaultPathError } {
  const clean = cleanFolderName(newName)
  if (!clean) return refuse('unsafe-name')
  const src = categoryFolder(vaultRoot, folderRel)
  if (!src.ok) return src
  const dest = join(dirname(src.path), clean)
  const refusal = reservedChecked(vaultRoot as string, dest)
  if (refusal) return refusal
  return { ok: true, src: src.path, dest }
}

/** vault:delete-folder — a category folder inside the vault, never the vault root. */
export function deleteFolderTarget(vaultRoot: string | null | undefined, folderRel: unknown): VaultPath {
  const folder = categoryFolder(vaultRoot, folderRel)
  if (!folder.ok) return folder
  try { return entryAt(folder.path) ? folder : refuse('not-found') } catch { return refuse('inspect-only') }
}

/** What the person reads when an import destination is refused, at the picker or on starting. */
export const IMPORT_DESTINATION_REFUSED =
  'Choose the vault or a category folder. Assets, research and system folders, talks and links cannot hold an imported talk.'

/**
 * Where a person sends an import: the vault root or a category, there already or still to be made. Judged
 * before anything is created. The talk's own assets and runs that follow are the app's writers, not this.
 */
export function importDestinationFolder(vaultRoot: string | null | undefined, topicFolder: unknown): VaultPath {
  const folder = vaultFolder(vaultRoot, topicFolder, true)
  if (!folder.ok || folder.path === resolve(vaultRoot as string)) return folder
  return categoryFolder(vaultRoot, topicFolder)
}

/**
 * The talk folder of a renderer-supplied outline path, for the handlers that manage a talk (rename,
 * duplicate, move, Bin): an outline with no link among the folder's outlines, in a folder that is not
 * itself a link and is not filed inside anything inspect-only. A link anywhere among them is refused, not
 * only the one asked for, because a handler picks the outline again by name after this check.
 * Its own name is its own, with one condition: a talk called `assets` is a talk when its outline is named
 * for the folder. Any other outline in such a folder is a stray file, and taking it for a talk would hand
 * the whole folder to rename, move and Bin.
 */
export function talkFolderOfOutline(vaultRoot: string | null | undefined, outlinePath: unknown): VaultPath {
  const talk = listedTalkFolder(vaultRoot, outlinePath)
  if (!talk.ok) return talk
  const root = resolve(vaultRoot as string)
  const inside = relative(root, dirname(talk.path)).split(sep).filter(Boolean)
  if (inside.some(inspectOnlyFolderName)) return refuse('not-a-talk')
  const error = wayRefusal(root, talk.path)
  if (error) return refuse(error)
  try {
    const parts = storedParts(root, talk.path)
    if (parts.slice(0, -1).some(inspectOnlyFolderName)) return refuse('not-a-talk')
    const own = parts.at(-1) ?? ''
    if (inspectOnlyFolderName(own) && foldedName(basename(resolve(outlinePath as string))) !== foldedName(`${own}-outline.md`)) return refuse('not-a-talk')
    const entries = readdirSync(talk.path, { withFileTypes: true })
    return entries.some((entry) => entry.isSymbolicLink() && foldedName(entry.name).endsWith('-outline.md')) ? refuse('not-a-talk') : talk
  } catch { return refuse('inspect-only') }
}

/**
 * Who stands at a talk's place right now: the folder and the folder that holds it. A handler that has
 * awaited compares this as well as judging the path again, because a path can stay valid while what it
 * names has been swapped.
 */
export function talkPlace(talkDir: string): string {
  const folder = lstatSync(talkDir)
  const parent = lstatSync(dirname(talkDir))
  return `${parent.dev}:${parent.ino}/${folder.dev}:${folder.ino}`
}

/** A title can be anything; the folder it names cannot read as assets, research or a system folder. */
export function folderSlugFor(slug: string): string {
  return slug && inspectOnlyFolderName(slug) ? `${slug}-talk` : slug
}

/**
 * The outline must be inside the vault and its folder must be a folder inside the vault, not the vault
 * root. Enough for reading and writing what a talk holds (its abstract); managing it asks for more above.
 */
function listedTalkFolder(vaultRoot: string | null | undefined, outlinePath: unknown): VaultPath {
  if (!vaultRoot) return refuse('no-vault')
  if (typeof outlinePath !== 'string' || !outlinePath || outlinePath.includes('\0') || !isAbsolute(outlinePath)) {
    return refuse('outside-vault')
  }
  const root = resolve(vaultRoot)
  const outline = resolve(outlinePath)
  if (!staysInside(root, outline)) return refuse('outside-vault')
  const folder = dirname(outline)
  if (folder === root) return refuse('vault-root')
  if (!staysInside(root, folder)) return refuse('outside-vault')
  // A talk folder is one the talk list can show: it holds an existing `*-outline.md` file, and no
  // part of its path is a system area (`_assets`, `_PRESENTATIONS`, any `_…`) or hidden (`.…`) —
  // the scan never descends into those, so trashing or moving them is never a talk operation.
  if (!outline.endsWith('-outline.md') || !isExistingFile(outline)) return refuse('not-a-talk')
  if (relative(root, folder).split(sep).some((part) => part.startsWith('_') || part.startsWith('.')) || inReservedFolder(root, folder)) return refuse('not-a-talk')
  return { ok: true, path: folder }
}

/**
 * A folder named `research` (any case) anywhere under the vault root is reserved for captured
 * research (CONTEXT.md, "research folder"): never a talk, never an outline or abstract source.
 * Only the segments below `root` count, so a vault that is itself called Research is not reserved.
 */
export function inReservedFolder(root: string, folder: string): boolean {
  return relative(root, folder).split(sep).some((part) => part.toLowerCase() === 'research')
}

function isExistingFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/** vault:move-talk — the talk folder and its destination `<vault>/<destFolderRel>/<talk folder name>`. */
export function moveTalkTargets(
  vaultRoot: string | null | undefined,
  outlinePath: unknown,
  destFolderRel: unknown
): { ok: true; srcDir: string; destParent: string; dest: string } | { ok: false; error: VaultPathError } {
  const src = talkFolderOfOutline(vaultRoot, outlinePath)
  if (!src.ok) return src
  const parent = vaultFolder(vaultRoot, destFolderRel, true)
  if (!parent.ok) return parent
  const dest = join(parent.path, basename(src.path))
  const root = resolve(vaultRoot as string)
  if (!staysInside(root, dest)) return refuse('outside-vault')
  // A talk keeps its own name: only where it is going is judged.
  const error = managementRefusal(root, parent.path) ?? wayRefusal(root, dest)
  return error ? refuse(error) : { ok: true, srcDir: src.path, destParent: parent.path, dest }
}

/** A talk's thumbnail folder `<cacheRoot>/<slug>` (clear-thumb-cache, twthumb://). */
export function thumbCacheDir(cacheRoot: string, slug: unknown): VaultPath {
  if (!isSafeTalkSlug(slug)) return refuse('unsafe-slug')
  const root = resolve(cacheRoot)
  const path = join(root, slug)
  return staysInside(root, path) ? { ok: true, path } : refuse('outside-vault')
}

// Asset ids are `img-<hex>` / `vid-<hex>` (older imports: `img-img-<hex>`); a single safe name.
const SAFE_ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** asset:read-sidecar / asset:write-sidecar — `<vault>/_assets/<id>.yml`. */
export function assetSidecarPath(vaultRoot: string | null | undefined, id: unknown): VaultPath {
  if (!vaultRoot) return refuse('no-vault')
  if (typeof id !== 'string' || !SAFE_ASSET_ID_RE.test(id)) return refuse('unsafe-id')
  const assetsDir = join(resolve(vaultRoot), '_assets')
  const path = join(assetsDir, `${id}.yml`)
  return staysInside(resolve(vaultRoot), path) ? { ok: true, path } : refuse('outside-vault')
}

/**
 * A talk folder named by its absolute path (abstract:read / abstract:write take `talk.path`): a
 * folder inside the vault, never the vault root.
 */
export function talkFolderPath(vaultRoot: string | null | undefined, talkPath: unknown): VaultPath {
  if (!vaultRoot) return refuse('no-vault')
  if (typeof talkPath !== 'string' || !talkPath || talkPath.includes('\0') || !isAbsolute(talkPath)) return refuse('outside-vault')
  const root = resolve(vaultRoot)
  const path = resolve(talkPath)
  if (path === root) return refuse('vault-root')
  if (!staysInside(root, path)) return refuse('outside-vault')
  return inReservedFolder(root, path) ? refuse('not-a-talk') : { ok: true, path }
}

/** The guarded bare abstract path, used only as the resolver's read fallback. */
export function abstractPath(vaultRoot: string | null | undefined, talkPath: unknown): VaultPath {
  const folder = talkFolderPath(vaultRoot, talkPath)
  if (!folder.ok) return folder
  const path = join(folder.path, 'abstract.md')
  return staysInside(resolve(vaultRoot as string), path) ? { ok: true, path } : refuse('outside-vault')
}

/** Prefer the outline slug, then a unique older slug; never guess between abstracts. */
export function abstractPaths(
  vaultRoot: string | null | undefined,
  talkPath: unknown
): { ok: true; readPath: string | null; writePath: string; slug: string; source: 'named' | 'bare' | null; candidates: string[] } | { ok: false; error: VaultPathError } {
  const folder = talkFolderPath(vaultRoot, talkPath)
  if (!folder.ok) return folder
  // A talk folder without an outline uses its folder name, including after its first Save.
  let outlineName: string | undefined
  let names: string[] = []
  try {
    const items = readdirSync(folder.path, { withFileTypes: true })
    outlineName = pickOutlineEntry(items, basename(folder.path))?.name
    names = items.filter((entry) => entry.name.endsWith('-abstract.md') && isExistingFile(join(folder.path, entry.name))).map((entry) => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return refuse('not-a-talk')
  }
  if (outlineName) {
    const outline = listedTalkFolder(vaultRoot, join(folder.path, outlineName))
    if (!outline.ok) return outline
  }
  const slug = outlineName ? outlineName.slice(0, -'-outline.md'.length) : basename(folder.path)
  if (!isSafeTalkSlug(slug)) return refuse('unsafe-slug')
  let writePath = join(folder.path, `${slug}-abstract.md`)
  const root = resolve(vaultRoot as string)
  if (!staysInside(root, writePath)) return refuse('outside-vault')
  if (isExistingFile(writePath)) return { ok: true, readPath: writePath, writePath, slug, source: 'named', candidates: [] }
  if (names.length === 1) {
    writePath = join(folder.path, names[0])
    if (!staysInside(root, writePath)) return refuse('outside-vault')
    return { ok: true, readPath: writePath, writePath, slug, source: 'named', candidates: [] }
  }
  if (names.length > 1) return { ok: true, readPath: null, writePath, slug, source: null, candidates: names }
  const bare = abstractPath(vaultRoot, talkPath)
  if (!bare.ok) return bare
  const found = isExistingFile(bare.path)
  return { ok: true, readPath: found ? bare.path : null, writePath, slug, source: found ? 'bare' : null, candidates: [] }
}

/**
 * vault:clone-talk / vault:rename-talk — a new talk folder `<slug>` beside `srcDir` (same parent,
 * which may be the vault root). The slug must be a single name and the folder must stay inside.
 */
export function siblingTalkFolder(vaultRoot: string | null | undefined, srcDir: string, slug: unknown): VaultPath {
  if (!vaultRoot) return refuse('no-vault')
  if (typeof slug !== 'string' || !slug || slug === '.' || slug === '..' || /[/\\\u0000-\u001f\u007f]/.test(slug)) {
    return refuse('unsafe-name')
  }
  const path = join(dirname(srcDir), slug)
  return reservedChecked(vaultRoot, path) ?? { ok: true, path }
}

/**
 * An outline path from the renderer for a handler that writes (the outline itself, or files beside
 * it: dist/, handouts, assets, present files, thumbnails): an absolute `*-outline.md` whose real
 * path is inside the vault. Talks are only ever found inside the vault (the scan skips links), so
 * every outline the app lists passes.
 */
export function outlineInVault(vaultRoot: string | null | undefined, outlinePath: unknown): VaultPath {
  if (!vaultRoot) return refuse('no-vault')
  if (typeof outlinePath !== 'string' || !isAbsolute(outlinePath) || !outlinePath.endsWith('-outline.md')) return refuse('outside-vault')
  return staysInside(resolve(vaultRoot), outlinePath) ? { ok: true, path: outlinePath } : refuse('outside-vault')
}

/** vault:create-talk — `<vault>/<topicFolder>/<slug>`: the topic folder inside the vault ('' = root), the slug one name. */
export function newTalkFolder(vaultRoot: string | null | undefined, slug: unknown, topicFolder: unknown): VaultPath {
  if (typeof slug !== 'string' || !slug || slug === '.' || slug === '..' || /[/\\\u0000-\u001f\u007f]/.test(slug)) {
    return refuse('unsafe-name')
  }
  const parent = vaultFolder(vaultRoot, topicFolder, true)
  if (!parent.ok) return parent
  const path = join(parent.path, slug)
  return reservedChecked(vaultRoot as string, path) ?? { ok: true, path }
}

/** What the person reads when a handler refuses an outline outside the current vault. */
export const OUTLINE_NOT_IN_VAULT = 'This talk is not in your current vault, so nothing was written.'
export const OUTLINE_NOT_SAVED_NOT_IN_VAULT =
  'This talk is not in your current vault; it was not saved. Switch back to that vault to keep editing it.'

/**
 * The refusal an outline-writing handler returns (never throws) when `outlinePath` is not an
 * outline inside the current vault — e.g. a second window still holding a talk after the vault root
 * was changed. null when the outline may be written.
 */
export function outlineRefusal(vaultRoot: string | null | undefined, outlinePath: unknown): string | null {
  return outlineInVault(vaultRoot, outlinePath).ok ? null : OUTLINE_NOT_IN_VAULT
}

/** talk:write-outline's refusal: the same `{ ok: false, refused }` shape as its empty-write backstop. */
export function outlineSaveRefusal(
  vaultRoot: string | null | undefined,
  outlinePath: unknown
): { ok: false; refused: 'outside-vault'; error: string } | null {
  return outlineInVault(vaultRoot, outlinePath).ok ? null : { ok: false, refused: 'outside-vault', error: OUTLINE_NOT_SAVED_NOT_IN_VAULT }
}

export const SET_ROOT_PICKER_ONLY = 'The vault folder can only be changed with the folder picker.'
export const SET_ROOT_NOT_A_FOLDER = 'The vault folder must be an existing folder given by its full path.'

/**
 * vault:set-root takes a path from the renderer, and the vault root bounds every containment guard,
 * so it is accepted only in the E2E test mode (TW_E2E=1) and only as an absolute, existing
 * directory. Production changes the root through vault:choose-root (the main-process dialog).
 * null when the path may be written.
 */
export function setRootRefusal(testMode: boolean, path: unknown): string | null {
  if (!testMode) return SET_ROOT_PICKER_ONLY
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) return SET_ROOT_NOT_A_FOLDER
  try { return statSync(path).isDirectory() ? null : SET_ROOT_NOT_A_FOLDER } catch { return SET_ROOT_NOT_A_FOLDER }
}
