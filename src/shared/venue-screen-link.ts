/** Read the canonical published handout URL and append the stable venue path. */
export function venueScreenLinkFromOutline(outline: string): string | null {
  const frontmatter = outline.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const raw = frontmatter?.[1].match(/^\s*handout_url\s*:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, '')
  if (!raw) return null
  return venueScreenLinkFromUrl(raw)
}

export function venueScreenLinkFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!/^https?:$/.test(url.protocol)) return null
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '') + '/p' + (raw.endsWith('/') ? '/' : '')
    return url.toString()
  } catch { return null }
}
