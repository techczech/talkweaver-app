// The Inspector's options pane as tabs (Dominik's preview.11 check, 29 Sep): scroll targeting and
// scroll preservation, as pure functions. The running-app half is e2e/diagnose-inspector-tabs.mjs.
import { strict as assert } from 'node:assert'

const scroll = await import('../src/renderer/src/components/inspectorScroll.ts').catch(() => null)
assert.ok(scroll, 'the Inspector has a scroll model for its options pane (inspectorScroll.ts)')
const { PaneMemory, paneAnchorAt, paneScrollTarget, scrollTopForAnchor, tabJumpScrollTop, tabTrailingSpace } = scroll

// A pane 400px tall holding five sections; the last (Poll) is short: 120px from its top to the end
// of the content, the pane's bottom padding included.
const PANE = 400
const SECTIONS = [
  { key: 'section:statement', top: 0 },
  { key: 'group:statement-variant', top: 30 },
  { key: 'section:title', top: 300 },
  { key: 'group:title-placement', top: 330 },
  { key: 'group:title-display', top: 420 },
  { key: 'section:slide', top: 560 },
  { key: 'group:background', top: 590 },
  { key: 'section:steps', top: 800 },
  { key: 'section:poll', top: 900 }
]
const CONTENT_END = 1020

// ── Targeting: every heading can reach the top ────────────────────────────────────────────────
const tail = tabTrailingSpace(PANE, 900, CONTENT_END)
assert.equal(tail, 280, 'the trailing space lets the last heading reach the top of the pane')
const maxScroll = CONTENT_END + tail - PANE
for (const section of SECTIONS.filter((node) => node.key.startsWith('section:'))) {
  assert.equal(tabJumpScrollTop(section.top, maxScroll), section.top, `${section.key} jumps to its own top`)
}
assert.equal(tabJumpScrollTop(900, CONTENT_END - PANE), 620, 'without the trailing space the last heading could not reach the top (the old bug)')
assert.equal(tabTrailingSpace(PANE, 100, 2000), 0, 'a long last section needs no trailing space')
assert.equal(tabTrailingSpace(PANE, 900.2, 1020), 281, 'the trailing space rounds up so the heading is never a pixel short')
assert.equal(tabJumpScrollTop(-4, 500), 0, 'a jump never goes above the top')

// ── Anchors ───────────────────────────────────────────────────────────────────────────────────
assert.deepEqual(paneAnchorAt(SECTIONS, 300), { key: 'section:title', top: 300, offset: 0, scrollTop: 300 },
  'a pane at a section heading anchors on that section')
assert.deepEqual(paneAnchorAt(SECTIONS, 340), { key: 'group:title-placement', top: 330, offset: 10, scrollTop: 340 },
  'a pane inside a section anchors on the option group it has reached')
assert.equal(paneAnchorAt(SECTIONS, 299.6).key, 'section:title', 'a sub-pixel short scroll still counts as the heading')
assert.equal(paneAnchorAt([{ key: 'section:a', top: 12 }], 4).key, null, 'above every node there is no node anchor')
const grown = SECTIONS.map((node) => node.top >= 330 && node.key !== 'section:title' ? { ...node, top: node.top + 90 } : node)
assert.equal(scrollTopForAnchor(paneAnchorAt(SECTIONS, 600), grown), 690, 'content growing above the anchor moves the pane with it')
assert.equal(scrollTopForAnchor({ key: 'group:gone', top: 50, offset: 5, scrollTop: 222 }, SECTIONS), 222, 'a vanished anchor keeps the old position')

// ── Preservation after a render ───────────────────────────────────────────────────────────────
{
  const memory = new PaneMemory()
  assert.equal(paneScrollTarget(memory, 'slideA', null, SECTIONS, 0, 600), 0, 'a slide not seen before opens at the top')
  memory.remember('slideA', paneAnchorAt(SECTIONS, 340))
  assert.equal(paneScrollTarget(memory, 'slideA', 'slideA', SECTIONS, 340, 600), 340, 'a render that moved nothing leaves the pane alone')
  assert.equal(paneScrollTarget(memory, 'slideA', 'slideA', SECTIONS, 380, 600), 380,
    "the user's own scrolling between the event and the render is never pulled back")
  // An option in the Statement section above removes a 90px group: every node below moves up.
  const shrunk = SECTIONS.map((node) => node.top >= 300 ? { ...node, top: node.top - 90 } : node)
  assert.equal(paneScrollTarget(memory, 'slideA', 'slideA', shrunk, 340, 600), 250,
    'content shrinking above the anchor keeps the anchored group where it was on screen')
  // An option cut the content below: the browser pulled the pane back to its new end.
  memory.remember('slideA', paneAnchorAt(SECTIONS, 900))
  assert.equal(paneScrollTarget(memory, 'slideA', 'slideA', SECTIONS, 700, 700), 900,
    'a pane the render cut short goes back to its anchor')
  assert.equal(paneScrollTarget(memory, 'slideA', 'slideA', SECTIONS, 700, 1200), 700,
    'scrolling up from the anchor is not mistaken for a cut-short pane')
  // Another slide, then back: each keeps its own place.
  assert.equal(paneScrollTarget(memory, 'slideB', 'slideA', SECTIONS, 900, 1200), 0, 'the next slide opens at its own place (the top)')
  memory.remember('slideB', paneAnchorAt(SECTIONS, 560))
  assert.equal(paneScrollTarget(memory, 'slideA', 'slideB', SECTIONS, 560, 1200), 900, 'back on the first slide, its own place returns')
  assert.equal(paneScrollTarget(memory, 'slideB', 'slideA', shrunk, 900, 1200), 470, "a slide's place follows its anchor when its content changed")
}
{
  const memory = new PaneMemory(2)
  memory.remember('a', paneAnchorAt(SECTIONS, 300))
  memory.remember('b', paneAnchorAt(SECTIONS, 560))
  memory.remember('c', paneAnchorAt(SECTIONS, 800))
  assert.equal(memory.get('a'), undefined, 'the memory is bounded: the oldest slide is forgotten')
  assert.equal(memory.scrollTopFor('c', SECTIONS), 800, 'the newest slide is kept')
}

console.log('test:inspector-scroll OK')
