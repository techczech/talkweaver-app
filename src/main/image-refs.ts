import { existsSync } from 'fs'
import { join } from 'path'

// Resolve pooled refs before compilation in both search and rendering paths. Unresolved refs
// remain authored text; the compiler reports missing media. Legacy double-prefixed IDs work too.
const REF_RE = /!\[([^\]]*)\]\((img-(?:img-)?[0-9a-f]{7}|vid-[0-9a-f]{7})\)/g
const IMAGE_EXTS = ['webp', 'png', 'jpg', 'jpeg', 'gif']
const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm']

export function resolveImageRefs(content: string, vaultRoot: string): string {
  if (!vaultRoot) return content
  const assetsDir = join(vaultRoot, '_assets')
  return content.replace(REF_RE, (whole, alt: string, rawId: string) => {
    const id = rawId.replace(/^img-img-/, 'img-')
    const exts = id.startsWith('vid-') ? VIDEO_EXTS : IMAGE_EXTS
    for (const ext of exts) {
      const path = join(assetsDir, id + '.' + ext)
      if (existsSync(path)) return `![${alt}](${path})`
    }
    return whole
  })
}
