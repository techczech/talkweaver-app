// "Where it came from" in the Inspector (several-vaults ticket 06; LOCKED-add-slide frames 5 and 6),
// as words. Pure, so the two views are tested without the app.
//   - On the Mac that inserted the slide (a private record in app data): the source vault, the source
//     talk and when it was inserted — "From: Personal vault · Talk: Metaphor talk 2026".
//   - Anywhere else: who inserted it and the source vault, and that its history is not here —
//     "From Dominik Lukeš · Personal vault · History not available here".
import type { SlideOriginInfo } from '../../../preload/index'

export type SlideProvenanceView = {
  mine: boolean
  /** The small line above the vault name: "From" (owner) or "From <inserted_by>" (colleague). */
  fromLine: string
  vaultLine: string
  rows: Array<{ label: string; value: string }>
  historyNote: string | null
  help: string
  /** The whole card in one line (aria-label, and what the tests read). */
  summary: string
}

export function slideProvenanceView(info: NonNullable<SlideOriginInfo>, now: Date = new Date()): SlideProvenanceView {
  const vaultLine = `${info.vaultName || 'Another'} vault`
  if (info.talkTitle) {
    const rows = [{ label: 'Talk', value: info.talkTitle }]
    const when = insertedLabel(info.insertedAt, now)
    if (when) rows.push({ label: 'Inserted', value: when })
    return {
      mine: true,
      fromLine: 'From',
      vaultLine,
      rows,
      historyNote: null,
      help: 'Copied into this talk. Editing it here does not change the original.',
      summary: `From: ${vaultLine} · Talk: ${info.talkTitle}`
    }
  }
  const who = info.insertedBy?.trim() || ''
  const firstName = who.split(/\s+/)[0] ?? ''
  return {
    mine: false,
    fromLine: who ? `From ${who}` : 'From',
    vaultLine,
    rows: [],
    historyNote: 'History not available here',
    help: firstName
      ? `You can edit and reuse this slide. Only ${firstName} has its earlier versions.`
      : 'You can edit and reuse this slide. Its earlier versions are not in this vault.',
    summary: `${who ? `From ${who} · ` : 'From '}${vaultLine} · History not available here`
  }
}

/** "Today, 09:31", "Yesterday, 17:02", else "3 Sept 2026, 09:31" (British order). */
export function insertedLabel(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((day(now) - day(at)) / 86_400_000)
  if (diff === 0) return `Today, ${time}`
  if (diff === 1) return `Yesterday, ${time}`
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']
  return `${at.getDate()} ${months[at.getMonth()]} ${at.getFullYear()}, ${time}`
}
