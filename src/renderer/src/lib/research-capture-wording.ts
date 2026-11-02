// What the "Capture to research…" sheet and its notice say. Pure, so the wording is testable and the sheet
// only lays it out. Errors come from the main process already in plain words (research-capture.ts).

export const RESEARCH_KINDS: readonly { value: string; label: string }[] = [
  { value: 'evidence', label: 'Evidence' },
  { value: 'table', label: 'Table' },
  { value: 'visualisation', label: 'Visualisation' },
  { value: 'snippet', label: 'Snippet' },
  { value: 'search', label: 'Search' },
  { value: 'widget', label: 'Widget' }
]

/** The last part of the path scout reported, for the notice ("2026-10-20-hebb.md"). */
export function capturedFileName(file: string): string {
  return file.split(/[\\/]/).filter(Boolean).pop() ?? file
}

export function capturedNotice(file: string, indexed: boolean): string {
  const name = capturedFileName(file)
  return indexed ? `Filed ${name} in the research folder.` : `Filed ${name} in the research folder. It is not in a search index yet.`
}
