// Verifies the pure outline→tree parser (compiler/scripts/lib/14-outline-tree.mjs).
// Same fail-counting convention as scripts/test-slide-outline.mjs.

import { parseOutlineTree } from '../compiler/scripts/lib/14-outline-tree.mjs'

let fail = 0
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail++ } }

const doc = `---
title: Cats
outline_version: 2
---
# Cats
## Types of Cats {id=a1b2c}
{grid-zoom}
Intro paragraph.
### Tabby Cats {id=d3e4f}
#### Stripes
Body of stripes.
#### Whiskers
### Furry Cats
## Conclusion
`
const { meta, root, warnings } = parseOutlineTree(doc)
assert(meta.title === 'Cats', 'deck title from #')
assert(root.children.length === 2, 'two top sections')
const types = root.children[0]
assert(types.title === 'Types of Cats' && types.id === 'a1b2c', 'id token read')
assert(types.attrs['grid-zoom'] === true, 'trigger line folded')
assert(types.contentLines.join('\n').includes('Intro paragraph'), 'section keeps own content')
assert(types.children.length === 2, 'two subsections')
assert(types.children[0].children.length === 2, 'tabby has two leaf slides')
assert(types.children[0].children[0].title === 'Stripes', 'H4 is a real node')
// fence guard: headings inside code fences are content, not structure
const fenced = parseOutlineTree('## S\n```\n### not a slide\n```\n')
assert(fenced.root.children[0].children.length === 0, 'fenced heading is not a node')
// level gap warning
const gap = parseOutlineTree('## S\n#### Deep\n')
assert(gap.warnings.some((w) => w.startsWith('heading-level-gap')), 'gap warned')
assert(gap.root.children[0].children.length === 1, 'gap still nests as direct child')

// :::notes fence routes lines to notesLines, not contentLines
const withNotes = parseOutlineTree('## S\nbody line\n:::notes\nspeaker note\n:::\nmore body\n')
{
  const s = withNotes.root.children[0]
  assert(s.notesLines.join('\n').includes('speaker note'), 'notes fence captured')
  assert(!s.contentLines.join('\n').includes('speaker note'), 'notes text excluded from content')
  assert(s.contentLines.join('\n').includes('body line'), 'content before notes kept')
  assert(s.contentLines.join('\n').includes('more body'), 'content after notes kept')
}

// an unterminated :::notes block is implicitly closed by the next heading — the new node's
// body must land in contentLines, not leak into notesLines
{
  const t = parseOutlineTree('## A\n:::notes\nnote for A\n## B\nbody for B\n')
  const [a, b] = t.root.children
  assert(a.notesLines.join('\n').includes('note for A'), 'unterminated notes still captured on A')
  assert(b.contentLines.join('\n').includes('body for B'), 'next heading closes notes: B body is content')
  assert(b.notesLines.length === 0, 'B has no leaked notes')
}

// trigger line right after heading is excluded from contentLines and folded into attrs
{
  const t = parseOutlineTree('## S {sub}\n{numbered}\nreal content\n')
  const s = t.root.children[0]
  assert(s.attrs.sub === true, 'heading attr folded')
  assert(s.attrs.liststyle === 'numbers', 'trigger-line attr folded (numbered → liststyle=numbers)')
  assert(s.triggerLine === '{numbered}', 'triggerLine recorded')
  assert(!s.contentLines.join('\n').includes('{numbered}'), 'trigger line excluded from content')
  assert(s.contentLines.join('\n').includes('real content'), 'real content kept')
}

// {id=…} on the trigger line (heading has no id) still populates Node.id
{
  const t = parseOutlineTree('## S\n{id=zzzzz}\nbody\n')
  const s = t.root.children[0]
  assert(s.id === 'zzzzz', 'trigger-line id lands in Node.id')
  assert(s.attrs.id === 'zzzzz', 'trigger-line id also in attrs')
}

// BLANK-separated trigger line (heading + BLANK + {…} {id=…}): the tree parser tolerates the blank
// (triggerLineAfter skips blanks). This is the corpus form at the heart of the id-churn hotfix — the
// tree read is the reference the save-path id readers now match.
{
  const t = parseOutlineTree('### You cannot build muscle this way\n\n{image-claim} {id=musc1}\n\n- body\n')
  const s = t.root.children[0]
  assert(s.id === 'musc1', 'blank-separated trigger-line id lands in Node.id')
  assert(s.attrs.layout === 'image-claim', 'blank-separated trigger attr folded (image-claim → layout)')
  assert(!s.contentLines.join('\n').includes('{image-claim}'), 'blank-separated trigger line excluded from content')
  assert(s.contentLines.join('\n').includes('- body'), 'real content after blank-separated trigger kept')
}

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('outline-tree: all checks passed')
