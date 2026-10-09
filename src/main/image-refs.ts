import { lstatSync, realpathSync } from 'fs'
import { join, resolve, sep } from 'path'

// Resolve pooled refs before compilation in both search and rendering paths. Unresolved refs
// remain authored text; the compiler reports missing media. Legacy double-prefixed IDs work too.
const REF_RE = /!\[([^\]]*)\]\((img-(?:img-)?[0-9a-f]{7}|vid-[0-9a-f]{7})\)/g
const IMAGE_EXTS = ['webp', 'png', 'jpg', 'jpeg', 'gif']
const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm']

// Is there an entry with this name in the pool? Asked with lstat, which never follows a link: a
// pooled name that is a symlink is rewritten whether or not its target exists, so nothing here
// depends on a file outside the vault. Whether the file may be READ is the compiler's question
// (ADR-0036): it resolves the rewritten path for real and refuses one that leaves the vault with the
// same `asset-outside-vault` warning either way.
function poolEntryExists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

const below = (root: string, path: string): boolean => path.startsWith(root.endsWith(sep) ? root : root + sep)

/** Is the talk at `talkPath` in the vault at `vaultRoot`? As written, or once both are resolved. */
export function talkIsInVault(talkPath: string, vaultRoot: string): boolean {
  if (below(resolve(vaultRoot), resolve(talkPath))) return true
  try { return below(realpathSync(vaultRoot), realpathSync(talkPath)) } catch { return false }
}

/**
 * `talkPath`, when given, is the outline the text belongs to: a pooled id is a name in THAT talk's
 * vault, so the text of a talk that is not in `vaultRoot` (a loose file, compiled while another
 * vault happens to be the current one) is returned as it is. Its pooled ids then stay ids, which
 * the compiler reports as missing; they are never pointed at a vault the talk does not belong to.
 */
export function resolveImageRefs(content: string, vaultRoot: string, talkPath?: string): string {
  if (!vaultRoot) return content
  if (typeof talkPath === 'string' && talkPath && !talkIsInVault(talkPath, vaultRoot)) return content
  const assetsDir = join(vaultRoot, '_assets')
  return content.replace(REF_RE, (whole, alt: string, rawId: string) => {
    const id = rawId.replace(/^img-img-/, 'img-')
    const exts = id.startsWith('vid-') ? VIDEO_EXTS : IMAGE_EXTS
    for (const ext of exts) {
      const path = join(assetsDir, id + '.' + ext)
      if (poolEntryExists(path)) return `![${alt}](${path})`
    }
    return whole
  })
}
