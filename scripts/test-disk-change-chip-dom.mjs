// The disk-change notice in the status bar (R2) in a real browser: the chip opens its popover by itself, can be closed,
// opens again when the change's version or kind changes, and keeps a live announcement while the popover is closed.
// Usage: node scripts/test-disk-change-chip-dom.mjs
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import { OutlineDiskChangeChip } from './src/renderer/src/components/OutlineDiskChangeBar.tsx'
      const root = createRoot(document.getElementById('host'))
      window.show = (change) => root.render(React.createElement(OutlineDiskChangeChip, { change, busy: false, onChoose: (c) => { window.chosen = c } }))`,
    resolveDir: root, loader: 'tsx', sourcefile: 'harness.tsx'
  },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"development"' }
})
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.setContent('<div id="host"></div>')
await page.addScriptTag({ content: bundle.outputFiles[0].text })
let failures = 0
const check = (ok, name) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failures += 1 }
const change = (kind, hash) => ({ outlinePath: '/t/outline.md', kind, hash, changedAt: Date.now() })
const popup = () => page.locator('[data-testid="outline-disk-change-bar"]').count()
const live = () => page.locator('[data-testid="outline-disk-change-live"]').textContent()

await page.evaluate((c) => window.show(c), change('changed', 'aaa'))
check((await popup()) === 1, 'the popover opens by itself with the change')
check((await page.getByRole('button', { name: 'Reload' }).count()) === 1, 'Reload is in the popover')
const firstText = await live()
await page.locator('.tw-disk-chip-btn').click()
check((await popup()) === 0, 'the chip closes the popover')
check((await live()).length > 0 && (await live()) === firstText, 'the live announcement stays while the popover is closed')
await page.evaluate((c) => window.show(c), change('changed', 'bbb'))
await page.waitForTimeout(150)
check((await popup()) === 1, 'a newer version of the change opens it again')
await page.locator('.tw-disk-chip-btn').click()
await page.evaluate((c) => window.show(c), change('removed', 'removed'))
await page.waitForTimeout(150)
check((await popup()) === 1, 'a change that becomes a removal opens it again')
check((await live()) !== firstText, 'the announcement follows the new kind')
await browser.close()
console.log(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)
