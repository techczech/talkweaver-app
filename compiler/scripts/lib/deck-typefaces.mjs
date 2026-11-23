// Keep single-file decks portable without charging every export for all three choices.
const bundledFamilies = new Set(['Inter', 'Geist', 'Fraunces', 'Alegreya Sans'])
export function selectBundledTypefaces(template, face, extended = true) {
  const selected = new Set(face === 'serif' ? ['Fraunces', 'Alegreya Sans'] : face === 'inter' ? ['Inter'] : face === 'geist' ? ['Geist'] : [])
  return template.replace(/@font-face\s*\{[^}]*\}/g, block => {
    const family = block.match(/font-family:\s*['"]([^'"]+)['"]/)?.[1]
    if (bundledFamilies.has(family) && (!selected.has(family) || (!extended && block.includes('unicode-range: U+0100')))) return '';
    return block
  })
}
