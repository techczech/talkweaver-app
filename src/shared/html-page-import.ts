// Insert › HTML page… (src/main/html-page-import.ts): the answers of talk:choose-html-page and
// talk:import-html-page, shared by main, preload and the renderer's insert step.

export type HtmlPageRefusalReason =
  | 'not-html' | 'missing' | 'too-large' | 'no-talk' | 'talk-changed' | 'vault-unavailable' | 'outside-vault' | 'expired' | 'write-failed' | 'unsupported'

export type HtmlPageRefusal = { ok: false; reason: HtmlPageRefusalReason; message: string }

/** talk:choose-html-page: null when the picker was cancelled. Nothing is written by choosing. */
export type HtmlPageChoice = { ok: true; token: string; fileName: string } | HtmlPageRefusal

export type HtmlPageImport = {
  ok: true
  /** What the `[Embed: …]` line carries, relative to the talk's folder, '/'-separated. */
  embedPath: string
  /** 'copied': a new file in assets; 'reused': the same bytes were already there; 'in-talk': the chosen file is inside the talk's folder already. */
  how: 'copied' | 'reused' | 'in-talk'
  /** Local files the page refers to (script, stylesheet, picture…), which a sealed embed cannot load. At most 5. */
  localReferences: string[]
} | HtmlPageRefusal
