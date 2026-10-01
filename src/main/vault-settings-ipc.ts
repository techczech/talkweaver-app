// Add a vault, join one, and Edit this vault (several-vaults ticket 04; LOCKED-edit-vault.html).
//
//   vault:choose-folder (path only under TW_E2E) → what the chosen folder is: a new vault (no vault
//       file: the New vault sheet), a vault set up elsewhere (a vault file: the join sheet), or a
//       refusal naming the vault it clashes with. Nothing is written; the folder is held in main
//       behind a one-time token, so the renderer never hands main a path to add.
//   vault:create(token, shared, personal) → Create vault: the vault file is written (once), then
//       the vault joins the list, then the personal settings are stored.
//   vault:join(token, personal) → Open vault: the vault joins the list with the file's id; only the
//       personal settings are stored. The vault file is not touched.
//   vault:get-settings(id) / vault:save-settings(id, shared, personal) → Edit this vault.
//   vault:choose-logo(target, path only under TW_E2E) → a logo file inside the vault, as a
//       vault-relative path plus a small preview.
//   vault:talk-defaults(outlinePath) → what a talk's vault gives new talks, and where each value
//       comes from (the Inspector's "Where these come from").
//
// Every refusal names the other vault (name, badge, service) and never a folder path.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { basename, extname, join, posix, relative, sep } from 'node:path'
import type { BrowserWindow as BrowserWindowT, Dialog, IpcMain, OpenDialogOptions } from 'electron'
import { VaultRefusal, type VaultPersonal, type VaultRegistry } from './vault-registry.ts'
import {
  copyLogoIntoVault, fileSchemaIsOurs, fileShared, fileText, isLogoFile, validateVaultFields, VaultFileError, vaultRelativeLogo,
  type VaultFileFields, type VaultFileRead
} from './vault-file.ts'
import { refusalMessage, serviceFor, vaultName, VAULT_PALETTE, vaultInitial, type AddVaultOutcome, type ServiceProbe, type VaultView } from './vault-view.ts'
import { pathStaysInside } from './path-containment.ts'
import { resolveNewTalkDefaults, vaultStyleLabel, vaultStyleOptions, VAULT_STYLE_KEY, type DefaultSource } from '../shared/vault-defaults.ts'

type Refusal = Extract<AddVaultOutcome, { ok: false }>

export type SharedFields = VaultFileFields
export type ChosenFolder =
  | {
    ok: true
    token: string
    kind: 'new' | 'join'
    folderName: string
    service: VaultView['service']
    /** join: the vault file's shared values, shown read-only. */
    vault: (SharedFields & { styleLabel: string; logoPreview: string | null; createdBy: string | null }) | null
    suggested: { name: string; author: string; badgeColour: string; badgeInitial: string }
    swatches: string[]
    styles: Array<{ value: string; label: string }>
  }
  | Refusal

export type VaultSettings =
  | {
    ok: true
    vault: VaultView
    fields: SharedFields
    logoPreview: string | null
    personal: VaultPersonal
    appAuthor: string
    swatches: string[]
    styles: Array<{ value: string; label: string }>
    /** The vault file cannot be saved as it is (unreadable, newer, another vault's): the shared group is read-only. */
    fileProblem: string | null
  }
  | Refusal

export type TalkVaultDefaults = {
  vault: { id: string; name: string; initial: string; color: string }
  values: Array<{ key: string; label: string; value: string; source: DefaultSource }>
} | null

export type VaultSettingsDeps = {
  ipcMain: Pick<IpcMain, 'handle'>
  dialog: Pick<Dialog, 'showOpenDialog'>
  windowOf: (sender: Electron.WebContents) => BrowserWindowT | null
  registry: VaultRegistry
  views: () => VaultView[]
  probe: ServiceProbe
  /** Settings › Presenter identity author. */
  appAuthor: () => string
  /** Settings › Presenter identity and deck defaults (normalised). */
  appDefaults: () => Record<string, string>
  e2e: boolean
}

const PENDING_MS = 30 * 60_000
const PREVIEW_MAX = 1_000_000
const IMAGE_MIME: Record<string, string> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif'
}

