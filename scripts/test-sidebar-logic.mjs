// Verifies the pure sidebar tree-nav logic. The functions below MUST match
// src/renderer/src/components/talkTreeNav.ts exactly (same algorithm) — this is a logic guard, since
// the renderer has no TS test runner. (Same convention as scripts/test-selector-logic.mjs.)

function topicOf(talk, vaultRoot) {
  let rel = talk.path.startsWith(vaultRoot) ? talk.path.slice(vaultRoot.length) : talk.path
  rel = rel.replace(/^\/+/, '')
  const parts = rel.split('/')
  parts.pop()
  return parts.join('/')
}
function buildTree(talks, folders, vaultRoot) {
  const root = { name: '', path: '', children: [], talks: [] }
  const nodeAt = (path) => {
    if (!path) return root
    let cur = root
    let acc = ''
    for (const part of path.split('/')) {
      acc = acc ? `${acc}/${part}` : part
      let child = cur.children.find((c) => c.name === part)
      if (!child) { child = { name: part, path: acc, children: [], talks: [] }; cur.children.push(child) }
      cur = child
    }
    return cur
  }
  for (const f of folders) if (f) nodeAt(f)
  for (const t of talks) nodeAt(topicOf(t, vaultRoot)).talks.push(t)
  const sort = (n) => { n.children.sort((a, b) => a.name.localeCompare(b.name)); n.children.forEach(sort) }
  sort(root)
  return root
}
function focusNode(root, focusPath) {
  if (!focusPath) return root
  let cur = root
  for (const part of focusPath.split('/')) {
    const child = cur.children.find((c) => c.name === part)
    if (!child) return root
    cur = child
  }
  return cur
}
function breadcrumbCrumbs(focusPath) {
  if (!focusPath) return []
  const out = []
  let acc = ''
  for (const part of focusPath.split('/')) {
    acc = acc ? `${acc}/${part}` : part
    out.push({ name: part, path: acc })
  }
  return out
}

let fail = 0
const ck = (c, m) => { if (!c) { console.error('FAIL:', m); fail++ } }
const V = '/vault'
const talks = [
  { path: '/vault/intro', title: 'Intro', slug: 'intro', name: 'intro', outlinePath: '/vault/intro/intro-outline.md' },
  { path: '/vault/agents/keynote', title: 'Keynote', slug: 'keynote', name: 'keynote', outlinePath: '/vault/agents/keynote/keynote-outline.md' },
  { path: '/vault/agents/research/lts', title: 'LTS', slug: 'lts', name: 'lts', outlinePath: '/vault/agents/research/lts/lts-outline.md' }
]
ck(topicOf(talks[0], V) === '', 'topicOf root talk → ""')
ck(topicOf(talks[1], V) === 'agents', 'topicOf nested → "agents"')
ck(topicOf(talks[2], V) === 'agents/research', 'topicOf deep → "agents/research"')

const tree = buildTree(talks, [], V)
ck(tree.talks.length === 1 && tree.talks[0].slug === 'intro', 'root talks')
ck(tree.children.length === 1 && tree.children[0].name === 'agents', 'top folder agents')
const agents = tree.children[0]
ck(agents.talks.length === 1 && agents.talks[0].slug === 'keynote', 'agents direct talk')
ck(agents.children.length === 1 && agents.children[0].name === 'research', 'agents/research subfolder')

ck(focusNode(tree, '') === tree, 'focusNode "" → root')
ck(focusNode(tree, 'agents').name === 'agents', 'focusNode agents')
ck(focusNode(tree, 'agents/research').name === 'research', 'focusNode deep')
ck(focusNode(tree, 'nope') === tree, 'focusNode stale path → root')

ck(JSON.stringify(breadcrumbCrumbs('')) === '[]', 'crumbs "" → []')
ck(JSON.stringify(breadcrumbCrumbs('agents')) === JSON.stringify([{ name: 'agents', path: 'agents' }]), 'crumbs one level')
ck(JSON.stringify(breadcrumbCrumbs('agents/research')) === JSON.stringify([{ name: 'agents', path: 'agents' }, { name: 'research', path: 'agents/research' }]), 'crumbs two levels')

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('sidebar-logic: all checks passed')
