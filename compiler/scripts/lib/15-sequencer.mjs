// Pure sequencer: turns a heading tree (Node = { id, attrs, children, ... }) plus
// container-mode attrs into a flat beat list — the presentation's advance sequence.
// Consumes only { id, attrs, children } from a Node; produces Beat[].

// containerMode reads the four trigger flags in priority order; first match wins.
// contents accepts the bare flag (true) AND the {contents=strip} filmstrip variant value
// (ADR-0007) — both are the contents container; the variant only changes its rendering.
export function containerMode(node) {
  const attrs = node.attrs || {}
  if (attrs.carousel === true) return 'carousel'
  if (attrs['grid-linear'] === true) return 'grid-linear'
  if (attrs['grid-zoom'] === true) return 'grid-zoom'
  if (attrs.contents === true || attrs.contents === 'strip') return 'contents'
  return 'linear'
}

// The contents rendering variant (ADR-0007): {contents=strip} → 'strip' (filmstrip footer),
// otherwise the default thin rail. Rides the child beats' context so the runtime paints without
// re-reading node attrs. Only meaningful when containerMode(node) === 'contents'.
export function contentsVariant(node) {
  return (node.attrs || {}).contents === 'strip' ? 'strip' : undefined
}

// root is a bare wrapper (not a real heading/slide) — it never emits a beat of
// its own; only its children enter the sequence.
export function sequence(root, { warn } = {}) {
  const beats = []
  for (const child of root.children || []) emitNode(child, warn, beats, undefined)
  return beats
}

// context, if given, decorates the beat this node emits for *itself* (its own
// slide/grid beat) — used when a parent carousel/contents container places this
// node as one of its indexed children.
function emitNode(node, warn, beats, context) {
  // ADR-0022 folds authored carousel children into one parent DOM slide before sequencing.
  // Their preserved sequence-only identities still emit addressable child beats.
  const children = (node.children || []).length
    ? node.children
    : (Array.isArray(node._sequenceCarouselChildren) ? node._sequenceCarouselChildren : [])
  const own = (kind) => ({ kind, slideId: node.id, ...(context ? { context } : {}) })

  // Leaf node → one slide beat.
  if (children.length === 0) {
    beats.push(own('slide'))
    return
  }

  let mode = containerMode(node)

  // carousel with any non-leaf child → warn, treat as linear.
  if (mode === 'carousel' && children.some((c) => (c.children || []).length > 0)) {
    if (warn) warn(`carousel-on-sections:${node.id}`)
    mode = 'linear'
  }

  if (mode === 'grid-linear') {
    beats.push(own('grid'))
    for (const child of children) emitNode(child, warn, beats, undefined)
    return
  }

  if (mode === 'grid-zoom') {
    beats.push(own('grid'))
    const completed = []
    for (const child of children) {
      emitNode(child, warn, beats, undefined)
      completed.push(child.id)
      beats.push({ kind: 'grid-return', slideId: node.id, context: { completed: [...completed] } })
    }
    return
  }

  // Folded heading-authored carousel: each child is one beat, but all beats render through the
  // parent's single DOM slide. Omitting a separate parent beat prevents child 0 being displayed
  // twice (once as the parent reveal and again as its own beat). The canonical authored child id
  // remains beat.slideId; context.sectionId is the folded DOM render target.
  if (mode === 'carousel' && Array.isArray(node._sequenceCarouselChildren)) {
    const count = children.length
    children.forEach((child, index) => {
      beats.push({
        kind: 'slide',
        slideId: child.id,
        context: { container: 'carousel', sectionId: node.id, index, count }
      })
    })
    return
  }

  // linear / contents / carousel: own slide beat first, then children in order
  // (carousel/contents children carry index/count context; carousel children
  // are guaranteed leaves, contents children may recurse further).
  beats.push(own('slide'))
  const count = children.length
  const variant = mode === 'contents' ? contentsVariant(node) : undefined
  children.forEach((child, index) => {
    if (mode === 'carousel' || mode === 'contents') {
      emitNode(child, warn, beats, {
        container: mode,
        sectionId: node.id,
        index,
        count,
        ...(variant ? { variant } : {})
      })
    } else {
      emitNode(child, warn, beats, undefined)
    }
  })
}
