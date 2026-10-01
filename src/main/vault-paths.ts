// Where the vault-management, thumbnail-cache and asset-sidecar handlers may act. Each takes a
// path, a vault-relative folder, a name or a slug from the renderer; these functions turn them into
// absolute paths and refuse anything that would land outside its root — lexically or once symlinks
// are resolved — so a handler that gets `{ ok: false }` touches nothing on disk.

import { statSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { isSafeTalkSlug } from './runs.ts'
import { pathStaysInside } from './path-containment.ts'

export { pathStaysInside }

export type VaultPathError =
  | 'no-vault'
  | 'outside-vault'
  | 'vault-root'
  | 'unsafe-name'
  | 'unsafe-slug'
  | 'unsafe-id'
  | 'not-a-talk'
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
  const text = rel === undefined || rel === null ? '' : String(rel)
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
  const clean = String(name ?? '').trim().replace(/[/\\]/g, '-')
  if (!clean || clean === '.' || clean === '..' || /[\u0000-\u001f\u007f]/.test(clean)) return null
  return clean
}

/** vault:create-folder — `<vault>/<parentRel>/<name>`. */
export function createFolderTarget(vaultRoot: string | null | undefined, name: unknown, parentRel: unknown): VaultPath {
  const clean = cleanFolderName(name)
  if (!clean) return refuse('unsafe-name')
  const parent = vaultFolder(vaultRoot, parentRel, true)
  if (!parent.ok) return parent
  const path = join(parent.path, clean)
  return staysInside(resolve(vaultRoot as string), path) ? { ok: true, path } : refuse('outside-vault')
}

/** vault:rename-folder — the folder (never the vault root) and its renamed sibling. */
export function renameFolderTargets(
  vaultRoot: string | null | undefined,
  folderRel: unknown,
  newName: unknown
): { ok: true; src: string; dest: string } | { ok: false; error: VaultPathError } {
  const clean = cleanFolderName(newName)
  if (!clean) return refuse('unsafe-name')
  const src = vaultFolder(vaultRoot, folderRel)
  if (!src.ok) return src
  const dest = join(dirname(src.path), clean)
  if (!staysInside(resolve(vaultRoot as string), dest)) return refuse('outside-vault')
  return { ok: true, src: src.path, dest }
}

/** vault:delete-folder — a folder inside the vault, never the vault root. */
export function deleteFolderTarget(vaultRoot: string | null | undefined, folderRel: unknown): VaultPath {
  return vaultFolder(vaultRoot, folderRel)
}

/**
 * The talk folder of a renderer-supplied outline path (delete-talk, move-talk): the outline must
 * be inside the vault and its folder must be a folder inside the vault, not the vault root.
 */
export function talkFolderOfOutline(vaultRoot: string | null | undefined, outlinePath: unknown): VaultPath {
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
  if (relative(root, folder).split(sep).some((part) => part.startsWith('_') || part.startsWith('.'))) return refuse('not-a-talk')
  return { ok: true, path: folder }
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
  if (!staysInside(resolve(vaultRoot as string), dest)) return refuse('outside-vault')
  return { ok: true, srcDir: src.path, destParent: parent.path, dest }
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
  return staysInside(root, path) ? { ok: true, path } : refuse('outside-vault')
}

/** abstract:read / abstract:write — `<talk folder>/abstract.md`, itself inside the vault. */
export function abstractPath(vaultRoot: string | null | undefined, talkPath: unknown): VaultPath {
  const folder = talkFolderPath(vaultRoot, talkPath)
  if (!folder.ok) return folder
  const path = join(folder.path, 'abstract.md')
  return staysInside(resolve(vaultRoot as string), path) ? { ok: true, path } : refuse('outside-vault')
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
  return staysInside(resolve(vaultRoot), path) ? { ok: true, path } : refuse('outside-vault')
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
  return staysInside(resolve(vaultRoot as string), path) ? { ok: true, path } : refuse('outside-vault')
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
