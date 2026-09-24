import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader:'tsx', contents:`
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { OptionControl } from './src/renderer/src/components/CommandPalette';
    import { GLOBAL_OPTION_GROUPS } from './src/shared/layout-registry/entries';
    import { commitOptionSelection, selectionForGroup } from './src/shared/trigger-line';
    const group = GLOBAL_OPTION_GROUPS.find(g => g.key === 'pollsubmissions');
    const root = createRoot(document.getElementById('root'));
    window.mountLimit = (line) => { window.line = line; render(); };
    function render() { root.render(<OptionControl binding={{group, selectedToken:selectionForGroup(window.line,group)}} onSelect={(g,t) => {window.line=commitOptionSelection(window.line,g,t); render();}} />); }
    window.mountLimit('{id=stable}{poll=open}{pollsubmissions=unlimited}');
  ` }, bundle:true, write:false, format:'iife', platform:'browser', define:{'process.env.NODE_ENV':'"production"'},
})
const browser = await chromium.launch({ headless:true })
try {
  const page = await browser.newPage()
  const errors=[]; page.on('pageerror', e => errors.push(e.message))
  await page.setContent('<main id="root"></main><button id="away">Away</button>')
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  const input = page.getByRole('spinbutton', {name:'Submissions per participant'})
  await input.focus(); await page.locator('#away').click()
  assert.match(await page.evaluate(() => window.line), /pollsubmissions=unlimited/, 'untouched blur preserves unlimited')
  for (const [value, expected] of [['02','2'],['2.0','2'],['1e2','100']]) {
    await input.fill(value); await page.locator('#away').click()
    assert.match(await page.evaluate(() => window.line), new RegExp(`pollsubmissions=${expected}\\}`), 'valid integer spelling is canonicalised')
  }
  await input.fill('0'); await page.locator('#away').click()
  assert.match(await page.evaluate(() => window.line), /pollsubmissions=100/, 'invalid numbers do not change the saved allowance')
  await input.fill(''); await page.locator('#away').click()
  assert.doesNotMatch(await page.evaluate(() => window.line), /pollsubmissions=/, 'clearing a configured integer restores the default')
  await page.getByRole('button',{name:'Unlimited',exact:true}).click()
  assert.match(await page.evaluate(() => window.line), /pollsubmissions=unlimited/)
  assert.deepEqual(errors, [], 'authoring does not throw')
  console.log('Poll numeric controls: canonical values, untouched unlimited, invalid inputs and default restoration passed (Playwright)')
} finally { await browser.close() }
