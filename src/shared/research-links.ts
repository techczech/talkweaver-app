import { parseMarkdownFenceOpeningLine, isMarkdownFenceClosingLine } from '../../compiler/scripts/lib/03-object-token.mjs'

// Match the compiler's optional quoted link title, retaining escaped label brackets.
// Target spans also cover angle destinations, reference definitions and HTML assets.
const targets = [
  /!?\[(?:\\.|[^\]\\])*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|&quot;(?:(?!&quot;)[^\n])*&quot;))?\s*\)/gd,
  /^\s*\[(?!Embed:|Simulation:)[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gdi,
  /<(?:[a-z][\w-]*)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gdi,
  /<([^<>\n]+)>/gd,
  /^\[(?:Embed|Simulation):\s*(.+?)\]$/gdi,
]
interface Target { from: number; to: number; path: string; image: boolean }
function linkTargets(line: string): Target[] {
  const found: Target[] = []
  for (const pattern of targets) {
    for (const match of line.matchAll(pattern)) {
      const group = match.slice(1).findIndex(v => v !== undefined) + 1
      const span = match.indices?.[group]
      if (!span || found.some(t => span[0] < t.to && span[1] > t.from)) continue
      // Bare <...> is a destination, whereas an HTML tag is not.
      if (pattern === targets[3] && /^(?:\/?[a-z][\w-]*\s|\/|[a-z][\w-]*$)/i.test(match[group])) continue
      found.push({ from: span[0], to: span[1], path: match[group], image: match[0].startsWith('!') })
    }
  }
  return found.sort((a, b) => a.from - b.from)
}
const pathOnly = (path: string): string => path.split(/[?#]/, 1)[0]
export function researchLinks(text: string): { path: string }[] {
  return linkTargets(text).filter(t => !t.image).map(t => ({ path: pathOnly(t.path) }))
}
export function replaceResearchLinks(text: string, map: (path: string) => string): string {
  let fence: ReturnType<typeof parseMarkdownFenceOpeningLine> = null
  return text.split('\n').map(line => {
    if (fence) { if (isMarkdownFenceClosingLine(line, fence)) fence = null; return line }
    const opening = parseMarkdownFenceOpeningLine(line)
    if (opening) { fence = opening; return line }
    for (const target of linkTargets(line).reverse()) {
      const path = pathOnly(target.path)
      line = line.slice(0, target.from) + map(path) + target.path.slice(path.length) + line.slice(target.to)
    }
    return line
  }).join('\n')
}
export function researchPaths(text: string): string[] {
  return linkTargets(text).map(t => pathOnly(t.path))
}
