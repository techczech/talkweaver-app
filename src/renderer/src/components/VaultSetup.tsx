interface Props {
  onVaultChosen: (root: string) => void
}

export default function VaultSetup({ onVaultChosen }: Props) {
  async function handleChoose() {
    const root = await window.tw.vault.chooseRoot()
    if (root) onVaultChosen(root)
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
      </div>
    </div>
  )
}