/** A refusal as the sheet shows it: the message, and the other vault's name, badge and service. */
export function refusalOutcome(error: unknown, views: () => VaultView[]): Refusal {
  if (error instanceof VaultRefusal) {
    const other = error.other ? views().find((v) => v.id === error.other?.id) ?? null : null
    return {
      ok: false,
      reason: error.reason,
      // A partial write says exactly what is left; every other refusal has its fixed sentence.
      message: error.reason === 'partial-write' ? error.message : refusalMessage(error.reason, other?.name ?? (error.other ? vaultName(error.other.root) : null)),
      other: other ? { id: other.id, name: other.name, initial: other.initial, color: other.color, service: other.service } : null
    }
  }
  if (error instanceof VaultFileError) return { ok: false, reason: error.reason, message: error.message }
  console.error('[vault-settings]', error)
  return { ok: false, reason: 'write-failed', message: 'TalkWeaver could not save that. Nothing was changed.' }
}

/** A small data: URI for a logo inside the vault (null when missing, outside, too big or not an image). */
export function logoPreview(root: string, rel: string | undefined): string | null {
  if (!rel) return null
  const abs = pathStaysInside(root, join(root, rel.split('/').join(sep)))
  return abs ? previewOfFile(abs) : null
}
function previewOfFile(abs: string): string | null {
  if (!existsSync(abs)) return null
  const mime = IMAGE_MIME[extname(abs).toLowerCase()]
  if (!mime) return null
  try {
    if (statSync(abs).size > PREVIEW_MAX) return null
    return `data:${mime};base64,${readFileSync(abs).toString('base64')}`
  } catch { return null }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const fieldsOf = (raw: unknown): Partial<SharedFields> => {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: Partial<SharedFields> = {}
  if (typeof r.name === 'string') out.name = r.name
  if (typeof r.shared === 'boolean') out.shared = r.shared
  if (typeof r.affiliation === 'string') out.affiliation = r.affiliation
  if (typeof r.style === 'string') out.style = r.style
  if (typeof r.logo === 'string') out.logo = r.logo
  return out
}
const personalOf = (raw: unknown): VaultPersonal => {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  return { author: str(r.author), badgeColour: str(r.badgeColour), badgeInitial: str(r.badgeInitial) }
}
/** The shared fields as the sheet sends them differ from what the vault has now. */
function sharedChanged(current: SharedFields, next: Partial<SharedFields>): boolean {
  const t = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  return (next.name !== undefined && t(next.name) !== t(current.name))
    || (next.shared !== undefined && next.shared !== current.shared)
    || (next.affiliation !== undefined && t(next.affiliation) !== t(current.affiliation))
    || (next.style !== undefined && t(next.style) !== t(current.style))
    || (next.logo !== undefined && t(next.logo) !== t(current.logo))
}
function sharedOf(read: VaultFileRead | null, root: string): SharedFields {
  const f = read && read.state === 'ok' ? read.file : null
  return {
    name: fileText(f, 'name') || vaultName(root),
    shared: fileShared(f),
    affiliation: fileText(f, 'affiliation'),
    style: fileText(f, 'style'),
    logo: fileText(f, 'logo')
  }
}

export function registerVaultSettingsIpc(deps: VaultSettingsDeps): void {
  const { ipcMain, registry, views } = deps
  const pending = new Map<string, { root: string; kind: 'new' | 'join'; at: number }>()
  const take = (token: unknown, keep = false): { root: string; kind: 'new' | 'join' } | null => {
    if (typeof token !== 'string') return null
    const hit = pending.get(token)
    if (!hit || Date.now() - hit.at > PENDING_MS) { pending.delete(String(token)); return null }
    if (!keep) pending.delete(token)
    return hit
  }
  const expired = (): Refusal => ({ ok: false, reason: 'expired', message: refusalMessage('expired', null) })
  // A logo chosen outside the vault: held here (never sent to the renderer as a path) until Save or
  // Create copies it into the vault's _assets/logos.
  const pendingLogos = new Map<string, { source: string; root: string; at: number }>()
  const uploadOf = (raw: unknown): string | null => {
    const token = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).logoUpload : null
    return typeof token === 'string' && token ? token : null
  }
  /** fields with a pending outside logo copied into root (after the text fields are checked), and
   *  the copy's vault-relative path so a later failure can take it back. The token stays until the
   *  whole change lands. */
  const withCopiedLogo = (root: string, fields: Partial<SharedFields>, raw: unknown, requireName: boolean): { fields: Partial<SharedFields>; copied: string | null } => {
    const token = uploadOf(raw)
    if (!token) return { fields, copied: null }
    const hit = pendingLogos.get(token)
    if (!hit || hit.root !== root || Date.now() - hit.at > PENDING_MS) throw new VaultFileError('logo-missing', 'Choose the logo again.')
    validateVaultFields(fields, requireName)
    const logo = copyLogoIntoVault(root, hit.source)
    return { fields: { ...fields, logo }, copied: logo }
  }
  /** Best-effort removal of a logo copied in by a change that then failed. True when it is gone. */
  const undoCopy = (root: string, rel: string): boolean => {
    const abs = pathStaysInside(root, join(root, ...rel.split('/')))
    if (!abs) return false
    try { unlinkSync(abs) } catch { /* checked below */ }
    return !existsSync(abs)
  }
  /** The refusal for a change that failed after copying a logo in: the copy is taken back, and when
   *  it cannot be, the message says it is still there instead of "Nothing was changed". */
  const failAfterCopy = (error: unknown, root: string, copied: string | null): Refusal => {
    const out = refusalOutcome(error, views)
    if (!copied || undoCopy(root, copied)) return out
    return { ...out, message: `${out.message.replace(/\s*Nothing was (changed|added)\.\s*$/, '')} A copy of the logo was left in the vault’s _assets/logos folder.`.trim() }
  }
  const viewOf = (id: string): VaultView | null => views().find((v) => v.id === id) ?? null
  const styles = vaultStyleOptions()
  const swatches = [...VAULT_PALETTE]

  async function pick(sender: Electron.WebContents, options: OpenDialogOptions): Promise<string | null> {
    const win = deps.windowOf(sender)
    const result = win ? await deps.dialog.showOpenDialog(win, options) : await deps.dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  }

  ipcMain.handle('vault:choose-folder', async (event, path?: unknown): Promise<ChosenFolder | null> => {
    const chosen = deps.e2e && typeof path === 'string' && path
      ? path
      : await pick(event.sender, { title: 'Add a vault', message: 'Choose a folder to use as a vault', properties: ['openDirectory', 'createDirectory'] })
    if (!chosen) return null
    try {
      if (!statSync(chosen).isDirectory()) throw new Error('not a folder')
    } catch {
      return { ok: false, reason: 'not-a-folder', message: refusalMessage('not-a-folder', null) }
    }
    let probe: ReturnType<VaultRegistry['probe']>
    try { probe = registry.probe(chosen) } catch (error) { return refusalOutcome(error, views) }
    if (probe.file.state === 'invalid') return { ok: false, reason: 'unreadable-file', message: refusalMessage('unreadable-file', null) }
    const kind = probe.file.state === 'ok' ? 'join' : 'new'
    const token = randomUUID()
    pending.set(token, { root: probe.root, kind, at: Date.now() })
    const folderName = vaultName(probe.root)
    const shared = sharedOf(probe.file, probe.root)
    const name = kind === 'join' ? shared.name : folderName
    const createdBy = probe.file.state === 'ok' ? fileText(probe.file.file, 'created_by') || null : null
    return {
      ok: true,
      token,
      kind,
      folderName,
      service: serviceFor(probe.root, deps.probe),
      vault: kind === 'join' ? { ...shared, styleLabel: vaultStyleLabel(shared.style), logoPreview: logoPreview(probe.root, shared.logo), createdBy } : null,
      suggested: { name, author: deps.appAuthor(), badgeColour: VAULT_PALETTE[registry.list().length % VAULT_PALETTE.length], badgeInitial: vaultInitial(name) },
      swatches,
      styles
    }
  })

  ipcMain.handle('vault:create', (_event, token: unknown, shared: unknown, personal: unknown): AddVaultOutcome => {
    const hit = take(token, true)
    if (!hit || hit.kind !== 'new') return expired()
    const mine = personalOf(personal)
    let copied: string | null = null
    try {
      registry.probe(hit.root) // still addable: nothing is copied into a folder that will be refused
      const prepared = withCopiedLogo(hit.root, fieldsOf(shared), shared, true)
      copied = prepared.copied
      const added = registry.add(hit.root, { create: { fields: prepared.fields, createdBy: mine.author || deps.appAuthor() } })
      pending.delete(String(token))
      const upload = uploadOf(shared)
      if (upload) pendingLogos.delete(upload)
      try { registry.setPersonal(added.id, mine) } catch (error) { console.error('[vault:create] personal settings not stored', error) }
      const view = viewOf(added.id)
      return view ? { ok: true, vault: view } : { ok: false, reason: 'unknown-vault', message: refusalMessage('unknown-vault', null) }
    } catch (error) {
      return failAfterCopy(error, hit.root, copied)
    }
  })

  ipcMain.handle('vault:join', (_event, token: unknown, personal: unknown): AddVaultOutcome => {
    const hit = take(token, true)
    if (!hit || hit.kind !== 'join') return expired()
    try {
      const added = registry.add(hit.root)
      pending.delete(String(token))
      try { registry.setPersonal(added.id, personalOf(personal)) } catch (error) { console.error('[vault:join] personal settings not stored', error) }
      const view = viewOf(added.id)
      return view ? { ok: true, vault: view } : { ok: false, reason: 'unknown-vault', message: refusalMessage('unknown-vault', null) }
    } catch (error) {
      return refusalOutcome(error, views)
    }
  })

  ipcMain.handle('vault:get-settings', (_event, vaultId: unknown): VaultSettings => {
    const vault = typeof vaultId === 'string' ? registry.get(vaultId) : null
    const view = vault ? viewOf(vault.id) : null
    if (!vault || !view) return { ok: false, reason: 'unknown-vault', message: refusalMessage('unknown-vault', null) }
    const read = registry.readFile(vault.id)
    let fileProblem: string | null = null
    if (read?.state === 'invalid') fileProblem = refusalMessage('unreadable-file', null)
    else if (read?.state === 'ok' && !fileSchemaIsOurs(read.file)) fileProblem = refusalMessage('newer-schema', null)
    else if (read?.state === 'ok' && read.file.id !== vault.id) fileProblem = refusalMessage('id-mismatch', null)
    const fields = sharedOf(read, vault.root)
    return {
      ok: true,
      vault: view,
      fields,
      logoPreview: logoPreview(vault.root, fields.logo),
      personal: registry.personal(vault.id),
      appAuthor: deps.appAuthor(),
      swatches,
      styles,
      fileProblem
    }
  })

  ipcMain.handle('vault:save-settings', (_event, vaultId: unknown, shared: unknown, personal: unknown): AddVaultOutcome => {
    if (typeof vaultId !== 'string' || !registry.get(vaultId)) return { ok: false, reason: 'unknown-vault', message: refusalMessage('unknown-vault', null) }
    const mine = personalOf(personal)
    const root = registry.get(vaultId)!.root
    let copied: string | null = null
    let fileSaved = false
    try {
      if (shared != null) {
        const vault = registry.get(vaultId)!
        const read = registry.readFile(vaultId)
        const patch = fieldsOf(shared)
        // Personal-only changes on a plain folder stay in app config: the vault file is written only
        // when a shared field is set or changed (or an outside logo is being brought in).
        const writeFile = read?.state === 'ok' || uploadOf(shared) !== null || sharedChanged(sharedOf(read, vault.root), patch)
        // Copy an outside logo in only when the file will accept the save (else saveFile refuses first).
        const saveable = read?.state === 'none' || (read?.state === 'ok' && fileSchemaIsOurs(read.file) && read.file.id === vault.id)
        let next: Partial<SharedFields> = patch
        if (saveable) ({ fields: next, copied } = withCopiedLogo(vault.root, patch, shared, read?.state !== 'ok'))
        if (writeFile) {
          registry.saveFile(vaultId, next, { createdBy: mine.author || deps.appAuthor() })
          fileSaved = true
          const upload = uploadOf(shared)
          if (upload) pendingLogos.delete(upload)
        }
      }
    } catch (error) {
      return failAfterCopy(error, root, copied)
    }
    try {
      registry.setPersonal(vaultId, mine)
    } catch (error) {
      if (!fileSaved) return refusalOutcome(error, views)
      // The vault file changed; only the personal part failed. Say so (S3).
      console.error('[vault:save-settings] personal settings not stored', error)
      return { ok: false, reason: 'partial-write', message: 'The shared settings were saved to the vault file, but your own settings for this vault could not be saved. Try again.' }
    }
    const view = viewOf(vaultId)
    return view ? { ok: true, vault: view } : { ok: false, reason: 'unknown-vault', message: refusalMessage('unknown-vault', null) }
  })

  ipcMain.handle('vault:choose-logo', async (event, target: unknown, path?: unknown): Promise<{ ok: true; logo: string; preview: string | null; upload?: string; fileName?: string } | Refusal | null> => {
    const t = (target && typeof target === 'object' ? target : {}) as { vaultId?: unknown; token?: unknown }
    let root: string | null = null
    if (typeof t.vaultId === 'string') root = registry.get(t.vaultId)?.root ?? null
    else if (typeof t.token === 'string') root = take(t.token, true)?.root ?? null
    if (!root) return expired()
    const chosen = deps.e2e && typeof path === 'string' && path
      ? path
      : await pick(event.sender, {
        title: 'Choose a logo',
        message: 'Choose a logo file inside this vault',
        defaultPath: root,
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif'] }]
      })
    if (!chosen) return null
    if (!isLogoFile(chosen)) return { ok: false, reason: 'not-an-image', message: 'A logo must be an SVG, PNG, JPEG, WebP or GIF image.' }
    try {
      const logo = vaultRelativeLogo(root, chosen)
      if (!logo) return null
      return { ok: true, logo, preview: logoPreview(root, logo) }
    } catch (error) {
      if (error instanceof VaultFileError && error.reason === 'logo-outside') {
        // Outside the vault: copied into <vault>/_assets/logos on Save / Create, not now.
        const upload = randomUUID()
        pendingLogos.set(upload, { source: chosen, root, at: Date.now() })
        return { ok: true, logo: '', upload, fileName: basename(chosen), preview: previewOfFile(chosen) }
      }
      return refusalOutcome(error, views)
    }
  })

  ipcMain.handle('vault:talk-defaults', (_event, outlinePath: unknown): TalkVaultDefaults => {
    if (typeof outlinePath !== 'string' || !outlinePath) return null
    const hit = registry.resolve(outlinePath)
    if (!hit) return null
    const view = viewOf(hit.vault.id)
    if (!view) return null
    const read = registry.readFile(hit.vault.id)
    const talkFolderRel = posix.dirname(hit.rel) === '.' ? '' : posix.dirname(hit.rel)
    const { defaults, sources } = resolveNewTalkDefaults({
      vaultFile: read?.state === 'ok' ? read.file : null,
      personal: registry.personal(hit.vault.id),
      app: deps.appDefaults(),
      talkFolderRel
    })
    const labels: Array<[string, string]> = [['affiliation', 'Affiliation'], [VAULT_STYLE_KEY, 'Style'], ['logo', 'Logo'], ['author', 'Author']]
    const values = labels
      .filter(([key]) => defaults[key] && sources[key] !== 'app')
      .map(([key, label]) => ({ key, label, value: defaults[key], source: sources[key] }))
    return { vault: { id: view.id, name: view.name, initial: view.initial, color: view.color }, values }
  })
}

/** Vault-relative folder of a new talk ('' for the vault root), '/'-separated. */
export function talkFolderRelOf(vaultRoot: string, talkDir: string): string {
  const rel = relative(vaultRoot, talkDir)
  return rel.split(sep).join('/')
}
