const TYPE_FLOOR_PX = 31
const MAX_WRAPPED_LINES_AT_FLOOR = 14
// The 1180px code panel has about 1,120px of inner width. At the 31px floor a
// monospace glyph occupies approximately 0.6em, giving a conservative 60ch measure.
const CHARACTERS_PER_LINE_AT_FLOOR = 60

export function codeLayoutForBlock(block) {
  const lines = String(block?.text ?? '').split(/\r?\n/)
  const maxLineChars = lines.reduce((maximum, line) => Math.max(maximum, line.length), 0)
  const wrappedLines = lines.reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / CHARACTERS_PER_LINE_AT_FLOOR)),
    0
  )
  return {
    lines: lines.length,
    wrappedLines,
    maxLineChars,
    charactersPerLineAtFloor: CHARACTERS_PER_LINE_AT_FLOOR,
    tooLongAtFloor: wrappedLines > MAX_WRAPPED_LINES_AT_FLOOR,
    typeFloorPx: TYPE_FLOOR_PX
  }
}

export function annotateCodeLayout(blocks, layout, slideId, warn) {
  if (layout !== 'code') return
  for (const block of blocks || []) {
    if (block?.type !== 'code') continue
    block.codeLayout = codeLayoutForBlock(block)
    if (block.codeLayout.tooLongAtFloor) warn(`code-too-long:${slideId}`)
  }
}
