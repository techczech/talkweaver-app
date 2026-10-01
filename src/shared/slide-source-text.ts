// A slide's source text as their page shows it (share for comments): the outline as the compiler's
// tree parse reads it, and each slide's visible text read off that tree. One module for both readers:
// the share push (main/shared-talk-build.ts, which keeps it per revision) and Accept's changed-since
// check (shared/feedback-accept.ts), so the two always compare like with like.
//
// Pure, no I/O. The comment blanking is passed in by callers that load the compiler at run time
// (main); the default is the compiler's own rule (compiler/scripts/lib/html-comments.mjs): every
// closed `<!-- … -->` blanked, newlines kept, an unclosed `<!--` left as it is.

export interface SourceTextNode { headingLine: string; triggerLine: string; contentLines: string[] }

export function blankClosedHtmlComments(text: string): string {
  return String(text ?? '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''))
}

/** The outline's body exactly as adaptMarkdownOutlineV2 hands it to the tree parse: frontmatter
 *  blanked to its newlines, comments blanked, every line where it was. `fmEnd`: where the
 *  frontmatter ends in `text`; `newlines`: how many newlines it holds. */
export function outlineCompilerBody(text: string, blankComments: (text: string) => string = blankClosedHtmlComments): { body: string; fmEnd: number; newlines: number } {
  const src = String(text ?? '')
  let fmEnd = 0
  if (src.startsWith('---')) {
    const end = src.indexOf('\n---', 3)
    if (end >= 0) fmEnd = end + 4
  }
  const head = src.slice(0, fmEnd).replace(/[^\n]/g, '')
  return { body: blankComments(head + src.slice(fmEnd)), fmEnd, newlines: head.length }
}

/** A slide's visible text: its heading, its Trigger line and its content lines (never notes),
 *  trailing space dropped, runs of blank lines as one, no trailing blank lines. */
export function slideVisibleText(node: SourceTextNode): string {
  const lines = [node.headingLine, ...(node.triggerLine ? [node.triggerLine] : []), ...node.contentLines]
  return lines.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd()
}
