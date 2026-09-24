const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function generateShortId(randomBytes: (length: number) => Uint8Array = defaultRandomBytes): string {
  return [...randomBytes(4)].map((byte) => ALPHABET[byte % ALPHABET.length]).join('')
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}
