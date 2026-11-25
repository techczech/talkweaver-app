// Real hidden Electron presenter and audience. Only the presenter renders marker controls.
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAppScratch, launchApp } from './lib/launch-app.mjs'

await using scratch = createAppScratch()
const vault = join(scratch.root, 'vault')
const talk = join(vault, 'marker-test')
const outline = join(talk, 'marker-test-outline.md')
const content = [
  '---', 'title: Presenter video markers', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  '', '### Clip {id=clip}', '', '![Clip](clip.webm){controls}',
  '[Marker: 0:01 Intro]', '[Marker: 0:04 Demo]', '[Marker: 0:08 Result]', '', '### End {id=end}', '', 'Done.',
].join('\n')
mkdirSync(talk, { recursive: true })
mkdirSync(scratch.userData, { recursive: true })
writeFileSync(outline, content)
writeFileSync(join(scratch.userData, 'config.json'), JSON.stringify({ vaultRoot: vault }))
copyFileSync(join(import.meta.dirname, 'fixtures/video-playback-12s.webm'), join(talk, 'clip.webm'))

await using run = await launchApp({ scratch, args: ['.', '--mute-audio'] })
const { app, page } = run
await page.waitForFunction(() => window.tw?.talk?.present)
const openingPresenter = app.waitForEvent('window')
openingPresenter.catch(() => {})
const result = await page.evaluate(({ path, content }) =>
  window.tw.talk.present(path, content, 'presenter', 'clip'), { path: outline, content })
assert(result?.success, JSON.stringify(result))
const presenter = await openingPresenter
const current = presenter.frameLocator('#currentPreview > iframe[data-slide-id=clip]:not(.preview-incoming)')
const marker = current.getByRole('button', { name: 'Jump to 0:08 Result' })
await marker.waitFor()
const [audience] = await Promise.all([app.waitForEvent('window'), presenter.keyboard.press('F5')])
assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())))
await audience.locator('#stage .slide.active video').waitFor()
await presenter.keyboard.press('2')
await audience.waitForFunction(() => {
  const video = document.querySelector('#stage .slide.active video')
  return video?.paused && !video.seeking && Math.abs(video.currentTime - 4) < 0.035
})
assert.equal(await audience.locator('.tw-video-marker-tick, #presenterMarkerList button').count(), 0)
assert.equal(await audience.locator('#stage .slide.active .tw-video-seek').isVisible(), false)
await presenter.locator('#presenterMediaPlay').click()
await audience.waitForFunction(() => document.querySelector('#stage .slide.active video')?.paused === false)
await marker.click()
await audience.waitForFunction(() => {
  const video = document.querySelector('#stage .slide.active video')
  return !video.paused && !video.seeking && video.currentTime >= 8 && video.currentTime < 10
})
console.log('PASS hidden Electron digit and tick jumps reach the audience and preserve paused and playing states')
