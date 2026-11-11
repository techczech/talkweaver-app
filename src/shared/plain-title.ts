/**
 * A talk title as plain text. Titles are authored in Markdown ("TalkWeaver **Embedded Page**"); every
 * place that shows one as a label (editor header, gallery, History, Talks list, dialogs) shows it
 * without the emphasis marks. Only paired delimiters around text are removed, so literal characters
 * survive ("A* search", "2 * 3 = 6", "file__name"), and a code span keeps its contents exactly
 * ("`*literal*`" shows as "*literal*"). The outline itself is never changed, and fields that edit the
 * title (Rename) start from the authored title, not this label.
 */
export function plainTalkTitle(raw: string | null | undefined): string {
  if (!raw) return ''
  const spans: string[] = []
  return raw
    .replace(/`([^`\n]+)`/g, (_, code: string) => `\u0000${spans.push(code) - 1}\u0000`)
    .replace(/(^|[^\\*])\*\*\*(?=\S)([^*\n]*?\S)\*\*\*(?!\*)/g, '$1$2')
    .replace(/(^|[^\\*])\*\*(?=\S)([^*\n]*?\S)\*\*(?!\*)/g, '$1$2')
    .replace(/(^|[^\w\\])__(?=\S)([^_\n]*?\S)__(?!\w)/g, '$1$2')
    .replace(/(^|[^\w\\*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w\\])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/\\([*_`])/g, '$1')
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => spans[Number(index)] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}
