// Words and small reckonings for the compare screen (several-vaults ticket 10; LOCKED-conflict
// frames 2, 3 and 6). Pure: no window, no IPC.

export type DiffLine = { kind: 'same' | 'del' | 'add'; text: string }
export type CompareSlideView = { index: number; id: string | null; title: string; text: string; match: number; differs: boolean; diff?: DiffLine[] }

const pad = (n: number): string => String(n).padStart(2, '0')

/** "Today 09:12", "Yesterday 18:40", else "29 Sep 18:40". */
export function savedLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'Time not known'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Time not known'
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return `Today ${time}`
  if (diff === 1) return `Yesterday ${time}`
  return `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })} ${time}`
}

export function clockTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const slidesCount = (n: number): string => `${n} slide${n === 1 ? '' : 's'}`

/** The Merge button: "Merge" alone when nothing is ticked, else "Merge · add N slides". */
export function mergeLabel(ticked: number): string {
  return ticked === 0 ? 'Merge' : `Merge · add ${slidesCount(ticked)}`
}

export function keepLabel(label: string): string {
  return `Keep ${label}, then choose slides`
}

/** The slides that differ between the versions, counted once per pair (a slide in one version only
 *  counts too), and the ones that are the same in both. */
export function differenceCounts(mine: CompareSlideView[], theirs: CompareSlideView[]): { differ: number; same: number } {
  const same = mine.filter((s) => !s.differs).length
  const pairs = mine.filter((s) => s.differs).length + theirs.filter((s) => s.differs && s.match === -1).length
  return { differ: pairs, same }
}

/** Where the service made the copy (the screen's subtitle). */
export function serviceLine(service: string): string {
  switch (service) {
    case 'onedrive': return 'OneDrive made a second copy because the talk was edited on two Macs'
    case 'dropbox': return 'Dropbox made a conflicted copy because the talk was edited in two places'
    case 'gdrive': return 'Google Drive made a second copy because the talk was edited in two places'
    case 'git': return 'Git left conflict markers in the talk after a merge'
    default: return 'A second copy of the talk was made'
  }
}

/** The banner when a file changed while comparing (frame 6). */
export function staleMessage(label: string, at: string | null): string {
  const when = clockTime(at)
  const where = label === 'this Mac' ? 'on this Mac' : `on ${label}`
  return `The talk changed while you were comparing. It was saved again ${where}${when ? ` at ${when}` : ''}. Nothing has been merged. Start again to compare the latest versions.`
}

/** The lines a slide card draws: its title and up to `max` content lines, markup and Trigger lines
 *  taken off. */
export function slideLines(text: string, max = 3): { title: string; lines: string[] } {
  const all = String(text ?? '').split('\n').map((l) => l.replace(/\r$/, ''))
  const title = (all[0] ?? '').replace(/^#{1,6}\s+/, '').replace(/(?:\s*\{[^}]*\})+\s*$/, '').trim()
  const lines = all.slice(1)
    .filter((l) => l.trim() !== '' && !/^\s*(\{[^}]*\}\s*)+$/.test(l) && !/^\s*:::/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_`]/g, '').trim())
    .slice(0, max)
  return { title, lines }
}

/** A difference for one side of a pair: that side's changed lines ('del' = Mine's, 'add' = the
 *  other's), each with at most one unchanged line before it; runs of unchanged lines between become
 *  one "…". */
export function sideDiff(diff: DiffLine[] | undefined, kind: 'del' | 'add'): Array<{ kind: 'same' | 'changed' | 'gap'; text: string }> {
  if (!diff) return []
  const side = diff.filter((l) => l.kind === 'same' || l.kind === kind)
  const out: Array<{ kind: 'same' | 'changed' | 'gap'; text: string }> = []
  side.forEach((l, i) => {
    if (l.kind !== 'same') { out.push({ kind: 'changed', text: l.text }); return }
    const nextChanged = side[i + 1] && side[i + 1].kind !== 'same'
    if (nextChanged) { out.push({ kind: 'same', text: l.text }); return }
    if (out.length && out[out.length - 1].kind !== 'gap' && side.slice(i + 1).some((x) => x.kind !== 'same')) out.push({ kind: 'gap', text: '…' })
  })
  return out
}
