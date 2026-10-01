// The answer to one own-slide picture request (`layout:variant-thumbnail`, ADR-0032 §6), shared by
// main (which produces it) and the renderer (the picker and the Inspector's option pictures).

/**
 * - `ok`: the picture.
 * - `cannot-take`: the layout cannot take this slide's content (grey it, show its reason).
 * - `invalid`: the request itself is wrong (unknown layout or option, a token outside the registry's
 *   grammar, a slide not in this text, an outline outside the vault). Do not ask again.
 * - `failed`: the compile or render produced no picture. Worth another try later.
 * - `superseded`: dropped from the queue before its turn by a newer request. Ask again if still wanted.
 */
export type VariantThumbnail =
  | { status: 'ok'; slideId: string; url: string; cached: boolean }
  | { status: 'cannot-take'; slideId: string; reason: string }
  | { status: 'invalid'; slideId: string; reason: string }
  | { status: 'failed'; slideId: string }
  | { status: 'superseded'; slideId: string }

/** What a picture surface does with an answer (null = the IPC call itself failed). */
export type VariantPictureAction =
  | { kind: 'picture'; url: string }
  | { kind: 'grey'; reason: string }
  | { kind: 'sample' }
  | { kind: 'retry' }
  | { kind: 'ask-again' }

export function variantPictureAction(result: VariantThumbnail | null | undefined): VariantPictureAction {
  if (!result) return { kind: 'retry' }
  switch (result.status) {
    case 'ok': return { kind: 'picture', url: result.url }
    case 'cannot-take': return { kind: 'grey', reason: result.reason }
    case 'invalid': return { kind: 'sample' }
    case 'superseded': return { kind: 'ask-again' }
    default: return { kind: 'retry' }
  }
}
