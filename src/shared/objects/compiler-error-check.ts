// The compiler-error check on an object editor's commit (ADR-0042 completion, root plan 2026-10-28): a
// card or object edit is not written when it would ADD a compiler error the outline did not have. Errors
// already there are kept as they are and never block an edit (the author may be fixing something else).
//
// What is compared is each error OCCURRENCE, not its code: the errors are counted by what they say and,
// where the compiler reads them from one line, the line they come from. The same code from a new line,
// or one more of the same occurrence, is new.
//
// The errors read here are the ones a commit can change, with the compiler's own readings:
//   - trigger errors (unknown-trigger, unresolved-trigger) in headings and Trigger lines, by the outline
//     tree parse and its content-line classifier (14-outline-tree.mjs), with severities from the warning
//     registry; front matter and comments are read as the compiler reads them (outlineCompilerBody);
//   - a file a card names that main has answered missing or outside the talk's vault (the editor's
//     object status, src/main/object-status.ts), as the compiler's missing-asset / asset-outside-vault.
// A file whose status is not known yet is not counted: it is written, and the card says "File not found"
// as soon as main answers. Errors only the full build can see (duplicate slide ids across includes, board
// limits, beats records) are not read here; an object edit does not change headings or board fields.
// Pure: no I/O.
import { classifyContentLines, parseOutlineTree, type OutlineTreeNode } from '../../../compiler/scripts/lib/14-outline-tree.mjs'
import { formatWarning, warningDefinition } from '../../../compiler/scripts/lib/warning-registry.mjs'
import { outlineCompilerBody } from '../slide-source-text.ts'

/** A file a card names, with the state main answered for it. */
export type AssetFact = { ref: string; state: string }

export type ErrorOccurrences = Map<string, { count: number; message: string }>

const isError = (raw: string): boolean => warningDefinition(raw)?.severity === 'error'

function add(into: ErrorOccurrences, key: string, message: string): void {
  const held = into.get(key)
  if (held) held.count += 1
  else into.set(key, { count: 1, message })
}

/** Every compiler error occurrence the outline's structure and the given file facts raise. */
export function compilerErrorOccurrences(text: string, assets: readonly AssetFact[] = []): ErrorOccurrences {
  const out: ErrorOccurrences = new Map()
  const tree = parseOutlineTree(outlineCompilerBody(text).body)
  for (const raw of tree.warnings) if (isError(raw)) add(out, raw, formatWarning(raw))
  const visit = (node: OutlineTreeNode): void => {
    for (const entry of classifyContentLines(node.contentLines)) {
      for (const raw of entry.stray?.warnings ?? []) {
        if (isError(raw)) add(out, `${raw}\u0000${entry.line.trim()}`, formatWarning(raw))
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(tree.root)
  for (const fact of assets) {
    if (fact.state === 'missing') add(out, `missing-asset\u0000${fact.ref}`, `the file ${fact.ref} is not found`)
    else if (fact.state === 'outside') add(out, `asset-outside-vault\u0000${fact.ref}`, `${fact.ref} is outside this talk’s vault, so the deck would not include it`)
  }
  return out
}

/** The messages of the occurrences `after` has more of than `before`, in order. */
export function newCompilerErrors(before: ErrorOccurrences, after: ErrorOccurrences): string[] {
  const added: string[] = []
  for (const [key, entry] of after) {
    if (entry.count > (before.get(key)?.count ?? 0)) added.push(entry.message)
  }
  return added
}

/** The refusal for a commit that adds a compiler error, or null when it adds none. */
export function compilerErrorRefusal(
  beforeText: string,
  afterText: string,
  assetsBefore: readonly AssetFact[] = [],
  assetsAfter: readonly AssetFact[] = []
): string | null {
  const added = newCompilerErrors(compilerErrorOccurrences(beforeText, assetsBefore), compilerErrorOccurrences(afterText, assetsAfter))
  if (!added.length) return null
  return `this change would add ${added.length === 1 ? 'a slide error' : `${added.length} slide errors`}: ${added.join('; ')}`
}
