import { JSDOM } from 'jsdom'
import { parseOutlineTree } from '../../compiler/scripts/lib/14-outline-tree.mjs'
import { nodeContentLinesAndAttrs } from '../../compiler/scripts/lib/authored-layout.mjs'
import { blankHtmlCommentsKeepingCaptureMarkers } from '../../compiler/scripts/lib/live-page-capture-markup.mjs'
import {
  OPEN_PATTERN_TOKENS, TITLE_REGIME_BY_LAYOUT, TRIGGER_DICTIONARY, VALUE_TRIGGER_DICTIONARY,
} from '../../compiler/scripts/lib/trigger-dictionary.generated.mjs'

const knownKeys = new Set([
  ...Object.values(TRIGGER_DICTIONARY).map(({ key }) => key),
  ...Object.keys(VALUE_TRIGGER_DICTIONARY),
  ...OPEN_PATTERN_TOKENS.map(({ key }) => key),
  'titleDisplay',
])

function authoredTokens(sourceMarkdown) {
  const [node] = parseOutlineTree(blankHtmlCommentsKeepingCaptureMarkers(sourceMarkdown)).root.children
  if (!node) return []
  const attrs = { ...node.attrs }
  nodeContentLinesAndAttrs(node, attrs)

  // The parser also accepts unknown keys and free-form values. Only vocabulary from the
  // compiler registry may appear in the report.
  return Object.keys(attrs).filter(key => knownKeys.has(key)).sort().map(key => {
    const name = key === 'titleDisplay' ? 'title' : key
    const value = attrs[key]
    if (value === true) return `{${name}}`
    const allowedValues = Object.hasOwn(VALUE_TRIGGER_DICTIONARY, name) ? VALUE_TRIGGER_DICTIONARY[name] : []
    return `{${name}=${allowedValues.includes(value) ? value : '…'}}`
  })
}

export function sectionSignature({ html, sourceMarkdown }) {
  // Inert fragment parsing counts real elements and class memberships without loading any
  // embedded resource or retaining text, HTML attributes, or class names in the signature.
  const fragment = JSDOM.fragment(html)
  const elements = [...fragment.querySelectorAll('*')]
  const layout = fragment.firstElementChild?.getAttribute('data-layout')
  return {
    layout: Object.hasOwn(TITLE_REGIME_BY_LAYOUT, layout) ? layout : 'unregistered',
    tokens: authoredTokens(sourceMarkdown),
    elements: elements.length,
    classes: elements.reduce((count, element) => count + element.classList.length, 0),
  }
}
