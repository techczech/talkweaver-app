// Architectural grep gate. These are syntactic
// tripwires, not proof against differently named or aliased implementations; behavioural tests remain required.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const read = file => readFileSync(join(root, file), 'utf8')
const files = dir => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : /\.[cm]?[jt]sx?$/.test(e.name) ? [join(dir, e.name)] : [])
const selectionSurface = file => /(?:\/slide-browser\/|\/scratchpad\/|\/(?:SlideBrowser|SlideStrip|SlidesOrganizer|GridView|PathwaysView|Pathways|SearchPalette|ScratchpadPanel|useSlideSelection)\.[jt]sx?$)/.test(file)
const rules = [
  { name: 'private selected/ticked/focused selection state', pattern: /\[\s*(?:selected|ticked|selectedLine|single|focusedKey)\s*,\s*\w+\s*\]\s*=\s*useState/, scope: selectionSurface, owner: 'src/renderer/src/lib/useSlideSelection.ts' },
  { name: 'private selection anchor (scroll anchoring excluded)', pattern: /(?:const|let)\s+anchorRef\s*=\s*useRef/, scope: file => selectionSurface(file) && !file.endsWith('/VirtualGrid.tsx'), owner: 'src/renderer/src/lib/useSlideSelection.ts' },
  { name: 'private placement scan or definition', pattern: /(?:let\s+sectionLevel\s*=|(?:function|type)\s+(?:caretPastePlace|caretSlidePlace|PastePlace|resolvePlace|settlePlace|insertionPoint|placeForLine|startOfTalkPlace)\s*[=(<])/, scope: () => true, owner: 'src/shared/slide-handling/place.ts' },
  { name: 'private slide-query parser/prefix table', pattern: /(?:const\s+(?:PREFIX_RE|TYPE_BY_PREFIX)\s*=|function\s+parseQuery\s*\()/, scope: file => file !== 'src/shared/talk-query.ts' && file !== 'src/shared/scratchpad.ts', owner: 'src/shared/slide-handling/query.ts' },
  { name: 'direct renderer thumbnail request', pattern: /(?:window\.tw\.talk\s*\.\s*thumbnails|\.\s*thumbnails\s*\()/, scope: file => file.startsWith('src/renderer/'), owner: 'src/renderer/src/lib/slideThumbnails.ts' },
  { name: 'private missing-thumbnail queue', pattern: /(?:createThumbRegenQueue\s*\(|(?:async\s+)?function\s+(?:runThumbRegenChain|drain)\s*\()/, scope: file => /(?:useThumbRegen|scratchpadSourceThumbs)\.ts$/.test(file), owner: 'src/renderer/src/lib/slideThumbnails.ts' }
]
function violationsFor(file, source) {
  return rules.filter(rule => file !== rule.owner && rule.scope(file) && rule.pattern.test(source)).map(rule => `${file}: ${rule.name}`)
}
const violations = [...files('src/renderer/src'), ...files('src/shared')].flatMap(file => violationsFor(file, read(file)))
assert.deepEqual(violations, [], `One slide-handling model; forbidden patterns:\n${violations.join('\n')}`)
let checks = rules.length
for (const file of ['src/renderer/src/components/slide-browser/useSelection.ts', 'src/renderer/src/components/SlidesOrganizer.tsx', 'src/renderer/src/components/SearchPalette.tsx']) {
  assert.match(read(file), /useSlideSelection/, `${file} uses shared selection`); checks++
}
// Existing projections may retain their old API names; their bodies delegate to the one parser.
assert.match(read('src/shared/scratchpad.ts'), /function parseQuery\(query: string\): ParsedQuery \{\s*const q = parseSlideQuery\(query, \{ operators: false, prefixes: true \}\)\s*return \{ types: q.types, from: q.from, terms: q.terms \}\s*\}/)
assert.match(read('src/renderer/src/components/slideBrowserModel.ts'), /function parseSearchQuery\(raw: string\): ParsedQuery \{\s*const \{ scope, exact, text, terms \} = parseSlideQuery/)
checks += 2
// Prove the tripwires detect representative regressions, including new slide-surface files.
for (const [file, source] of [
  ['src/renderer/src/components/slide-browser/AnotherPicker.tsx', 'const [selected, setSelected] = useState<Set<string>>(new Set())'],
  ['src/renderer/src/components/SlidesOrganizer.tsx', 'const anchorRef = useRef(0)'],
  ['src/shared/second-place.ts', 'export function insertionPoint(text) {}'],
  ['src/shared/second-query.ts', 'const PREFIX_RE = /slide:/'],
  ['src/renderer/src/components/SlideStrip.tsx', 'window.tw.talk\n .thumbnails(path, text)'],
  ['src/renderer/src/lib/scratchpadSourceThumbs.ts', 'async function drain() {}']
]) { assert(violationsFor(file, source).length > 0, `${file} regression detected`); checks++ }
assert(violationsFor('src/renderer/src/components/PathwaysView.tsx', 'const [selected, setSelected] = useState(new Set())').length > 0, 'Pathways now uses the same gate'); checks++
console.log(`${checks} single-model checks passed`)
