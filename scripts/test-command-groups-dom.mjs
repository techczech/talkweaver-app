// Headless interaction with the real palette; no Electron or installed browser.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { TASK_GROUPS } from '../src/shared/task-groups.ts'

const root = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(root, '.tw-command-groups-'))
let browser, passed = 0
try {
  await build({ stdin: { contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import CommandMenu from './src/renderer/src/components/CommandMenu.tsx';
import{listedPaletteCommands}from'./src/shared/command-registry.ts';
window.ran=[];
const commands=listedPaletteCommands().map(c=>({id:c.id,title:c.label,group:c.taskGroup,subgroup:c.subgroup,keywords:c.palette.keywords,hint:c.id==='undo'?'⌘Z':'',run:()=>window.ran.push(c.id)}));
commands.push({id:'disabled',title:'Unavailable fixture',group:'Write the outline',subgroup:'Fixture',disabled:true,run:()=>window.ran.push('disabled')});
let open;
function App(){const[isOpen,setOpen]=useState(false),[query,setQuery]=useState('');open=q=>{setQuery(q);setOpen(true)};return <><textarea id="source" defaultValue="Original text"/><button id="outside">Outside</button><CommandMenu isOpen={isOpen} initialQuery={query} onClose={()=>setOpen(false)} commands={commands}/></>}
flushSync(()=>createRoot(document.getElementById('root')).render(<App/>));window.openPalette=(q='')=>flushSync(()=>open(q));
`, resolveDir: root, sourcefile: 'command-groups-fixture.tsx', loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile: join(scratch, 'fixture.js'), logLevel: 'silent' })
  copyFileSync(join(root, 'src/renderer/src/styles.css'), join(scratch, 'styles.css'))
  writeFileSync(join(scratch, 'fixture.html'), '<meta charset="utf-8"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(pathToFileURL(join(scratch, 'fixture.html')).href)
  const query = page.getByRole('combobox', { name: 'Command query' })
  const active = () => page.locator('[role=option][data-active=true]')
  async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`) }
  async function open(text = '') { await page.locator('#source').focus(); await page.evaluate(q => window.openPalette(q), text); await query.waitFor(); await query.focus() }
  await check('empty palette lists ten distinct icon categories in canonical order', async () => {
    await open()
    assert.deepEqual(await page.locator('[data-task-group]').evaluateAll(rows => rows.map(r => r.dataset.taskGroup)), TASK_GROUPS)
    assert.equal(await page.locator('[data-command]').count(), 0)
    assert.equal(await page.locator('[data-group-icon]').count(), 10)
  })
  await check('Right opens category and subgroup headings are not navigable commands', async () => {
    await query.press('ArrowRight')
    assert.ok(await page.locator('.command-menu-subgroup').count() > 0)
    assert.equal(await page.locator('[data-task-group]').count(), 0)
    assert.equal(await query.getAttribute('placeholder'), 'Search Write the outline…')
    assert.ok(await active().getAttribute('data-command'))
  })
  await check('typing in a group cannot return commands from another group', async () => {
    await query.fill('Unavailable fixture')
    assert.equal(await page.locator('[data-command]').count(), 1)
    await query.press('Enter')
    assert.deepEqual(await page.evaluate(() => window.ran), [])
    await query.fill('publish')
    assert.equal(await page.locator('[data-command]').count(), 0)
  })
  await check('Escape returns to categories and remembers the group row', async () => {
    await query.press('Escape'); assert.equal(await active().getAttribute('data-task-group'), 'Write the outline')
    assert.equal(await query.inputValue(), '')
    await query.press('ArrowDown'); await query.press('Enter'); await query.press('ArrowLeft')
    assert.equal(await active().getAttribute('data-task-group'), 'Build a slide')
  })
  await check('Backspace only navigates back when the query is empty', async () => {
    await query.press('Enter'); await query.fill('x'); await query.press('Backspace')
    assert.equal(await page.locator('[data-task-group]').count(), 0)
    await query.press('Backspace'); assert.equal(await active().getAttribute('data-task-group'), 'Build a slide')
  })
  await check('top query searches group and subgroup names and command labels', async () => {
    await query.fill('Undo'); assert.ok(await page.locator('[data-command=undo]').count())
    assert.equal(await page.locator('[data-task-group]').count(), 0)
    await query.fill('Write the outline'); assert.ok(await page.locator('[data-command]').count() > 1)
    await query.fill('Headings and levels'); assert.ok(await page.locator('[data-command]').count() > 0)
  })
  await check('composition keys neither run nor navigate nor dismiss', async () => {
    await query.fill('Undo')
    for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Backspace']) {
      assert.equal(await query.evaluate((el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true })), key), true)
    }
    assert.deepEqual(await page.evaluate(() => window.ran), [])
    assert.equal(await query.inputValue(), 'Undo')
    assert.equal(await query.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))), true)
    await query.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    assert.equal(await query.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))), true, 'composition lifecycle also protects keys without isComposing')
    await query.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    assert.deepEqual(await page.evaluate(() => window.ran), [])
  })
  await check('command runs once and closing restores previous text-field focus', async () => {
    await query.fill('Undo'); await query.press('Enter')
    assert.deepEqual(await page.evaluate(() => window.ran), ['undo'])
    assert.equal(await page.evaluate(() => document.activeElement.id), 'source')
  })
  await check('forwarded Actions here query searches immediately and reopening clears group state', async () => {
    await open('Undo'); assert.equal(await query.inputValue(), 'Undo'); assert.ok(await page.locator('[data-command=undo]').count())
    await query.press('Escape'); await open(); assert.equal(await page.locator('[data-task-group]').count(), 10)
  })
  await check('Tab and Shift Tab remain in palette and Escape restores focus', async () => {
    await query.press('Tab'); assert.equal(await query.evaluate(el => el === document.activeElement), true)
    await query.press('Shift+Tab'); assert.equal(await query.evaluate(el => el === document.activeElement), true)
    await query.press('Escape'); assert.equal(await page.evaluate(() => document.activeElement.id), 'source')
  })
  await check('plain text select-all and undo work inside query', async () => {
    await open(); await query.pressSequentially('hello'); await query.press('ControlOrMeta+a')
    assert.equal(await query.evaluate(el => el.selectionEnd - el.selectionStart), 5)
    await query.press('Backspace'); await query.press('ControlOrMeta+z')
    assert.equal(await query.inputValue(), 'hello')
    await query.press('Escape')
  })
  await check('mouse category opens and backdrop dismisses without stealing restored focus', async () => {
    await open(); await page.locator('[data-task-group="Build a slide"]').click()
    assert.equal(await query.getAttribute('placeholder'), 'Search Build a slide…')
    await page.locator('.command-menu-backdrop').click({ position: { x: 10, y: 10 } })
    assert.equal(await page.evaluate(() => document.activeElement.id), 'source')
  })
  assert.deepEqual(errors, [])
  console.log(`${passed} command-group DOM checks passed`)
} finally {
  try { await browser?.close() } finally { rmSync(scratch, { recursive: true, force: true }) }
}
