import { parseHeadingAttrs } from '../../compiler/scripts/lib/02-triggers-layout.mjs'
import type { LayoutDoctorFinding } from './layout-doctor.ts'
import { layoutDisplayName } from './layout-registry/options.ts'
import { LayoutVerbError, removeCompetingLayoutTags } from './layout-verbs.ts'
import { normalizePositions } from './outline-normalize.ts'
import { outlineSaveChange } from './outline-save-changes.ts'
import { compilerFactsOf, type SlideLayoutFacts, type SlideToken } from './plain-view-compiler-facts.ts'

// The compiler merges explicit layout tags into one last-wins key. Other attributes can imply
// a layout and still be read independently, e.g. cards=rows, cols=2 and numbered.
function shadowedLayoutTags(slide: SlideLayoutFacts): SlideToken[] {
  const winner = slide.decision
  if (!slide.consistent || winner?.by !== 'layout' || !slide.tokens.some(token => token.attrs.layout === winner.layout)) return []
  return slide.tokens.filter(token =>
    typeof token.attrs.layout === 'string' && token.attrs.layout !== winner.layout && Object.keys(token.attrs).length === 1
  )
}

export function competingLayoutFindings(text: string): LayoutDoctorFinding[] {
  let facts
  try { facts = compilerFactsOf(text) } catch { return [] }
  const findings: LayoutDoctorFinding[] = []
  for (const slide of facts.slideLayouts.values()) {
    const ignored = [...new Set(shadowedLayoutTags(slide).map(token => layoutDisplayName(String(token.attrs.layout))))]
    if (!ignored.length) continue
    const chosen = slide.decision?.layout
    const drawn = slide.final
      ? `Drawn as ${layoutDisplayName(slide.final.layout)}.`
      : 'Drawn as part of the parent slide.'
    const authority = chosen && chosen !== slide.final?.layout
      ? ` The compiler reads ${layoutDisplayName(chosen)} as the slide’s layout tag.`
      : ''
    findings.push({
      kind: 'competing-layouts',
      token: slide.winner?.raw ?? chosen ?? '',
      line: (slide.winner?.line ?? slide.headingLine) + 1,
      headingLine: slide.headingLine + 1,
      slideTitle: parseHeadingAttrs(facts.bodyLines[slide.headingLine].replace(/^#{2,6}\s+/, '')).title,
      detail: `${drawn}${authority} Ignored layout tags: ${ignored.join(', ')}.`
    })
  }
  return findings
}

/** A competing-layout warning replaces the generic duplicate reports for that heading. */
export function withCompetingLayoutFindings(
  findings: LayoutDoctorFinding[], competing: LayoutDoctorFinding[]
): LayoutDoctorFinding[] {
  if (!competing.length) return findings
  const headings = new Set(competing.map(finding => finding.headingLine))
  return [
    ...findings.filter(finding => finding.kind !== 'duplicate-layout' || !headings.has(finding.headingLine)),
    ...competing
  ]
}

interface PreviewChange { line: number; before: string; after: string | null }
export type CompetingLayoutRepair = { ok: true; headingLine: number; text: string; lines: PreviewChange[] }
export type CompetingLayoutSave = { before: string; headingLine: number }
type RepairPlan = CompetingLayoutRepair | { ok: false; error: string }

const unavailable = { ok: false as const, error: 'The compiler’s layout tag could not be kept safely. Check the attributes in Markdown.' }

/** Preview exactly what the normal save will write, provided only the selected slide changes. */
export function planCompetingLayoutRepair(text: string, headingLine: number): RepairPlan {
  try {
    const slide = compilerFactsOf(text).slideLayouts.get(headingLine - 1)
    if (!slide) return unavailable
    const tags = shadowedLayoutTags(slide)
    if (!tags.length) return unavailable

    const edited = removeCompetingLayoutTags(text, slide, tags)
    const next = normalizePositions(edited, slide.headingLine)
    if (next === text) return unavailable
    const before = text.split('\n')
    const after = next.split('\n')
    const prefix = before.slice(0, slide.headingLine)
    const suffix = before.slice(slide.endLine)
    if (after.length <= prefix.length + suffix.length ||
        prefix.some((line, index) => line !== after[index]) ||
        suffix.some((line, index) => line !== after[after.length - suffix.length + index])) {
      return { ok: false, error: 'Saving would tidy lines outside this slide. Tidy the talk, then review the fix again.' }
    }
    const saveChange = outlineSaveChange(next, slide.headingLine)
    if (saveChange === 'ids') return { ok: false, error: 'Saving would add slide IDs. Save the talk, then review the fix again.' }
    if (saveChange !== null) return { ok: false, error: 'Saving would also change the outline’s text. Save the talk, then review the fix again.' }

    // Include the full span of the edit so moved attributes and removed blank lines are visible.
    let first = slide.headingLine
    let beforeEnd = slide.endLine
    let afterEnd = after.length - suffix.length
    while (first < beforeEnd && first < afterEnd && before[first] === after[first]) first += 1
    while (beforeEnd > first && afterEnd > first && before[beforeEnd - 1] === after[afterEnd - 1]) {
      beforeEnd -= 1
      afterEnd -= 1
    }
    return { ok: true, headingLine, text: next, lines: [{
      line: first + 1,
      before: before.slice(first, beforeEnd).join('\n'),
      after: afterEnd === first ? null : after.slice(first, afterEnd).join('\n')
    }] }
  } catch (error) {
    return error instanceof LayoutVerbError ? { ok: false, error: error.detail } : unavailable
  }
}
