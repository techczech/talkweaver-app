import { extractInspectorSlideBlock } from '../components/inspectorModel'

export type OfflinePageSelection = { line: number; text: string }
export type OfflinePageCandidate = OfflinePageSelection & { source: string }

/** One-based source lines for literal Embed/Simulation references, excluding fenced examples. */
export function offlinePageCandidates(text: string, headingLine: number | null): OfflinePageCandidate[] {
  const block = extractInspectorSlideBlock(text, headingLine)
  if (!block || headingLine == null) return []
  const out: OfflinePageCandidate[] = []
  let fence: string | null = null
  for (const [offset, text] of block.split('\n').entries()) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(text)?.[1]
    if (mark) {
      if (!fence) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
      continue
    }
    if (fence) continue
    const source = /^\s*\[(?:Embed|Simulation):\s*([^\]\r\n]+)\]\s*(?:\{[^}]*\})?\s*$/i.exec(text)?.[1].trim()
    if (source && (/^https?:\/\//i.test(source) || /\.html?$/i.test(source))) out.push({ source, line: headingLine + offset, text })
  }
  return out
}

export function selectOfflinePage(text: string, headingLine: number, selection?: OfflinePageSelection):
  { ok: true; candidate: OfflinePageCandidate } | { ok: false; message: string } {
  const candidates = offlinePageCandidates(text, headingLine)
  if (selection) {
    const candidate = candidates.find(item => item.line === selection.line && item.text === selection.text)
    return candidate ? { ok: true, candidate } : { ok: false, message: 'The page line changed. Select it again in the Inspector.' }
  }
  if (candidates.length > 1) return { ok: false, message: 'This slide has more than one copy of that page. Select the one to save in the Inspector.' }
  return candidates.length === 1 ? { ok: true, candidate: candidates[0] } : { ok: false, message: 'Choose a slide with an HTML page first.' }
}

/** Re-read the buffer and change only the exact selected reference line. */
export function offlinePageReplacement(text: string, headingLine: number, selected: OfflinePageCandidate, embedPath: string): string | null {
  const candidate = offlinePageCandidates(text, headingLine).find(item => item.line === selected.line && item.text === selected.text && item.source === selected.source)
  if (!candidate || !/^assets\/[A-Za-z0-9._-]+\.html?$/.test(embedPath)) return null
  const lines = text.split('\n')
  const at = candidate.line - 1
  lines[at] = lines[at].replace(candidate.source, embedPath)
  if (/^https?:\/\//i.test(candidate.source)) lines[at] += `\n\n[Original page](<${candidate.source.replace(/>/g, '%3E').replace(/</g, '%3C')}>)`
  return lines.join('\n')
}
