// One stamp for the system-managed frontmatter links (Metadata Registry, ADR-0036): set a top-level
// `key: value` line, replacing an existing one or adding it at the end of the frontmatter, or
// remove it (`null`). The value is written bare, as these links always have been. No frontmatter:
// the text is returned unchanged (a stamp never invents one). Idempotent, so it is safe to apply
// again to a buffer that already carries the stamp (WorkspaceLayout publish).
export function stampFrontmatterValue(outlineText: string, key: string, value: string | null): string {
  const fm = outlineText.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return outlineText
  const lines = fm[1].split(/\r?\n/)
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
  const idx = lines.findIndex((l) => pattern.test(l))
  if (value === null) {
    if (idx < 0) return outlineText
    lines.splice(idx, 1)
  } else if (idx >= 0) {
    if (lines[idx] === `${key}: ${value}`) return outlineText
    lines[idx] = `${key}: ${value}`
  } else lines.push(`${key}: ${value}`)
  return outlineText.slice(0, fm.index!) + `---\n${lines.join('\n')}\n---` + outlineText.slice(fm.index! + fm[0].length)
}

/** The published handout's link (`handout_url:`). */
export function stampHandoutUrl(outlineText: string, url: string): string {
  return stampFrontmatterValue(outlineText, 'handout_url', url)
}

/** Share for comments (ticket 03): `share_url:`, the link colleagues comment at; `null` removes it
 *  (Stop sharing). */
export function stampShareUrl(outlineText: string, url: string | null): string {
  return stampFrontmatterValue(outlineText, 'share_url', url)
}
