import type { EmbedMessage } from '../../../worker/protocol'
export function normaliseLiveEmbed(value: unknown): EmbedMessage | null
export function liveEmbedRuntimeSource(): string
export function liveEmbedKey(value: EmbedMessage): string
