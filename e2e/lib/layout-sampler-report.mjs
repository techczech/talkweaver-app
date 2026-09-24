export function reportRowsAfterSeparator(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/)
  const separatorIndex = lines.findIndex((line) =>
    /^\s*\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|\s*$/.test(line)
  )
  if (separatorIndex < 0) throw new Error('unverified report table separator row is missing')

  const rows = []
  for (const line of lines.slice(separatorIndex + 1)) {
    if (!line.trim()) break
    const firstCell = line.match(/^\s*\|\s*(.*?)\s*\|/)
    if (!firstCell) break
    rows.push(firstCell[1].trim())
  }
  return rows
}
