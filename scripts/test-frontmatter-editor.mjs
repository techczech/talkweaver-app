import { strict as assert } from 'node:assert'
import { editFrontmatterText, parseFrontmatterPairs } from '../src/shared/frontmatter-editor.ts'

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

console.log('frontmatter editor: scalar, structured, alias, EOL and unknown-byte preservation pass')
