// Main ↔ editor-window messages for routing a main-process outline insertion through the open editor
// buffer instead of the file (live-presenting ticket 07, "Add to talk"). `read` returns the buffer;
// `apply` replaces it with `next` only while it is still exactly `base`. Every main-process write of
// an open talk now takes this route (talk-writer.ts); `origin` names the writer, so the window's
// refusal can say what was not applied. `moved` on a refusal: the buffer was no longer `base`
// (nothing applied; main may work the change out again against a fresh read).
export type EditorDocumentRequestBody =
  | { kind: 'read'; outlinePath: string }
  | { kind: 'apply'; outlinePath: string; base: string; next: string; origin?: string }
export type EditorDocumentRequest = EditorDocumentRequestBody & { requestId: string }
// `text` on an ok reply: for `read`, the buffer; for `apply`, the exact text the editor's save wrote
// (`next` with any ids the save stamped), so main never has to read the file back.
export type EditorDocumentReply = { ok: true; text?: string } | { ok: false; error: string; moved?: boolean }

/** The origin of "Add to talk" (instant-slide-insert.ts), whose refusals keep their own words. */
export const INSTANT_SLIDE_ORIGIN = 'instant-slide'

/** What a writer's change is called in a refusal ("…while applying the tags"). */
export function changeNoun(origin: string | undefined): string {
  switch (origin) {
    case 'tags': return 'the tags'
    case 'frontmatter': return 'the metadata'
    case 'ledger-detach': return 'the detached slide'
    case 'ledger-adopt': return 'the adopted version'
    case 'ledger-merge': return 'the merged slides'
    case 'publish-handout': return 'the handout link'
    case 'publish-flush': return 'the talk for publishing'
    case 'optimize-images': return 'the optimised images'
    case 'retitle': return 'the new title'
    case 'strip-published': return 'the publishing details removal'
    case 'share-for-comments': return 'the share link'
    case 'conflict-merge': return 'the merged conflict copy'
    case 'create-talk': return 'the new talk'
    case INSTANT_SLIDE_ORIGIN: return 'the slide'
    default: return 'the change'
  }
}
