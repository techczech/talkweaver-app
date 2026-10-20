// Extra slides of a Run (work-files ticket 25; journeys S9) as the Run page shows them. The slides are kept
// on the Run record (`extraSlides`, read and checked by run-extras.ts); this is the pure view of them: where
// each one goes in the Run's slides, and the words for it. No fs, no Electron.

/** A slide of the Run's slide set, as the "Place after" picker lists it. */
export interface RunSlideChoice { id: string; title: string }

export interface RunExtraSlideView {
  id: string
  title: string
  text: string
  /** The slide id it was placed after ('' for none). */
  after: string
  /** That slide's title, when the talk still has it. */
  afterTitle?: string
  /** 'after' when its slide is among the Run's slides; otherwise it goes at the end of them. */
  placed: 'after' | 'end'
}

/** What sessions:extra-slides (and each change) answers. */
export interface RunExtraSlidesState {
  /** The Run's slides (its pathway's, or the whole talk's), pre-work steps left out. */
  slides: RunSlideChoice[]
  extraSlides: RunExtraSlideView[]
  /**
   * The talk's outline compiles in the older format (compiler adapter `markdown-outline-v1`): extra slides cannot
   * be added or changed, and the ones the Run has are not shown when it is presented or in its handout.
   */
  legacyOutline?: true
}

/** A change refused because the talk's outline is in the older format (the app's own prompt says "Migrate"). */
export const EXTRA_SLIDES_NEED_NEW_FORMAT = 'Extra slides need the talk’s new outline format. Open the talk in TalkWeaver and choose Migrate when it asks.'
/** The Run page's line when the talk's outline is in the older format. */
export const EXTRA_SLIDES_NOT_SHOWN = 'This talk’s outline is in the older format, so extra slides are not shown when this run is presented or in its handout. Open the talk in TalkWeaver and choose Migrate when it asks.'

/** The compiler adapter of an outline in the older format (08-source-adapters.mjs adaptMarkdownOutline). */
export const LEGACY_OUTLINE_ADAPTER = 'markdown-outline-v1'

/** Each extra slide with its place: after its slide when that is one of the Run's slides, else at the end. */
export function extraSlideViews(
  extras: ReadonlyArray<{ id: string; title: string; text: string; after: string }>,
  runSlides: readonly RunSlideChoice[],
  talkSlides: readonly RunSlideChoice[],
): RunExtraSlideView[] {
  const inRun = new Set(runSlides.map((slide) => slide.id))
  const titles = new Map(talkSlides.map((slide) => [slide.id, slide.title]))
  return extras.map((extra) => {
    const afterTitle = extra.after ? titles.get(extra.after) : undefined
    return {
      id: extra.id, title: extra.title, text: extra.text, after: extra.after,
      ...(afterTitle !== undefined ? { afterTitle: afterTitle || extra.after } : {}),
      placed: extra.after && inRun.has(extra.after) ? 'after' : 'end',
    }
  })
}

/** The row's line: "Extra slide · after “Opening”", or at the end, saying why when its slide is not in the Run. */
export function extraSlidePlacement(view: RunExtraSlideView): string {
  if (view.placed === 'after') return `Extra slide · after “${view.afterTitle ?? view.after}”`
  if (!view.after) return 'Extra slide · at the end'
  if (view.afterTitle !== undefined) return `Extra slide · at the end: “${view.afterTitle}” is not in this run’s slides`
  return 'Extra slide · at the end: its slide is no longer in the talk'
}
