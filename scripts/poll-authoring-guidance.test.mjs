import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { OptionControl } from './src/renderer/src/components/CommandPalette';
    import { GLOBAL_OPTION_GROUPS } from './src/shared/layout-registry/entries';
    const group = GLOBAL_OPTION_GROUPS.find(g => g.key === 'poll-type');
    const root = createRoot(document.getElementById('root'));
    let selectedToken = '';
    function render() { root.render(<OptionControl binding={{group, selectedToken}} onSelect={(g,t) => {selectedToken=t; render();}} />); }
    render();
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' },
})
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(3000)
  await page.setContent('<main id="root"></main>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  for (const [type, example] of [['Ranking', /- First option/], ['Rating', /\[scale: 1, 2, 3\]/], ['Categorisation', /\[categories: Individual, Shared\]/]]) {
    await page.getByRole('button', { name: type, exact: true }).click()
    const help = page.getByRole('note', { name: 'How to add poll options' })
    await help.waitFor({ state: 'visible' })
    assert.match(await help.innerText(), /slide text/)
    assert.match(await help.locator('pre').innerText(), example)
  }
  await page.getByRole('button', { name: 'None', exact: true }).click()
  assert.equal(await page.getByRole('note', { name: 'How to add poll options' }).count(), 0)
  console.log('Poll type selection shows the matching inline authoring example')
} finally { await browser.close() }
