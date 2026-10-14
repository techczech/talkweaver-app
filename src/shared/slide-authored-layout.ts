// Which registry layout a slide is DRAWN in, named from the compiler's own final layout
// (plain-view-compiler-facts.ts `slideLayouts` `final`: authored-layout.mjs finalSlideLayout, the
// functions the compiler runs). `drawnLayoutOf` is the ONE reading used by the Plain view's margin
// label, its layout menu and the verbs behind that menu (layout-verbs.ts chooseLayout /
// clearLayout). Pure.
//
// The registry only NAMES what the compiler decided: the entry that declares the deciding token
// (`{barchart}` is Bar chart, not the generic Chart), else the entry of the layout.
//
// `authoredLayoutOf` names what the slide's TOKENS write, before the content is read. It is not
// what the slide gets, and it is used for two questions about tokens only: is a registry entry a
// layout a slide can be given by writing its trigger (isSettableLayout), and does a slide already
// write the token an entry would write (layout-verbs.ts; the result is still checked as drawn).
import { LAYOUTS, type LayoutDef } from './layout-registry/entries.ts'
import { layoutEntryFor } from './layout-registry/options.ts'
import { layoutEntryAcceptsTriggerToken } from './layout-registry/vocabulary.ts'
import { compilerFacts, type SlideLayoutFacts } from './plain-view-compiler-facts.ts'

const isListStyle = (entry: LayoutDef): boolean => entry.resolvesTo?.key === 'liststyle'

/**
 * The layout the compiler draws the slide in, for a slide that writes a layout: null when it writes
 * none (Auto) or is no slide of its own (a layout above it takes it as a card, a column or a half).
 * A list style ({iconlist}, {numbered}, {logolist}, {plainlist}) names the slide when the slide
 * writes it itself, is drawn as a list, holds one, and its lists are drawn in that style (under a
 * talk-wide `triggers: iconlist` a slide that writes {list} is a List); a paragraph under {iconlist}
 * is a Statement and is named so. Every other slide is named by the layout it is drawn in: a slide
 * of charts only is a Chart whatever its tokens say.
 */
export function drawnLayoutOf(slide: SlideLayoutFacts): { entry: LayoutDef | null; name: string } | null {
  if (!slide.authored || !slide.final) return null
  const { layout, listStyle, hasList } = slide.final
  const { winner } = slide
  if (layout === 'list' && hasList && listStyle && slide.listStyle === listStyle) {
    const entry = (winner && LAYOUTS.find((candidate) => isListStyle(candidate) && String(candidate.resolvesTo?.value) === listStyle && layoutEntryAcceptsTriggerToken(candidate, winner.raw)))
      ?? LAYOUTS.find((candidate) => isListStyle(candidate) && String(candidate.resolvesTo?.value) === listStyle)
    if (entry) return { entry, name: entry.name }
  }
  const declared = winner
    ? LAYOUTS.find((candidate) => !isListStyle(candidate) && layoutEntryAcceptsTriggerToken(candidate, winner.raw))
    : undefined
  const entry = declared && layoutDecisionOfEntry(declared)?.layout === layout ? declared : layoutEntryFor(layout) ?? null
  return { entry, name: entry?.name ?? layout }
}

/** Whether the compiler draws the slide in the entry's layout: for a list style, as a list it holds, in that style. */
export function isDrawnAs(slide: SlideLayoutFacts, entry: LayoutDef): boolean {
  const final = slide.final
  if (!final) return false
  if (isListStyle(entry)) return final.layout === 'list' && final.hasList && final.listStyle === String(entry.resolvesTo?.value)
  const wanted = layoutDecisionOfEntry(entry)
  return wanted !== null && final.layout === wanted.layout
}

/** A list style chosen for a slide whose content holds no list: the content cannot take it. */
export function listStyleWithoutList(slide: SlideLayoutFacts, entry: LayoutDef): boolean {
  return isListStyle(entry) && slide.final !== null && !slide.final.hasList
}

/**
 * The layout the slide's TOKENS write (see the note at the top: not what the slide is drawn in):
 * null when it writes none. A list style ({iconlist},
 * {numbered}, {logolist}, {plainlist}) is what a person picks as a layout for a list, so it names
 * the slide when the compiler's decision is a list or is left to the content; on any other
 * decided layout ({cards}{numbered}) the compiler draws that layout and it is the name.
 * `entry` is null for a decision the registry has no entry for; `name` is then the compiler's word.
 */
