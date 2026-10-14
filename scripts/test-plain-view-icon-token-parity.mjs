// test:plain-view-icon-token-parity — plain view ticket 07, fix round 2.
//
// The Plain editor decides which braces are icon tokens with its own reader
// (src/shared/plain-view-icon-tokens.ts); the compiler decides what is drawn. One list of heading
// and paragraph lines (scripts/fixtures/plain-view-icon-token-lines.json: adjacent groups, quoted
// values that contain `icon=`, duplicates, escaped braces, URL tails, shared groups, tabs) goes
// through both, and for every line they must give the same icon key and the same spans.
//
//   heading    compiler: headingIconGroups (02-triggers-layout.mjs), and the outline tree's own
//              answer for that line (parseOutlineTree: node.titleIcon / deckTitleIcon);
//              editor: headingIcon, headingBraceGroups
//   paragraph  compiler: paragraphIconTokenAt (03-markdown-lexer.mjs), and what the lexer then
//              makes of the paragraph; editor: paragraphIconToken
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { headingBraceGroups as compilerGroups, headingIconGroups, iconTokensInGroup, parseHeadingAttrs } from '../compiler/scripts/lib/02-triggers-layout.mjs'
import { paragraphIconTokenAt, lexMarkdownBlocks } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { parseOutlineTree } from '../compiler/scripts/lib/14-outline-tree.mjs'
import { normalizeIconOverrideKey } from '../compiler/scripts/lib/05-icons.mjs'
import { headingBraceGroups, headingIcon, paragraphIconToken, groupHoldsIcon } from '../src/shared/plain-view-icon-tokens.ts'

const { headings, paragraphs } = JSON.parse(readFileSync(new URL('./fixtures/plain-view-icon-token-lines.json', import.meta.url), 'utf8'))
let checks = 0
let consumed = 0
let unauthored = 0

for (const line of headings) {
  const marks = line.match(/^(#{1,6})\s+/)
  assert.ok(marks, `${JSON.stringify(line)} is a heading line`)
  const offset = marks[0].length
  const raw = line.slice(offset)
  // The compiler reads the text after the `#` marks; the editor reads the whole line.
  const want = headingIconGroups(raw)
  const got = headingIcon(line)
  assert.equal(got.key, want.key, `heading key: ${JSON.stringify(line)}`)
  assert.deepEqual(got.groups, want.groups.map((g) => ({ start: g.start + offset, end: g.end + offset })), `heading icon groups: ${JSON.stringify(line)}`)
  assert.deepEqual(
    headingBraceGroups(line).map((g) => [g.start, g.end, g.inner, g.authored]),
    compilerGroups(raw).map((g) => [g.start + offset, g.end + offset, g.inner, g.authored]),
    `heading brace groups: ${JSON.stringify(line)}`
  )
  for (const g of headingBraceGroups(line)) {
    assert.equal(groupHoldsIcon(g.inner), iconTokensInGroup(g.inner).length > 0, `group holds an icon token: ${JSON.stringify(g.inner)}`)
  }
  // The groups are what the compiler CONSUMES, authored or not (eighth review): its title parser
  // takes exactly those ranges off the heading, so the line without them is the compiled title.
  // The Plain editor hides and protects the groups this reader returns (plainView/headingTail.ts;
  // test:plain-view-guarded-keys holds that on these same lines, in the editor).
  let rest = line
  for (const g of headingBraceGroups(line).reverse()) rest = rest.slice(0, g.start) + rest.slice(g.end)
  assert.equal(rest.slice(offset).trim(), parseHeadingAttrs(raw).title, `the groups are what the compiler takes off the title: ${JSON.stringify(line)}`)
  if (headingBraceGroups(line).length) consumed += 1
  if (headingBraceGroups(line).some((g) => !g.authored)) unauthored += 1
  // And the tree, which is what the slide's title is drawn from, says the same for this line.
  const tree = parseOutlineTree(marks[1].length === 1 ? `${line}\n\n## S\n` : `# T\n\n${line}\n\nBody.\n`)
  const treeKey = marks[1].length === 1 ? tree.deckTitleIcon?.icon ?? null : (function find(node) { for (const c of node.children) { const hit = c.titleIcon ?? find(c); if (hit) return hit } return null })(tree.root)
  assert.equal(treeKey, want.key, `the outline tree's title icon: ${JSON.stringify(line)}`)
  checks += 5
}

for (const text of paragraphs) {
  const want = paragraphIconTokenAt(text)
  const got = paragraphIconToken(text)
  if (!want) assert.equal(got, null, `paragraph: no token: ${JSON.stringify(text)}`)
  else assert.deepEqual(got, { from: want.from, tokenFrom: want.tokenFrom, tokenTo: want.tokenTo, key: want.key }, `paragraph token: ${JSON.stringify(text)}`)
  // The lexer strips exactly that span and reports that key (normalised), when the line is a paragraph.
  const blocks = lexMarkdownBlocks([`Lead ${text}`])
  if (blocks.length === 1 && blocks[0].type === 'paragraph') {
    const lead = paragraphIconToken(`Lead ${text}`)
    assert.equal(blocks[0].icon ?? null, lead ? normalizeIconOverrideKey(lead.key) : null, `the lexer's icon: ${JSON.stringify(text)}`)
    assert.equal(blocks[0].text, lead ? `Lead ${text}`.slice(0, lead.from).trim() : `Lead ${text}`.trim(), `the lexer's text: ${JSON.stringify(text)}`)
    checks += 2
  }
  checks += 1
}

assert.ok(headings.length >= 40 && paragraphs.length >= 30)
assert.ok(consumed >= 25 && unauthored >= 10, `${consumed} heading lines with consumed groups, ${unauthored} with a group that is not authored`)
console.log(`test:plain-view-icon-token-parity — ${checks} checks over ${headings.length} heading lines and ${paragraphs.length} paragraph lines`)
