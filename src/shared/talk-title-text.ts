// A talk's title as plain text, for every place it is shown as text (the Talks list, the window title,
// a work file's Used-by list). A title may carry inline Markdown (`**Bold** start`); the compiler's
// plainInlineText is the one function that drops it, so nothing here re-derives the rules.
import { plainInlineText } from '../../compiler/scripts/lib/00-inline-render.mjs'

export function talkTitleText(title: string): string {
  return plainInlineText(title)
}

/** The Edit window's title: "TalkWeaver Edit — Title", or "TalkWeaver" when no talk is open. */
export function editWindowTitle(title: string | null | undefined): string {
  return title ? `TalkWeaver Edit — ${talkTitleText(title)}` : 'TalkWeaver'
}