export function authoredLayoutOf(slide: SlideLayoutFacts): { entry: LayoutDef | null; name: string } | null {
  if (!slide.authored) return null
  const { decision, winner } = slide
  if (slide.listStyle && (!decision || decision.layout === 'list')) {
    const entry = (winner && LAYOUTS.find((candidate) => isListStyle(candidate) && layoutEntryAcceptsTriggerToken(candidate, winner.raw)))
      ?? LAYOUTS.find((candidate) => isListStyle(candidate) && String(candidate.resolvesTo?.value) === slide.listStyle)
    if (entry) return { entry, name: entry.name }
  }
  if (!decision) return null
  const declared = winner
    ? LAYOUTS.find((candidate) => !isListStyle(candidate) && layoutEntryAcceptsTriggerToken(candidate, winner.raw))
    : undefined
  // The declaring entry names the slide only when it is that layout (an option token of another
  // layout never renames it): its own name, or the layout its trigger resolves to.
  const fits = (entry: LayoutDef | undefined): entry is LayoutDef => Boolean(entry) && layoutDecisionOfEntry(entry!)?.layout === decision.layout
  const entry = fits(declared) ? declared : layoutEntryFor(decision.layout) ?? null
  return { entry, name: entry?.name ?? decision.layout }
}

/** The label of the layout a slide that writes a layout is drawn in, or null (see drawnLayoutOf). */
export function drawnLayoutLabel(slide: SlideLayoutFacts): string | null {
  const drawn = drawnLayoutOf(slide)
  return drawn ? drawn.entry?.label ?? drawn.name : null
}

/** The tokens inside an entry's trigger (`{contrast=cards}` → `contrast=cards`), as one group body. */
export function entryTriggerBody(entry: LayoutDef): string {
  return [...entry.trigger.matchAll(/\{([^}]*)\}/g)].map((group) => group[1].trim()).filter(Boolean).join(' ')
}

const entryDecisions = new Map<string, { layout: string; by: string } | null>()
/** What the compiler decides for a slide that writes this entry's trigger and nothing else. */
export function layoutDecisionOfEntry(entry: LayoutDef): { layout: string; by: string } | null {
  if (entryDecisions.has(entry.name)) return entryDecisions.get(entry.name) ?? null
  const body = entryTriggerBody(entry)
  const slide = body ? compilerFacts(`## S\n\n### A\n{${body}}\n`).slideLayouts.get(2) : undefined
  const decision = slide?.decision ?? null
  entryDecisions.set(entry.name, decision)
  return decision
}

const attrsJson = (attrs: Record<string, unknown>): string => JSON.stringify(Object.keys(attrs).sort().map((key) => [key, attrs[key]]))
const entryAttrs = new Map<string, string>()

/** Whether a slide's tokens `written` mean exactly what the entry's own trigger means to the compiler (an alias of it, not a variant). */
export function writesEntryTrigger(entry: LayoutDef, written: ReadonlyArray<{ attrs: Record<string, unknown> }>): boolean {
  let own = entryAttrs.get(entry.name)
  if (own === undefined) {
    const slide = compilerFacts(`## S\n\n### A\n{${entryTriggerBody(entry)}}\n`).slideLayouts.get(2)
    own = attrsJson(Object.assign({}, ...(slide?.tokens ?? []).map((token) => token.attrs)))
    entryAttrs.set(entry.name, own)
  }
  return attrsJson(Object.assign({}, ...written.map((token) => token.attrs))) === own
}

const settable = new Map<string, boolean>()
/**
 * Whether the entry is a layout a slide can be given by writing its trigger: the compiler reads
 * the trigger as a layout (or a list style) and that reading is named back as this entry. False
 * for modifiers ({reveal}), containers, components and an entry that shares another's trigger.
 */
export function isSettableLayout(entry: LayoutDef): boolean {
  let known = settable.get(entry.name)
  if (known === undefined) {
    const body = entryTriggerBody(entry)
    const slide = body ? compilerFacts(`## S\n\n### A\n{${body}}\n`).slideLayouts.get(2) : undefined
    known = Boolean(slide && authoredLayoutOf(slide)?.entry === entry)
    settable.set(entry.name, known)
  }
  return known
}
