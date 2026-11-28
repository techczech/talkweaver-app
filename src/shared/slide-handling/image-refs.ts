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

/** Searchable names, alternative text and captions written on a slide. */
export function authoredPictureFields(markdown: string): { names: string[]; descriptions: string[] } {
  const text = stripComments(markdown)
  if (!text.includes('![') && !/<img\b/i.test(text)) return { names: [], descriptions: [] }
  const names = extractImageRefs(text).filter(picture => picture.kind === 'picture')
    .map(({ ref }) => ref.split(/[?#]/)[0].split(/[/\\]/).at(-1) ?? '')
  const descriptions: string[] = []
  for (const image of text.matchAll(/!\[([^\]]*)\]\(\s*([^)]+)\)/g)) {
    descriptions.push(image[1])
    const caption = /\s+(?:"([^"]*)"|'([^']*)')\s*$/.exec(image[2])
    if (caption) descriptions.push(caption[1] ?? caption[2])
  }
  for (const image of text.matchAll(/<img\b[^>]*>/gi)) {
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(image[0])
    if (alt) descriptions.push(alt[1] ?? alt[2])
  }
  return { names: names.filter(Boolean), descriptions: descriptions.filter(Boolean) }
}

export function authoredPictureText(markdown: string): string {
  const { names, descriptions } = authoredPictureFields(markdown)
  return [...names, ...descriptions].join('\n')
}

/** Text that can be shown beside a slide hit. Headings and pictures have their own fields. */
export function slideBodyForSearchDisplay(markdown: string): string {
  return stripComments(markdown)
    .replace(/^\s*#{1,6}[^\S\r\n]+[^\r\n]*/gm, '')
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\(\s*(?:<[^>]*>|[^)]+)\)|<img\b[^>]*>/gi, ' ')
    .replace(/^[^\S\r\n]*(?:[-*+]\s+|\d+[.)]\s+|[•–]\s*)/gm, '')
}

