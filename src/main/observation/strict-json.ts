/**
 * Strict, bounded RFC 8259 JSON parser for Cloudflare replies, worker lines and cache files.
 *
 * `JSON.parse` silently keeps the last of two equal keys, so an inventory with a duplicated path
 * would lose a file without notice. This parser refuses duplicates in every object, lone
 * surrogates, nesting deeper than `maxDepth`, objects with more than `maxKeysPerObject` keys,
 * over-long keys and strings, and anything after the value. Limits apply to every object in the
 * text, read later or not. Objects are created without a prototype, so a `__proto__` key is data.
 * Errors are fixed codes and never quote the input.
 */
export type StrictJsonError = 'syntax' | 'duplicate-key' | 'lone-surrogate' | 'depth' | 'too-many-keys' | 'string-too-long' | 'trailing'
export type StrictJsonResult = { ok: true; value: unknown } | { ok: false; code: StrictJsonError }
export interface StrictJsonLimits {
  maxDepth: number
  maxKeysPerObject: number
  maxKeyBytes: number
  maxStringBytes: number
}
export const STRICT_JSON_LIMITS: Readonly<StrictJsonLimits> = Object.freeze({ maxDepth: 32, maxKeysPerObject: 200_000, maxKeyBytes: 4096, maxStringBytes: 1_048_576 })

class StrictJsonFailure {
  readonly code: StrictJsonError
  constructor(code: StrictJsonError) { this.code = code }
}
function stop(code: StrictJsonError): never { throw new StrictJsonFailure(code) }

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y

export function parseStrictJson(text: string, limits: Partial<StrictJsonLimits> = {}): StrictJsonResult {
  const { maxDepth, maxKeysPerObject, maxKeyBytes, maxStringBytes } = { ...STRICT_JSON_LIMITS, ...limits }
  if (typeof text !== 'string') return { ok: false, code: 'syntax' }
  let at = 0

  const space = (): void => {
    for (;;) {
      const c = text.charCodeAt(at)
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) at++
      else return
    }
  }
  const hex4 = (): number => {
    const digits = text.slice(at, at + 4)
    if (!/^[0-9a-fA-F]{4}$/u.test(digits)) stop('syntax')
    at += 4
    return Number.parseInt(digits, 16)
  }
  // UTF-8 length of one non-surrogate code unit; surrogate pairs are counted as 4 where they are read.
  const utf8Bytes = (unit: number): number => unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3

  const string = (cap: number): string => {
    // `at` is on the opening quote.
    at++
    const parts: string[] = []
    let start = at
    let bytes = 0
    for (;;) {
      if (at >= text.length) stop('syntax')
      const c = text.charCodeAt(at)
      if (c === 0x22) {
        parts.push(text.slice(start, at))
        at++
        return parts.join('')
      }
      if (c < 0x20) stop('syntax')
      if (c === 0x5c) {
        parts.push(text.slice(start, at))
        at++
        const e = text[at++]
        let unit: number
        if (e === '"') unit = 0x22
        else if (e === '\\') unit = 0x5c
        else if (e === '/') unit = 0x2f
        else if (e === 'b') unit = 0x08
        else if (e === 'f') unit = 0x0c
        else if (e === 'n') unit = 0x0a
        else if (e === 'r') unit = 0x0d
        else if (e === 't') unit = 0x09
        else if (e === 'u') unit = hex4()
        else return stop('syntax')
        if (unit >= 0xdc00 && unit <= 0xdfff) stop('lone-surrogate')
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (text[at] !== '\\' || text[at + 1] !== 'u') stop('lone-surrogate')
          at += 2
          const low = hex4()
          if (low < 0xdc00 || low > 0xdfff) stop('lone-surrogate')
          parts.push(String.fromCharCode(unit, low))
          bytes += 4
        } else {
          parts.push(String.fromCharCode(unit))
          bytes += utf8Bytes(unit)
        }
        if (bytes > cap) stop('string-too-long')
        start = at
        continue
      }
      if (c >= 0xd800 && c <= 0xdfff) {
        const next = text.charCodeAt(at + 1)
        if (c > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) stop('lone-surrogate')
        bytes += 4
        at += 2
      } else {
        bytes += utf8Bytes(c)
        at++
      }
      if (bytes > cap) stop('string-too-long')
    }
  }

  const value = (depth: number): unknown => {
    space()
    const c = text[at]
    if (c === '{') {
      if (depth >= maxDepth) stop('depth')
      at++
      const object = Object.create(null) as Record<string, unknown>
      const seen = new Set<string>()
      space()
      if (text[at] === '}') { at++; return object }
      for (;;) {
        space()
        if (text[at] !== '"') stop('syntax')
        const key = string(maxKeyBytes)
        if (seen.has(key)) stop('duplicate-key')
        seen.add(key)
        if (seen.size > maxKeysPerObject) stop('too-many-keys')
        space()
        if (text[at] !== ':') stop('syntax')
        at++
        object[key] = value(depth + 1)
        space()
        if (text[at] === ',') { at++; continue }
        if (text[at] === '}') { at++; return object }
        stop('syntax')
      }
    }
    if (c === '[') {
      if (depth >= maxDepth) stop('depth')
      at++
      const array: unknown[] = []
      space()
      if (text[at] === ']') { at++; return array }
      for (;;) {
        array.push(value(depth + 1))
        space()
        if (text[at] === ',') { at++; continue }
        if (text[at] === ']') { at++; return array }
        stop('syntax')
      }
    }
    if (c === '"') return string(maxStringBytes)
    if (text.startsWith('true', at)) { at += 4; return true }
    if (text.startsWith('false', at)) { at += 5; return false }
    if (text.startsWith('null', at)) { at += 4; return null }
    NUMBER.lastIndex = at
    const number = NUMBER.exec(text)
    if (!number) stop('syntax')
    at += number[0].length
    const parsed = Number(number[0])
    if (!Number.isFinite(parsed)) stop('syntax')
    return parsed
  }

  try {
    const parsed = value(0)
    space()
    if (at !== text.length) return { ok: false, code: 'trailing' }
    return { ok: true, value: parsed }
  } catch (error) {
    if (error instanceof StrictJsonFailure) return { ok: false, code: error.code }
    // A stack overflow cannot happen within maxDepth; anything else is still not valid input.
    return { ok: false, code: 'syntax' }
  }
}
