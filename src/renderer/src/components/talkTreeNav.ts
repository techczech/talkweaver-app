import type { TalkInfo } from '../../../preload/index'

// Pure sidebar tree-nav logic (no React/DOM). The replica in scripts/test-sidebar-logic.mjs MUST
// match these algorithms (the renderer has no TS test runner — same convention as
// searchPaletteSelection.ts / test-selector-logic.mjs).

// A folder node: leaf name, full vault-rel path, child folders, and the talks DIRECTLY in it.
export type TreeNode = { name: string; path: string; children: TreeNode[]; talks: TalkInfo[] }

// The topic subfolder a talk lives in (path between the vault root and the talk folder). '' = root.
export function topicOf(talk: TalkInfo, vaultRoot: string): string {
  let rel = talk.path.startsWith(vaultRoot) ? talk.path.slice(vaultRoot.length) : talk.path
  rel = rel.replace(/^\/+/, '')
  const parts = rel.split('/')
  parts.pop()
  return parts.join('/')
}

export function buildTree(talks: TalkInfo[], folders: string[], vaultRoot: string): TreeNode {
  const root: TreeNode = { name: '', path: '', children: [], talks: [] }
  const nodeAt = (path: string): TreeNode => {
    if (!path) return root
    let cur = root
    let acc = ''
    for (const part of path.split('/')) {
      acc = acc ? `${acc}/${part}` : part
      let child = cur.children.find((c) => c.name === part)
      if (!child) {
        child = { name: part, path: acc, children: [], talks: [] }
        cur.children.push(child)
      }
      cur = child
    }
    return cur
  }
  for (const f of folders) if (f) nodeAt(f)
  for (const t of talks) nodeAt(topicOf(t, vaultRoot)).talks.push(t)
  const sort = (n: TreeNode): void => {
    n.children.sort((a, b) => a.name.localeCompare(b.name))
    n.children.forEach(sort)
  }
  sort(root)
  return root
}

// The subtree to render from when drilled into `focusPath`; falls back to root for an empty or
// stale (deleted/renamed) path so the sidebar never dead-ends.
export function focusNode(root: TreeNode, focusPath: string): TreeNode {
  if (!focusPath) return root
  let cur = root
  for (const part of focusPath.split('/')) {
    const child = cur.children.find((c) => c.name === part)
    if (!child) return root
    cur = child
  }
  return cur
}

// Breadcrumb segments for a focus path: '' → []; 'a/b' → [{a,a},{b,a/b}].
export function breadcrumbCrumbs(focusPath: string): { name: string; path: string }[] {
  if (!focusPath) return []
  const out: { name: string; path: string }[] = []
  let acc = ''
  for (const part of focusPath.split('/')) {
    acc = acc ? `${acc}/${part}` : part
    out.push({ name: part, path: acc })
  }
  return out
}
