// @ts-expect-error markdown-it ships JavaScript without declarations in this app.
import MarkdownIt from 'markdown-it'
// @ts-expect-error Use the installed parser's image rule to capture its source boundaries.
import imageRule from 'markdown-it/lib/rules_inline/image.mjs'

/** Editable recipe uses oriented original pixels; derived PNGs are disposable renderings. */
export type ImageRect = { x: number; y: number; width: number; height: number }
export type ImageMark = ImageRect & { kind: 'arrow' | 'box' | 'highlight' | 'text'; colour: string; text: string; reverseX?: boolean; reverseY?: boolean }
export type ImageEditRecipe = { version: 1; crop: ImageRect; marks: ImageMark[] }
export type ImageEditSource = { originalId: string; width: number; height: number; recipe: ImageEditRecipe }
export type ImageEditPreview = ImageEditSource & { previewUrl: string }
export type ImageEditResult = { ok: true; id: string } | { ok: false; message: string }

export function validateImageRecipe(value: unknown, width: number, height: number): ImageEditRecipe {
  const r = value as ImageEditRecipe
  const rect = (v: ImageRect): boolean => !!v && [v.x,v.y,v.width,v.height].every(Number.isSafeInteger) && v.x >= 0 && v.y >= 0 && v.width > 0 && v.height > 0 && v.x + v.width <= width && v.y + v.height <= height
  if (!r || r.version !== 1 || !rect(r.crop) || !Array.isArray(r.marks) || r.marks.length > 100) throw new Error('Choose a crop inside the image and at most 100 marks.')
  for (const m of r.marks) {
    if (!rect(m) || !['arrow','box','highlight','text'].includes(m.kind) || !/^#[0-9a-f]{6}$/i.test(m.colour) || typeof m.text !== 'string' || m.text.length > 300 || (m.reverseX !== undefined && typeof m.reverseX !== 'boolean') || (m.reverseY !== undefined && typeof m.reverseY !== 'boolean') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(m.text)) throw new Error('Check the mark coordinates, colour and label.')
  }
  return { version: 1, crop: {...r.crop}, marks: r.marks.map(m => ({...m})) }
}
const escape = (s: string): string => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!))
/** Only validated geometry/colour and escaped labels enter SVG. Same rendering in preview and saved copy. */
export function imageMarksSvg(recipe: ImageEditRecipe, width: number, height: number): string {
  const parts = recipe.marks.map((m, i) => {
    const {x,y,width:w,height:h,colour:c} = m
    if (m.kind === 'text') return `<text x="${x}" y="${y+h}" fill="${c}" font-family="sans-serif" font-size="${h}">${escape(m.text)}</text>`
    if (m.kind === 'arrow') return `<defs><marker id="a${i}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="${c}"/></marker></defs><path d="M${m.reverseX?x+w:x} ${m.reverseY?y+h:y} L${m.reverseX?x:x+w} ${m.reverseY?y:y+h}" stroke="${c}" stroke-width="${Math.max(2,Math.round(width/250))}" marker-end="url(#a${i})"/>`
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${m.kind==='highlight'?c:'none'}" fill-opacity="0.3" stroke="${m.kind==='box'?c:'none'}" stroke-width="${Math.max(2,Math.round(width/250))}"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
}

type Destination = { id: string; from: number; to: number }
type ImageToken = { type: string; children?: ImageToken[] | null; attrGet: (name: string) => string | null; meta?: { editDestination?: Destination } }
type InlineState = { src: string; pos: number; posMax: number; tokens: ImageToken[] }
const imageMarkdown = new MarkdownIt({ html: true })
// Capture only spans accepted by the real image rule. Searching raw text can hit escaped text or titles.
imageMarkdown.inline.ruler.at('image', (state: InlineState, silent: boolean) => {
  const start = state.pos
  const accepted = imageRule(state, silent)
  if (!accepted || silent) return accepted
  const token = state.tokens[state.tokens.length - 1]
  const labelEnd = imageMarkdown.helpers.parseLinkLabel(state, start + 1, false)
  if (state.src[labelEnd + 1] !== '(') return accepted // Reference-style image: no writable destination.
  let from = labelEnd + 2
  while (/[ \t\n]/.test(state.src[from] ?? '') && from < state.pos) from++
  const destination = imageMarkdown.helpers.parseLinkDestination(state.src, from, state.posMax)
  if (!destination.ok || destination.pos > state.pos) return accepted
  let to = destination.pos
  if (state.src[from] === '<') { from++; to-- }
  const id = token.attrGet('src')
  if (id && /^img-[0-9a-f]{7,64}$/.test(id) && state.src.slice(from,to) === id) {
    token.meta = { editDestination: { id, from, to } }
  }
  return accepted
})

function singleImageDestination(line: string, context: string, selectedLine: number): Destination | null {
  const env = {}
  const document = imageMarkdown.parse(context, env) as Array<{ type: string; map: [number,number] | null }>
  // Inline parsing alone would treat literal source inside code/HTML blocks as an editable image.
  if (!Number.isInteger(selectedLine) || context.split('\n')[selectedLine] !== line ||
      !document.some((token,index) => token.type === 'inline' && token.map &&
        selectedLine >= token.map[0] && selectedLine < token.map[1] &&
        ['paragraph_open','heading_open'].includes(document[index-1]?.type))) return null
  const blocks = imageMarkdown.parseInline(line, env)
  const images: ImageToken[] = []
  let uncertain = false
  const visit = (tokens: ImageToken[]): void => {
    for (const token of tokens) {
      if (token.type === 'image') images.push(token)
      // Unresolved reference syntax is plain text without its definitions; never guess past it.
      if (token.type === 'text' && 'content' in token && String(token.content).includes('![')) uncertain = true
      if (token.children) visit(token.children)
    }
  }
  visit(blocks)
  if (uncertain || images.length !== 1) return null
  const destination = images[0].meta?.editDestination
  if (!destination || line.slice(destination.from,destination.to) !== destination.id) return null
  return destination
}

/** Without a caret column, only a single, inline image token can identify the intended picture. */
export function pooledImageOnLine(line: string, context = line, selectedLine = context === line ? 0 : -1): string | null {
  return singleImageDestination(line, context, selectedLine)?.id ?? null
}

export function replaceEditedImageUse(text: string, oldId: string, newId: string, line?: number): string {
  const refuse = (): never => { throw new Error('Place the cursor on an unambiguous image use, or copy the new reference.') }
  if (!/^img-[0-9a-f]{7,64}$/.test(oldId) || !/^img-[0-9a-f]{7,64}$/.test(newId)) return refuse()
  const lines = text.split('\n')
  const selected = line ?? (lines.length === 1 ? 0 : -1)
  if (selected < 0 || selected >= lines.length) return refuse()
  const destination = singleImageDestination(lines[selected], text, selected)
  if (!destination || destination.id !== oldId) return refuse()
  const from = lines.slice(0,selected).reduce((offset,value) => offset + value.length + 1, 0) + destination.from
  if (text.slice(from,from+oldId.length) !== oldId) return refuse()
  return text.slice(0,from) + newId + text.slice(from+oldId.length)
}
