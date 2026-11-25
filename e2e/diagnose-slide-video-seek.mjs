// Exercise the real, hidden Electron presenter and its paired audience window.
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAppScratch, launchApp } from './lib/launch-app.mjs'

await using scratch = createAppScratch()
const vault = join(scratch.root, 'vault')
const talk = join(vault, 'seek-test')
const outline = join(talk, 'seek-test-outline.md')
const content = [
  '---', 'title: Slide video seek', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  '', '### Clip {id=clip}', '', '![Clip](clip.webm){controls}', '', '### End {id=end}', '', 'Done.',
].join('\n')
mkdirSync(talk, { recursive: true })
mkdirSync(scratch.userData, { recursive: true })
writeFileSync(outline, content)
writeFileSync(join(scratch.userData, 'config.json'), JSON.stringify({ vaultRoot: vault }))
copyFileSync(join(import.meta.dirname, 'fixtures/audience-media/clip.webm'), join(talk, 'clip.webm'))

await using run = await launchApp({ scratch, args: ['.', '--mute-audio'] })
const { app, page } = run
await page.waitForFunction(() => window.tw?.talk?.present)
const [presenter, result] = await Promise.all([
  app.waitForEvent('window'),
  page.evaluate(({ path, content }) => window.tw.talk.present(path, content, 'presenter', 'clip'), { path: outline, content }),
])
assert(result?.success, JSON.stringify(result))
await presenter.locator('#presenterMediaPlay').waitFor()
const current = presenter.frameLocator('#currentPreview > iframe[data-slide-id=clip]:not(.preview-incoming)')
const seek = current.getByRole('slider', { name: 'Video position' })
await seek.waitFor()
const [audience] = await Promise.all([app.waitForEvent('window'), presenter.keyboard.press('F5')])
assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())))
const projected = audience.locator('#stage .slide.active video')
await projected.waitFor()
await presenter.locator('#presenterMediaPlay').click()
await audience.waitForFunction(() => {
  const video = document.querySelector('#stage .slide.active video')
  return video && !video.paused && !video.muted && video.currentTime > 0
})
await presenter.locator('#presenterMediaPause').click()
await audience.waitForFunction(() => document.querySelector('#stage .slide.active video')?.paused)
await seek.fill('4.25')
await audience.waitForFunction(() => {
  const video = document.querySelector('#stage .slide.active video')
  return !video.seeking && Math.abs(video.currentTime - 4.25) < 0.035
})
await current.getByRole('button', { name: 'Back to start' }).click()
await audience.waitForFunction(() => {
  const video = document.querySelector('#stage .slide.active video')
  return !video.seeking && video.currentTime < 0.035
})
assert(await current.locator('video').evaluate(video => video.currentTime < 0.035 && video.muted))
console.log('PASS Hidden Electron presenter scrub and return to start follow in the audience window.')
