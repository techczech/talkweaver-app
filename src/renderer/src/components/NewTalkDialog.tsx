import { useState, useMemo } from 'react'
import { NameCard } from './cards'
import type { TalkInfo } from '../../../preload/index'
import { safeTalkSlug } from '../../../shared/vault-gallery-browse'

interface Props {
  vaultRoot: string
  /** The vault the talk is made in (default: the first open vault). */
  vaultId?: string
  /** Existing subfolders (vault-rel paths) to choose from. */
  folders?: string[]
  /** Pre-selected subfolder (e.g. when "New talk here" was used on a folder). */
  defaultTopic?: string
  onCreated: (talk: TalkInfo) => void
  onClose: () => void
}

/** The talk main returned is authoritative; the dialog's vault only fills in an identity it left out. */
export const createdTalk = (talk: TalkInfo, vaultId: string): TalkInfo => ({ vaultId, ...talk })

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export default function NewTalkDialog({ vaultRoot: _vaultRoot, vaultId, folders = [], defaultTopic = '', onCreated, onClose }: Props) {
  const [topicFolder, setTopicFolder] = useState(defaultTopic)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sorted, de-duplicated subfolder options (always include the pre-selected one).
  const folderOptions = useMemo(() => {
    const set = new Set<string>()
    for (const f of folders) if (f) set.add(f)
    if (defaultTopic) set.add(defaultTopic)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [folders, defaultTopic])

  async function handleCreate(rawTitle: string) {
    const title = rawTitle.trim()
    if (!title) {
      setError('Give the talk a title.')
      return
    }
    // The file name is derived silently from the title; it is never shown.
    const slug = safeTalkSlug(slugify(title))
    if (!slug) {
      setError('That title has no letters or numbers to make a file name from. Add some and try again.')
      return
    }

    setError(null)
    setCreating(true)

    try {
      // IPC handler vault:create-talk is wired in main/index.ts
      const newTalk: TalkInfo | null = await (window as any).tw.vault.createTalk({
        title,
        slug,
        topicFolder: topicFolder.trim() || undefined,
        ...(vaultId ? { vaultId } : {})
      })
      if (!newTalk) {
        // Main refused (a name already taken, a protected folder): stay here and say so.
        setError('The talk could not be created. A talk with a very similar title may already exist here, or this is not a folder you can add talks to. Change the title or the subfolder and try again.')
        setCreating(false)
        return
      }
      onCreated(newTalk)
    } catch (err: any) {
      setError(err?.message ?? 'The talk could not be created.')
      setCreating(false)
    }
  }

  return (
    <NameCard
      kind="talk"
      mode="new"
      className="dialog-card"
      inputId="talk-title"
      placeholder="e.g. AI in Higher Education"
      cta={creating ? 'Creating…' : 'Create'}
      busy={creating}
      error={error}
      onCancel={onClose}
      onSubmit={(value) => void handleCreate(value)}
    >
      <label htmlFor="talk-topic" style={labelStyle}>
        Subfolder <span style={optionalStyle}>(where to create it)</span>
      </label>
      <select
        id="talk-topic"
        value={topicFolder}
        onChange={(e) => setTopicFolder(e.target.value)}
        style={selectStyle}
        disabled={creating}
      >
        <option value="">Vault root</option>
        {folderOptions.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
    </NameCard>
  )
}

const labelStyle: React.CSSProperties = { fontSize: 12.5, fontWeight: 500, color: 'var(--ink)' }
const optionalStyle: React.CSSProperties = { fontWeight: 400, color: 'var(--muted)' }
const selectStyle: React.CSSProperties = {
  padding: '7px 9px', fontSize: 13, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--paper)', color: 'var(--ink)'
}
