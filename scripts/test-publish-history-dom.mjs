import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
const entry = new URL('../src/renderer/src/components/PublishHistoryPanel.tsx', import.meta.url)
const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Panel from ${JSON.stringify(fileURLToPath(entry))};createRoot(document.getElementById('root')).render(React.createElement(Panel));`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic' })
const browser = await chromium.launch({headless:true})
try {
  const page = await browser.newPage()
  await page.route('**/*', route => route.abort())
  await page.setContent('<!doctype html><div id="root"></div>')
  await page.evaluate(() => { window.tw = {publish:{history:async()=>({ok:true,attempts:[]}),checkSite:async()=>({state:'in-step',checkedAt:'2026-11-17T10:00:00Z'})}} })
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  await page.getByText('No publishing attempts have been recorded on this Mac yet.').waitFor()
  await page.getByRole('button',{name:'Check this Mac against the site'}).click()
  await page.getByRole('status').filter({hasText:'This Mac and the site are in step for the last confirmed publication.'}).waitFor()
  await page.evaluate(() => { window.tw.publish.checkSite = async()=>({state:'changed',checkedAt:'2026-11-17T10:01:00Z'}) })
  await page.getByRole('button',{name:'Check this Mac against the site'}).click()
  await page.getByRole('status').filter({hasText:'The site has changed since this Mac’s last confirmed publication.'}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Check this Mac against the site'}).isEnabled(),true)
  console.log('Publish history DOM: empty history, explicit check and changed-site state passed (3 cases).')
} finally { await browser.close() }
