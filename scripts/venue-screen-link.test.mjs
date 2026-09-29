import assert from 'node:assert/strict'
import { venueScreenLinkFromOutline, venueScreenLinkFromUrl } from '../src/shared/venue-screen-link.ts'
assert.equal(venueScreenLinkFromUrl('https://handouts.fyi/k7m2'), 'https://handouts.fyi/k7m2/p')

assert.equal(venueScreenLinkFromOutline('---\nhandout_url: https://handouts.fyi/k7m2\n---'), 'https://handouts.fyi/k7m2/p')
assert.equal(venueScreenLinkFromOutline('---\nhandout_url: https://handouts.fyi/my-talk/\n---'), 'https://handouts.fyi/my-talk/p/')
assert.equal(venueScreenLinkFromOutline('---\ntitle: Unpublished\n---'), null)
console.log('venue screen link: published short and slug URLs passed')
