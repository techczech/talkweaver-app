/** Pure outline edits used by registered editor commands. Offsets are CodeMirror document offsets. */
export function toggleList(
  text: string,
  from: number,
  to: number,
  kind: 'bullet' | 'numbered'
): { text: string; from: number; to: number } {
  const start = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1
  const last = to > from && text[to - 1] === '\n' ? to - 1 : to
  const endIndex = text.indexOf('\n', last)
  const end = endIndex < 0 ? text.length : endIndex
  const lines = text.slice(start, end).split('\n')
  const bullet = /^\s*- /u
  const numbered = /^\s*\d+\. /u
  const allTarget = lines.every((line) => kind === 'bullet' ? bullet.test(line) : numbered.test(line))
  const changed = lines.map((line, index) => {
    const indent = line.match(/^\s*/u)?.[0] ?? ''
    const bare = line.slice(indent.length).replace(/^(?:- |\d+\. )/u, '')
    return indent + (allTarget ? '' : kind === 'bullet' ? '- ' : `${index + 1}. `) + bare
  }).join('\n')
  return { text: text.slice(0, start) + changed + text.slice(end), from: start, to: end }
}

export function insertNewSlide(text: string, cursor: number): { text: string; cursor: number; at: number; insert: string } {
  const headings = [...text.matchAll(/^(#{1,6})[ \t]+[^\n]*(?:\n|$)/gmu)]
  const current = headings.filter((match) => (match.index ?? 0) <= cursor).at(-1)
  const level = current?.[1].length ?? 2
  const next = headings.find((match) => (match.index ?? 0) > (current?.index ?? -1) && match[1].length <= level)
  const at = next?.index ?? text.length
  const before = text.slice(0, at)
  const insertion = `${before && !before.endsWith('\n') ? '\n' : ''}${'#'.repeat(level)} \n`
  return { text: before + insertion + text.slice(at), cursor: at + insertion.length - 1, at, insert: insertion }
}
