// Where the talk's title is, for every move of a slide or section (pure).
//
// THE RULE: nothing is ever placed before the talk's level-1 title. The outline's relocate functions
// (src/shared/slide-handling/slide-outline.ts), the whole-slide paste and "Move … to…"
// (slide-block-ops.ts) and the slide moves of slide-handling/blocks.ts (through them) all ask the two functions here, so no
// entry point can decide it differently. scripts/test-slide-outline-moves.mjs tests them.
//
// The title is the first level-1 heading line (`# …`) after the YAML frontmatter that is not inside
// a code fence: a `# comment` in a fenced shell snippet or in the frontmatter is never the title. A
// talk with no such line has no title and every move behaves as it did before this rule. Which
// lines are headings is read from heading-lines.ts, as everywhere else.

import { headingLevels } from './heading-lines.ts'

/** 0-based index of the talk's title line, or -1 when the talk has none. `levels` is
 *  headingLevels(lines) when the caller already has it. */
export function talkTitleIndex(lines: readonly string[], levels: readonly number[] = headingLevels(lines)): number {
  return levels.indexOf(1)
}

/**
 * Whether putting lines[from0, end0) immediately before index `at` (an index into `lines` as they
 * are before the move) would put them before the talk's title. Never true for a block that holds
 * the title itself, or in a talk without a title.
 */
export function landsBeforeTitle(lines: readonly string[], from0: number, end0: number, at: number, levels?: readonly number[]): boolean {
  const title0 = talkTitleIndex(lines, levels)
  if (title0 < 0 || (from0 <= title0 && title0 < end0)) return false
  return at <= title0
}
