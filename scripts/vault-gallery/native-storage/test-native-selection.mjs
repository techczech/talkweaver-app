import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const adapter=readFileSync('src/main/vault-gallery-inventory-fs.ts','utf8')
assert.doesNotMatch(adapter,/python3|'-c'/,'Inventory must execute a bundled binary without an interpreter')
const pkg=JSON.parse(readFileSync('package.json'))
assert.match(pkg.scripts['build:native'],/build:gallery-native/)
assert.ok(pkg.build.mac.extraResources.some(r=>r.from==='native/vault-gallery' && r.to==='vault-gallery'))
console.log('PASS native distribution selection')
