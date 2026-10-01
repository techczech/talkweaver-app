export const REACTIONS_KEY: 'reactions'
export const STANDARD_REACTIONS: readonly string[]
export const MAX_REACTIONS: number
export const CUSTOM_LABEL_MAX: number
export interface RegisteredReaction { id: string; icon: string; words: string; short: string }
export type ReactionsMode = 'standard' | 'off' | 'choose' | 'custom'
export interface ReactionsIssue { code: 'too-many' | 'duplicate' | 'label-too-long' | 'off-with-others' | 'list-space' | 'label-like-named'; count?: number; id?: string }
export function registeredReactions(): RegisteredReaction[]
export function isRegisteredReaction(id: string): boolean
export function registeredReactionIgnoringCase(label: string): string
export function readReactionsValue(value: unknown): { mode: ReactionsMode; ids: string[]; issues: ReactionsIssue[] }
export function reactionLabel(id: string): string
export function customLabelsProblem(labels: readonly string[]): string
export function reactionsToken(choice: { mode: ReactionsMode; ids?: readonly string[]; labels?: readonly string[] }): string
export function reactionWarnings(slideId: string, issues: readonly ReactionsIssue[]): string[]
