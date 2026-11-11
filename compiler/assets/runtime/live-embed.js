import { embedMessageFromDescription, embedEventDescription, embedProtocolSource, embedScrollAddressKey } from './embed-protocol.js'

/** A bounded description, never code, a URL, a frame token or a frozen image.
 * @returns {import("../../../worker/protocol.ts").EmbedMessage | null}
 * @param {any} value
 */
export function normaliseLiveEmbed(value) {
  if (!value || value.type !== 'embed.live' || typeof value.slideId !== 'string' || !value.slideId.trim()
    || value.slideId.length > 100 || !Number.isSafeInteger(value.index) || value.index < 0 || value.index > 31) return null
  if (value.event?.k === 'unavailable' && ['frozen', 'unsupported'].includes(value.event.reason))
    return { type: 'embed.live', slideId: value.slideId, index: value.index, event: { k: 'unavailable', reason: value.event.reason } }
  const event = embedMessageFromDescription('00000000000000000000000000000000', value.event)
  return event ? { type: 'embed.live', slideId: value.slideId, index: value.index, event: embedEventDescription(event) } : null
}

/** @param {import('../../../worker/protocol.ts').EmbedMessage} value */
export function liveEmbedKey(value) {
  return JSON.stringify([value.slideId, value.index, value.event.k, value.event.k === 'scroll' ? embedScrollAddressKey(value.event) : null])
}

export function liveEmbedRuntimeSource() {
  return embedProtocolSource() + '\n' + normaliseLiveEmbed.toString() + '\n' + liveEmbedKey.toString()
}
