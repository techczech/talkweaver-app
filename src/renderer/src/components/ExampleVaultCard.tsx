import { EXAMPLE_VAULT_TEXT } from '../../../shared/example-vault'

// The example card (onboarding ticket 06; locked drawing state 01): the E badge, "Open the
// example vault" with the Example pill, the line about it, the fixed path, and the button. Used by
// first-launch VaultSetup and by the Add vault… sheet. Strings come from EXAMPLE_VAULT_TEXT.

export function ExampleVaultCard({ busy, message, onOpen }: { busy: boolean; message: string | null; onOpen: () => void }) {
  return (
    <div className="example-card-wrap">
      <div className="example-card" data-example-card>
        <span className="example-card-badge" aria-hidden>E</span>
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
