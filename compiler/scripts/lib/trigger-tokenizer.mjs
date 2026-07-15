export const LIST_VALUE_KEYS = new Set(['tags'])
export const TRIGGER_LINE_RE = /^\{[^}]*\}(\s*\{[^}]*\})*$/

function isSeparator(character) {
  return /\s/.test(character) || character === ','
}

function takesListCommas(token) {
  const equals = token.indexOf('=')
  return equals > 0 && LIST_VALUE_KEYS.has(token.slice(0, equals))
}

export function tokenizeTriggerBody(body) {
  const tokens = []
  let index = 0
  while (index < body.length) {
    while (index < body.length && isSeparator(body[index])) index += 1
    if (index >= body.length) break
    const start = index
    let raw = ''
    while (index < body.length && (!isSeparator(body[index]) || (body[index] === ',' && takesListCommas(raw)))) {
      if (body[index] === '"') {
        index += 1
        while (index < body.length && body[index] !== '"') raw += body[index++]
        if (index < body.length) index += 1
      } else {
        raw += body[index++]
      }
    }
    tokens.push({ raw, source: body.slice(start, index), start, end: index })
  }
  return tokens
}
