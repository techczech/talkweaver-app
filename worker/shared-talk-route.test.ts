import { describe, expect, test } from 'bun:test'
import {
  MAX_ITEM_BODY_BYTES, MAX_PATCH_BODY_BYTES, MAX_PUSH_BODY_BYTES,
  canonicalShareRoutePath, parseShareRoute, shareBodyLimit, shareRouteNeedsOwner,
} from './shared-talk-route'

describe('shared talk route grammar', () => {
  test('parses every route', () => {
    expect(parseShareRoute('/shares/k7m2ab9x')).toEqual({ shareId: 'k7m2ab9x', action: 'page' })
    for (const action of ['talk', 'talk.json', 'items', 'audience', 'owner', 'close'] as const) {
      expect(parseShareRoute(`/shares/k7m2ab9x/${action}`)).toEqual({ shareId: 'k7m2ab9x', action })
    }
    expect(parseShareRoute('/shares/k7m2ab9x/items/item-1_A')).toEqual({ shareId: 'k7m2ab9x', action: 'item', itemId: 'item-1_A' })
  })

  test('also parses the bare form (no /shares/ prefix) — the drafts-domain link shape (ticket 07)', () => {
    expect(parseShareRoute('/k7m2ab9x')).toEqual({ shareId: 'k7m2ab9x', action: 'page' })
    for (const action of ['talk', 'talk.json', 'items', 'audience', 'owner', 'close'] as const) {
      expect(parseShareRoute(`/k7m2ab9x/${action}`)).toEqual({ shareId: 'k7m2ab9x', action })
    }
    expect(parseShareRoute('/k7m2ab9x/items/item-1_A')).toEqual({ shareId: 'k7m2ab9x', action: 'item', itemId: 'item-1_A' })
    expect(parseShareRoute('/k7m2ab9x/talk/x')).toBeNull()
    expect(parseShareRoute('/K7M2AB9X/talk')).toBeNull()
    expect(parseShareRoute('/short/talk')).toBeNull()
  })

  test('rejects reserved-word ids — real top-level routes on this Worker (security review, ticket 07)', () => {
    for (const id of ['sessions', 'internal']) {
      expect(parseShareRoute(`/${id}`)).toBeNull()
      expect(parseShareRoute(`/shares/${id}`)).toBeNull()
      expect(parseShareRoute(`/${id}/close`)).toBeNull()
      expect(parseShareRoute(`/shares/${id}/close`)).toBeNull()
      expect(parseShareRoute(`/${id}/talk`)).toBeNull()
    }
  })

  test('canonicalShareRoutePath always yields the /shares/<id>/… form, whatever route was parsed', () => {
    expect(canonicalShareRoutePath({ shareId: 'k7m2ab9x', action: 'page' })).toBe('/shares/k7m2ab9x')
    for (const action of ['talk', 'talk.json', 'items', 'audience', 'owner', 'close'] as const) {
      expect(canonicalShareRoutePath({ shareId: 'k7m2ab9x', action })).toBe(`/shares/k7m2ab9x/${action}`)
    }
    expect(canonicalShareRoutePath({ shareId: 'k7m2ab9x', action: 'item', itemId: 'item-1_A' })).toBe('/shares/k7m2ab9x/items/item-1_A')
  })

  test('rejects extra segments, other actions and malformed ids', () => {
    for (const path of [
      '/shares/k7m2ab9x/talk/x',
      '/shares/k7m2ab9x/talk/',
      '/shares/k7m2ab9x/',
      '/shares/k7m2ab9x/close/x',
      '/shares/k7m2ab9x/owner/x',
      '/shares/k7m2ab9x/items/a/b',
      '/shares/k7m2ab9x/items/%2e%2e',
      '/shares/k7m2ab9x/talk.jsonx',
      '/shares/k7m2ab9x/internal',
      '/shares/K7M2AB9X/talk',
      '/shares/short/talk',
      '/shares/by-talk/x',
    ]) expect(parseShareRoute(path)).toBeNull()
  })

  test('only the three body routes have a cap, and only push and patch need the owner up front', () => {
    const route = (path: string) => parseShareRoute(path)!
    expect(shareBodyLimit(route('/shares/k7m2ab9x/talk'), 'PUT')).toBe(MAX_PUSH_BODY_BYTES)
    expect(shareBodyLimit(route('/shares/k7m2ab9x/items'), 'POST')).toBe(MAX_ITEM_BODY_BYTES)
    expect(shareBodyLimit(route('/shares/k7m2ab9x/items/a'), 'PATCH')).toBe(MAX_PATCH_BODY_BYTES)
    expect(shareBodyLimit(route('/shares/k7m2ab9x/close'), 'POST')).toBeNull()
    expect(shareBodyLimit(route('/shares/k7m2ab9x/talk'), 'POST')).toBeNull()
    expect(shareRouteNeedsOwner(route('/shares/k7m2ab9x/talk'), 'PUT')).toBe(true)
    expect(shareRouteNeedsOwner(route('/shares/k7m2ab9x/items/a'), 'PATCH')).toBe(true)
    expect(shareRouteNeedsOwner(route('/shares/k7m2ab9x/items'), 'POST')).toBe(false)
    expect(shareRouteNeedsOwner(route('/shares/k7m2ab9x/close'), 'POST')).toBe(false)
  })
})
