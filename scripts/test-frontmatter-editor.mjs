import { strict as assert } from 'node:assert'
import { editFrontmatterText, locateFrontmatter, parseFrontmatterPairs } from '../src/shared/frontmatter-editor.ts'

const source = `---\r
title: Original\r
# keep this comment byte-for-byte\r
defaults:\r
  title: side\r
  image: left\r
mystery: untouched\r
---\r
\r
# Original\r
\r
Body\r
`

const pairs = parseFrontmatterPairs(source)
assert.equal(pairs.find((pair) => pair.key === 'defaults')?.value, '\n  title: side\n  image: left')
assert.equal(pairs.find((pair) => pair.key === 'mystery')?.value, 'untouched')

const edited = editFrontmatterText(source, [
  { key: 'title', value: 'Changed' },
  { key: 'palette', value: 'green' },
  { key: 'defaults', value: '\n  title: top\n  image: right', raw: true }
])
assert(edited.includes('# keep this comment byte-for-byte\r\n'))
assert(edited.includes('mystery: untouched\r\n'))
assert(edited.includes('defaults:\r\n  title: top\r\n  image: right\r\n'))
assert(edited.endsWith('# Original\r\n\r\nBody\r\n'))

const removedAlias = editFrontmatterText('---\nwarn_at: 7\nother: yes\n---\n# T\n', [
  { key: 'warn-at', aliases: ['warn_at'], value: null }
])
assert.equal(removedAlias, '---\nother: yes\n---\n# T\n')

const created = editFrontmatterText('# No metadata\n', [{ key: 'title', value: 'New deck' }])
assert.equal(created, '---\ntitle: New deck\n---\n\n# No metadata\n')

// Irregular delimiters (ticket 08 review S2). The editor's Metadata table finds the block by trimmed
// `---` lines; the writer must edit THAT block, never prepend a second one or reach into the body.
// Whole output strings are asserted: every byte outside the one key is kept.
// An empty block, with a slide separator further down (the old pattern ran on to the body's `---`).
assert.equal(
  editFrontmatterText('---\n---\n\n# T\n\n---\n\nbody\n', [{ key: 'prework', value: 'research-teams-intake' }]),
  '---\nprework: research-teams-intake\n---\n\n# T\n\n---\n\nbody\n'
)
// An empty block with nothing below it, as the table hands it over (the block alone, no final break).
assert.equal(editFrontmatterText('---\n---', [{ key: 'prework', value: 'a-file' }]), '---\nprework: a-file\n---')
// An empty block, CRLF.
assert.equal(editFrontmatterText('---\r\n---\r\n# T\r\n', [{ key: 'postwork', value: 'b' }]), '---\r\npostwork: b\r\n---\r\n# T\r\n')
// Removing a key an empty block does not have, or a removal-only edit: the text comes back unchanged.
assert.equal(editFrontmatterText('---\n---\n# T\n', [{ key: 'prework', value: null }]), '---\n---\n# T\n')
// A trailing space on the opening delimiter, and on the closing one: both kept as written.
assert.equal(
  editFrontmatterText('--- \ntitle: T\n# keep\n---  \n\n# T\n\n---\nbody\n', [{ key: 'prework', value: 'a-file' }]),
  '--- \ntitle: T\n# keep\nprework: a-file\n---  \n\n# T\n\n---\nbody\n'
)
assert.equal(
  editFrontmatterText('---\t\r\ntitle: T\r\nprework: old\r\n--- \r\nbody\r\n', [{ key: 'prework', value: 'new-one' }]),
  '---\t\r\ntitle: T\r\nprework: new-one\r\n--- \r\nbody\r\n'
)
// Removing the last key keeps one blank line in the block, as before.
assert.equal(editFrontmatterText('---\nprework: a\n---\nbody\n', [{ key: 'prework', value: null }]), '---\n\n---\nbody\n')
// The reader sees the same block.
assert.deepEqual(parseFrontmatterPairs('--- \nprework: a-file\n--- \nbody\n'), [{ key: 'prework', value: 'a-file' }])
assert.deepEqual(parseFrontmatterPairs('---\n---\n# T\n---\nnot: metadata\n'), [])
assert.deepEqual(locateFrontmatter('---\n---'), { contentFrom: 4, contentTo: 4, to: 7, eol: '\n' })
assert.equal(locateFrontmatter('# T\n---\n'), null)
assert.equal(locateFrontmatter('---\ntitle: never closed\n'), null)
// A line that only starts with --- is not a delimiter.
assert.equal(editFrontmatterText('---\ntitle: T\n----\nx: 1\n---\nbody\n', [{ key: 'y', value: '2' }]), '---\ntitle: T\n----\nx: 1\ny: 2\n---\nbody\n')

console.log('frontmatter editor: scalar, structured, alias, EOL, unknown-byte preservation and irregular delimiters pass')
