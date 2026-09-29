// =============================================================================
// Ticket 02 (Dominik, 29 Sep): which button each statement control lights — the look the compiled
// slide renders, read with the compiler's own resolver (compiler/scripts/lib/statement-options.mjs)
// from the slide's Trigger line, the deck's `claim_style:` and the compiled title placement. The
// older one-word options ({statement=tint}, {claim=bar}, …) light their mapped values; writes go
// through commitOptionSelection (trigger-line.ts), which rewrites them as per-dimension tokens.
// =============================================================================
import { parseTriggerLine } from '../../compiler/scripts/lib/02-triggers-layout.mjs'
import { resolveStatementOptions } from '../../compiler/scripts/lib/statement-options.mjs'
import { STATEMENT_OPTION_GROUPS } from './trigger-line.ts'

export { STATEMENT_OPTION_GROUPS }

export interface StatementSelectionContext {
  /** The deck's `claim_style:` ("bar" decides a statement with no token of its own). */
  deckClaimStyle?: string
  /** The compiled slide's title placement (`data-title-layout`): left = a rail. Absent = unknown. */
  titleLayout?: string
}

/** group key → the value token its lit button carries, for every statement control. */
export function statementSelections(line: string, context: StatementSelectionContext = {}): Record<string, string> {
  const look = resolveStatementOptions(parseTriggerLine(line)?.attrs ?? {}, { deckClaimStyle: context.deckClaimStyle ?? '' })
  const known = typeof context.titleLayout === 'string' && context.titleLayout !== ''
  const sidebar = look.sidebar
    ? look.sidebar
    : known ? (context.titleLayout === 'left' ? 'on' : 'off') : ''
  // The older {statement=centred} centres only a slide that paints no title (preview.11).
  const centred = look.align === 'centred' && (!look.centredNeedsNoTitle || !known || context.titleLayout === 'hidden')
  return {
    'statement-sidebar': sidebar ? `statement-sidebar=${sidebar}` : '',
    'statement-bg': look.bg === 'halo' ? '' : `statement-bg=${look.bg}`,
    'statement-align': centred ? 'statement-align=centred' : '',
    'statement-bar': look.bar === 'none' ? '' : `statement-bar=${look.bar}`,
    'statement-colour': look.accent ? `accent=${look.accent}` : ''
  }
}

export function isStatementOptionGroup(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(STATEMENT_OPTION_GROUPS, key)
}
