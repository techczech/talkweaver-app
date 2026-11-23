import assert from 'node:assert/strict'
import { displayWebAddress } from '../compiler/scripts/lib/address-display.mjs'
const cases = [
  ['QR domain', 'https://www.researchsnacks.semanticmachines.fyi/dated/long-path?x=1#part', { qr: true }, 'researchsnacks.semanticmachines.fyi'],
  ['long host stays whole', 'https://a-very-long-host-name.example.test/path', { linked: true, maxLength: 16 }, 'a-very-long-host-name.example.test/…'],
  ['path segments', 'https://example.test/first/second/third/fourth', { linked: true, maxLength: 31 }, 'example.test/first/second…'],
  ['hyphen boundary', 'https://example.test/a-long-path-with-many-words', { linked: true, maxLength: 30 }, 'example.test/a-long-path-…'],
  ['short path', 'https://www.example.test/notes', { linked: true }, 'example.test/notes'],
  ['short path keeps its trailing slash', 'https://www.example.test/notes/', { linked: true }, 'example.test/notes/'],
  ['no path', 'https://www.example.test/', { linked: true }, 'example.test'],
  ['query and fragment', 'https://example.test/notes?search=one#two', { linked: true }, 'example.test/notes'],
  ['non ASCII', 'https://příklad.test/poznámky/krátké', { linked: true }, 'příklad.test/poznámky/krátké'],
  ['Unicode path boundary', 'https://example.test/🧭🧭🧭🧭🧭', { linked: true, maxLength: 16 }, 'example.test/🧭🧭…'],
  ['no QR or live link', 'https://www.example.test/a-long-address?search=one#two', { maxLength: 8 }, 'https://www.example.test/a-long-address?search=one#two'],
  ['non web destination', 'mailto:speaker@example.test', { qr: true }, 'mailto:speaker@example.test'],
]
for (const [name, input, options, expected] of cases) assert.equal(displayWebAddress(input, options), expected, name)
console.log(`PASS address display: ${cases.length} table cases`)
