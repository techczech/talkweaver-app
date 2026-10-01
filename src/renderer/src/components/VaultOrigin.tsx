import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { TalkVaultDefaults } from '../../../preload/index'
import { parseFrontmatterPairs } from '../../../shared/frontmatter-editor'
import { vaultStyleLabel } from '../../../shared/vault-defaults'
import { IcLock } from './talklist/icons'

// "Where these come from" (several-vaults ticket 04; LOCKED-edit-vault frame 7): on the title slide,
// the Inspector names which of the talk's affiliation, style, logo and author are the ones its vault
// gives new talks — the vault's badge for the shared values, the padlock for this person's author.
// A value the talk has changed is not listed. Read-only; nothing is written.

export default function VaultOrigin({ outlinePath, outlineContent }: { outlinePath: string; outlineContent: string }) {
  const [info, setInfo] = useState<TalkVaultDefaults>(null)
  useEffect(() => {
    let live = true
    const load = (): void => { void window.tw.vault.talkDefaults(outlinePath).then((r) => { if (live) setInfo(r) }).catch(() => {}) }
    load()
    const off = window.tw.vault.onVaultsChanged(load)
    return () => { live = false; off() }
  }, [outlinePath])
  const rows = useMemo(() => {
    if (!info) return []
    const pairs = parseFrontmatterPairs(outlineContent)
    const valueOf = (key: string): string => pairs.find((p) => p.key === key)?.value.trim().replace(/^["']|["']$/g, '') ?? ''
    return info.values.filter((v) => valueOf(v.key) === v.value)
  }, [info, outlineContent])
  if (!info || rows.length === 0) return null
  const fromVault = rows.filter((r) => r.source === 'vault').map((r) => r.label.toLowerCase())
  const note = [
    fromVault.length ? `${sentenceList(fromVault)} come${fromVault.length === 1 ? 's' : ''} from ${info.vault.name}.` : '',
    rows.some((r) => r.source === 'personal') ? 'Author is yours.' : ''
  ].filter(Boolean).join(' ')
  return (
    <section className="tw-vault-origin" aria-label="Where these come from" data-vault-origin>
      <h3>Where these come from</h3>
      {rows.map((r) => (
        <div className="tw-vault-origin-row" key={r.key} data-origin-key={r.key} data-origin-source={r.source}>
          <span>{r.label}</span>
          <span title={r.value}>{r.key === 'palette' ? vaultStyleLabel(r.value) : r.key === 'logo' ? r.value.split('/').pop() : r.value}</span>
          {r.source === 'vault'
            ? <span className="vs-vb sm" style={{ '--c': info.vault.color } as CSSProperties} title={`From ${info.vault.name}`}>{info.vault.initial}</span>
            : <span title="Yours, for this vault"><IcLock size={12} /></span>}
        </div>
      ))}
      <p>{note}</p>
    </section>
  )
}

function sentenceList(items: string[]): string {
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
  if (items.length === 1) return cap(items[0])
  return cap(items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1])
}
