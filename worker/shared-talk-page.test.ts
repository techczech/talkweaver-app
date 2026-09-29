import { describe, expect, test } from 'bun:test'
import { injectSharedTalkRuntime, sharedTalkPageConfig, sharedTalkRuntimeSlot, splitOnCodePoints } from './shared-talk-page'

const config = sharedTalkPageConfig('k7m2ab9x', 3, 11)

describe('shared talk page', () => {
  test('config points the runtime at this share\'s routes', () => {
    expect(config).toEqual({ shareId: 'k7m2ab9x', revision: 3, seq: 11, api: '/shares/k7m2ab9x', audienceSocket: '/shares/k7m2ab9x/audience' })
  })

  test('injects the runtime slot before </head> and leaves the handout otherwise untouched', () => {
    const html = '<!doctype html><html><head><title>T</title></head><body><main>Slides</main></body></html>'
    const page = injectSharedTalkRuntime(html, config)
    expect(page).toBe(html.replace('</head>', `${sharedTalkRuntimeSlot(config)}</head>`))
    expect(page).toContain('<script id="tw-shared-talk-runtime" data-slot="shared-talk-runtime"></script>')
    const json = page.match(/<script type="application\/json" id="tw-shared-talk-config">(.*?)<\/script>/)?.[1]
    expect(JSON.parse(json!)).toEqual(config)
  })

  test('falls back to after <body> and then to the start', () => {
    expect(injectSharedTalkRuntime('<body class="x"><p>a</p></body>', config)).toBe(`<body class="x">${sharedTalkRuntimeSlot(config)}<p>a</p></body>`)
    expect(injectSharedTalkRuntime('<p>a</p>', config)).toBe(`${sharedTalkRuntimeSlot(config)}<p>a</p>`)
  })

  test('config values cannot close the script element', () => {
    const slot = sharedTalkRuntimeSlot({ ...config, shareId: '</script><script>alert(1)</script>' })
    expect(slot.match(/<\/script>/g)).toHaveLength(2)
  })

  test('the slot never carries a credential', () => {
    expect(sharedTalkRuntimeSlot(config)).not.toMatch(/token|bearer|secret/i)
  })

  test('chunks never split a surrogate pair, and rejoin to the exact string', () => {
    const html = `${'a'.repeat(7)}😀${'b'.repeat(5)}😀`
    const chunks = splitOnCodePoints(html, 8)
    expect(chunks.join('')).toBe(html)
    expect(chunks[0]).toBe('a'.repeat(7))
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(8)
      expect(/[\ud800-\udbff]$/.test(chunk)).toBe(false)
      expect(/^[\udc00-\udfff]/.test(chunk)).toBe(false)
    }
    expect(splitOnCodePoints('', 8)).toEqual([])
    expect(splitOnCodePoints('abcdefgh', 8)).toEqual(['abcdefgh'])
  })
})
