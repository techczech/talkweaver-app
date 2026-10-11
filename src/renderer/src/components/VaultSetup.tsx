import { useState } from 'react'
import { EXAMPLE_VAULT_TEXT } from '../../../shared/example-vault'
import { ExampleVaultCard } from './ExampleVaultCard'

interface Props {
  onVaultChosen: (root: string) => void
  /** Open example vault (onboarding ticket 06, state 01). Resolves with the sentence to show when
   *  nothing was opened, or null when the example vault is open. */
  onOpenExample?: () => Promise<string | null>
}

export default function VaultSetup({ onVaultChosen, onOpenExample }: Props) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function handleChoose() {
    const root = await window.tw.vault.chooseRoot()
    if (root) onVaultChosen(root)
  }

  async function handleExample() {
    if (!onOpenExample || busy) return
    setBusy(true)
    setMessage(null)
    try {
      setMessage(await onOpenExample())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="vault-setup">
      <div className="vault-setup-card">
        <div className="vault-setup-logo">TalkWeaver</div>
        <h1>Choose your Vault</h1>
        <p>
          Select the folder that contains your Talk folders. TalkWeaver will scan it for{' '}
          <code>*-outline.md</code> files.
        </p>
        <button className="btn-primary" onClick={handleChoose}>
          Choose Vault Folder
        </button>
        <p className="hint">
          This is typically your <code>presentations/</code> folder.
        </p>
        {onOpenExample && (
          <>
            <div className="vault-setup-or"><span>{EXAMPLE_VAULT_TEXT.or}</span></div>
            <ExampleVaultCard busy={busy} message={message} onOpen={() => { void handleExample() }} />
          </>
        )}
      </div>
    </div>
  )
}
