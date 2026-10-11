import type { CSSProperties } from 'react'
import { EXAMPLE_VAULT_TEXT } from '../../../shared/example-vault'

// The example card (onboarding ticket 06; locked drawing state 01): the teal E badge, "Open the
// example vault" with the Example pill, the line about it, the fixed path, and the button. Used by
// first-launch VaultSetup and by the Add vault… sheet. Strings come from EXAMPLE_VAULT_TEXT.

export const EXAMPLE_VAULT_COLOUR = '#0f766e'

export function ExampleVaultCard({ busy, message, onOpen }: { busy: boolean; message: string | null; onOpen: () => void }) {
  return (
    <div className="example-card-wrap">
      <div className="example-card" data-example-card>
        <span className="example-card-badge" style={{ '--c': EXAMPLE_VAULT_COLOUR } as CSSProperties} aria-hidden>E</span>
        <div className="example-card-text">
          <b>{EXAMPLE_VAULT_TEXT.title}<span className="example-pill">{EXAMPLE_VAULT_TEXT.mark}</span></b>
          <span>{EXAMPLE_VAULT_TEXT.sub}</span>
          <small>{EXAMPLE_VAULT_TEXT.path}</small>
        </div>
        <button type="button" className="example-card-btn" onClick={onOpen} disabled={busy} data-open-example>
          {EXAMPLE_VAULT_TEXT.button}
        </button>
      </div>
      {message && <p className="example-card-msg" role="status" data-example-message>{message}</p>}
    </div>
  )
}
