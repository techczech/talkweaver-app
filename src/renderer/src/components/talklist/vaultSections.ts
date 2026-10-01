import type { TalkInfo, VaultView } from '../../../../preload/index'
import { type TreeNode, focusNode } from '../talkTreeNav.ts'
import { type RowRef, collapseId, emptyKey, flattenTree, vaultKey } from './model.ts'

// Pure model of the Talks panel's vault sections (several-vaults ticket 03): which vault a talk
// belongs to, and the one row list the panel draws and the keyboard walks — a header per vault,
// then (for an open, expanded vault) its folder tree, or an empty-state block when it holds no talks.
// Nothing here touches React or the DOM.

/** Focus inside one vault's folder: the drill-in of the panel. */
export type VaultFocus = { vaultId: string; path: string }

const FOCUS_SEP = '\u001f'
export function encodeFocus(focus: VaultFocus | null): string {
  return focus && focus.path ? `${focus.vaultId}${FOCUS_SEP}${focus.path}` : ''
}
export function decodeFocus(raw: string | undefined): VaultFocus | null {
  if (!raw) return null
  const at = raw.indexOf(FOCUS_SEP)
  return at > 0 && at < raw.length - 1 ? { vaultId: raw.slice(0, at), path: raw.slice(at + 1) } : null
}

/** The vault a talk lives in: its stamped vaultId, else the first open vault. */
export function vaultIdOfTalk(talk: TalkInfo, vaults: VaultView[]): string | null {
  return talk.vaultId ?? vaults.find((v) => v.open && !v.unavailable)?.id ?? null
}

/** Open vaults' talks grouped by vault id (closed and unavailable vaults hold none in the panel). */
export function talksByVault(talks: TalkInfo[], vaults: VaultView[]): Map<string, TalkInfo[]> {
  const out = new Map<string, TalkInfo[]>(vaults.filter((v) => v.open && !v.unavailable).map((v) => [v.id, []]))
  for (const talk of talks) {
    const id = vaultIdOfTalk(talk, vaults)
    if (id) out.get(id)?.push(talk)
  }
  return out
}

/** Rows of the un-drilled panel: every vault in order. A closed vault is its header alone; an open
 *  one adds its tree (or the empty-state block); `sectionCollapsed` vaults show the header only. */
export function sectionRows(input: {
  vaults: VaultView[]
  trees: Map<string, TreeNode>
  collapsed: Set<string>
  sectionCollapsed: Set<string>
  lines?: Map<string, string>
  /** The Show filter (ticket 07): only this vault's section is drawn; the others are one line each. */
  showVaultId?: string | null
}): RowRef[] {
  const out: RowRef[] = []
  for (const vault of input.vaults) {
    if (input.showVaultId && vault.id !== input.showVaultId) {
      out.push({ kind: 'vault', key: vaultKey(vault.id), vaultId: vault.id, compact: true })
      continue
    }
    out.push({ kind: 'vault', key: vaultKey(vault.id), vaultId: vault.id })
    if (!vault.open || input.sectionCollapsed.has(vault.id)) continue
    // An unavailable vault lists no talks: its header is followed by the note, never a tree.
    if (vault.unavailable) { out.push({ kind: 'empty', key: emptyKey(vault.id), vaultId: vault.id, unavailable: true }); continue }
    const tree = input.trees.get(vault.id)
    const rows = tree ? flattenTree(tree, input.collapsed, input.lines, vault.id) : []
    if (rows.length === 0) out.push({ kind: 'empty', key: emptyKey(vault.id), vaultId: vault.id })
    else out.push(...rows)
  }
  return out
}

/** Rows of a panel drilled into one folder of one vault: that folder's contents only. */
export function drilledRows(input: {
  focus: VaultFocus
  trees: Map<string, TreeNode>
  collapsed: Set<string>
  lines?: Map<string, string>
}): RowRef[] {
  const tree = input.trees.get(input.focus.vaultId)
  return tree ? flattenTree(focusNode(tree, input.focus.path), input.collapsed, input.lines, input.focus.vaultId) : []
}

/** The vault a row belongs to. */
export function rowVaultId(row: RowRef, vaults: VaultView[]): string | null {
  if (row.kind === 'vault' || row.kind === 'empty') return row.vaultId
  if (row.kind === 'folder') return row.vaultId ?? vaults.find((v) => v.open)?.id ?? null
  return vaultIdOfTalk(row.talk, vaults)
}

export { collapseId }
