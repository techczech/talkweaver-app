// The pure part of slide-image-refs (no fs): which picture references a slide's markdown names. Shared so the
// renderer can key its picture-text request on the references (slideSearch.ts) with the same extractor the main process uses.
const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i

export type ImageRefKind = 'picture' | 'video'
export interface ImageRef { ref: string; kind: ImageRefKind }

function stripComments(md: string): string {
  return md.includes('<!--') ? md.replace(/<!--[\s\S]*?-->/g, ' ') : md
}

function cleanRef(raw: string): string {
  let s = raw.trim()
  if (s.startsWith('<')) {
    const end = s.indexOf('>')
    s = end > 0 ? s.slice(1, end) : s.slice(1)
  } else {
    s = s.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '')
  }
  return s.trim()
}

function kindOf(ref: string): ImageRefKind {
  return VIDEO_RE.test(ref.split(/[?#]/)[0]) || /^vid-[0-9a-f]{7}$/.test(ref) ? 'video' : 'picture'
}

/** Every picture reference in a slide's markdown, as written (unresolved), without repeats. */
export function extractImageRefs(markdown: string): ImageRef[] {
  const md = String(markdown || '')
  // Cheap exit: a slide with none of the carrier characters names no picture.
  if (!md.includes('![') && !md.includes('<') && !md.includes('[Video') && !md.includes('[video')) return []
  const text = stripComments(md)
  const seen = new Set<string>()
  const out: ImageRef[] = []
  const add = (raw: string | undefined): void => {
    if (!raw) return
    const ref = cleanRef(raw)
    if (!ref || seen.has(ref)) return
    seen.add(ref)
    out.push({ ref, kind: kindOf(ref) })
  }
  for (const m of text.matchAll(/!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g)) add(m[1])
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*(<[^>]*>|[^)]+)\)/g)) add(m[1])
  for (const m of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) add(m[1] ?? m[2] ?? m[3])
  for (const m of text.matchAll(/<video\b[^>]*?\bposter\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) add(m[1] ?? m[2] ?? m[3])
  for (const m of text.matchAll(/\[video:\s*([^\]]+?)\s*\]/gi)) add(m[1].replace(/\s*\{[^}]*\}\s*$/, ''))
  return out
}

