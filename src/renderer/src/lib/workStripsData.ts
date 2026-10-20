// What the strips under the Metadata table read from the app: the work files (Work files folder of the
// open talk's vault) and the Runs of the talk in that vault. Null when the work files
// could not be read, so the table draws no strips and its Pre-work and Post-work rows stay plain text.
// Runs that could not be read come back as `runs: null`: the strips say so rather than "not sent to anyone".
// No file or Run is written here.
import type { WorkStripsData } from '../extensions/workStrips'

export async function loadWorkStripsData(talkSlug: string, vaultId?: string): Promise<WorkStripsData | null> {
  try {
    const listing = await window.tw.workFiles.list(vaultId)
    if (!listing) return null
    const sessions = await window.tw.sessions.list().catch(() => null)
    return {
      talkSlug,
      ...(vaultId ? { vaultId } : {}),
      files: listing.items.map((item) => ({ id: item.id, fileName: item.fileName, title: item.title, steps: item.steps.length })),
      runs: sessions ? sessions.runs.filter((run) => run.talkSlug === talkSlug && (!vaultId || run.vaultId === vaultId)) : null,
      now: Date.now()
    }
  } catch {
    return null
  }
}
