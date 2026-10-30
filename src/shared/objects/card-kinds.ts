// The object-card kinds that are not layouts (ADR-0042): every fence that is not a table, chart, mind map,
// Mermaid or SVG object, plus speaker notes and HTML comments. One entry per kind: the words the card and
// its editor show, and which editor opens it. The layout registry keeps the layout-backed objects.
// Pure: no DOM.

export type CardEditor = 'code' | 'turns' | 'shell-session' | 'trace-rows' | 'notes' | 'comment' | 'source'

export interface CardKindDeclaration {
  kind: 'code' | 'chat' | 'terminal' | 'trace' | 'notes' | 'comment' | 'embed'
  /** The kind as the card's chip and the editor's header say it. */
  label: string
  editor: CardEditor
  /** What an empty card says. */
  emptyPrompt: string
}

export const CARD_KINDS: readonly CardKindDeclaration[] = [
  { kind: 'code', label: 'Code', editor: 'code', emptyPrompt: 'Empty code block' },
  { kind: 'chat', label: 'Chat', editor: 'turns', emptyPrompt: 'Empty chat: add a turn' },
  { kind: 'terminal', label: 'Terminal', editor: 'shell-session', emptyPrompt: 'Empty terminal: add a command' },
  { kind: 'trace', label: 'Trace', editor: 'trace-rows', emptyPrompt: 'Empty trace: add a turn' },
  { kind: 'notes', label: 'Speaker notes', editor: 'notes', emptyPrompt: 'Empty: type your notes' },
  { kind: 'comment', label: 'Comment', editor: 'comment', emptyPrompt: 'Empty comment' },
  { kind: 'embed', label: 'Page', editor: 'source', emptyPrompt: '' }
]

/** What an embed card calls itself, by what its line names. */
export const EMBED_LABELS: Readonly<Record<string, { label: string; status: string }>> = {
  web: { label: 'Web page', status: 'live page, not loaded here; it plays in the deck' },
  bare: { label: 'Web page', status: 'an address on its own line plays as a live page' },
  local: { label: 'HTML page', status: 'this file only; it runs in a sandbox on the slide' },
  simulation: { label: 'Simulation', status: 'this file only; it runs in a sandbox on the slide' },
  video: { label: 'Video', status: 'plays in the deck' },
  'video-web': { label: 'Video', status: 'online player; plays in the deck' }
}

export function cardKind(kind: string): CardKindDeclaration | undefined {
  return CARD_KINDS.find((entry) => entry.kind === kind)
}

/** The design names a chat session fence can carry, in the words the card shows. */
export const SIMULATION_DESIGN_LABELS: Readonly<Record<string, string>> = {
  chat: 'AI chat',
  'chat-lanes': 'Chat lanes',
  terminal: 'Terminal',
  'terminal-agent': 'Terminal agent'
}

/**
 * The privacy statement on a speaker-notes card (design §4.4, root 2026-10-28): true for every surface,
 * including the explicit share-with-notes build variant and in-app search.
 */
export const NOTES_PRIVACY_TEXT = 'Shown in the presenter window. Not in the audience deck, the handout, the venue page or what you share for comments. The "share with notes" file from Build variants includes them on purpose, and search inside TalkWeaver can find them.'
