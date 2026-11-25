import assert from 'node:assert/strict'
import { lexMarkdownBlocksWith } from '../compiler/scripts/lib/03-markdown-lexer-core.mjs'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { collectDeckLinks, prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { renderBlock } from '../compiler/scripts/lib/06-block-renderers.mjs'
import { parseSlideScript } from '../compiler/scripts/lib/slide-script.mjs'
import { formatMarkerTime, parseMarkerTime, readVideoMarker } from '../compiler/scripts/lib/video-markers.mjs'
import { editVideoMarker, scanOutlineVideos, withoutAuthoringVideoMarkers } from '../src/shared/video-marker-edits.ts'
import { detectObjectBlocks, detectOutlineObjects } from '../src/renderer/src/extensions/objectBlocks/detect.ts'
import { adjacentVideoMarker, videoMarkerRows } from '../compiler/assets/runtime/video-markers.js'
import { actionRowsAt } from '../src/shared/actions-here.ts'

const image = '![Demo](media/demo.mp4){muted}'
const video = '[Video: media/other.webm]{play-on-next}'
const youtube = '[Video: https://www.youtube.com/watch?v=dQw4w9WgXcQ]'
const source = [
  '### Intro', image, '[Marker: 4:10 Result]', '', '[mArKEr: 1:23 <b>Demo & "go"</b>]',
  '[Marker: 1:23 The same time]', 'A paragraph', '[Marker: 0:00 Orphan]', video,
  '[Marker: 0:00]', youtube, '[Marker: 0:00 External]',
  '~~~markdown', '[Marker: 0:00 Example]', '~~~',
  ':::notes', '[Marker: 0:01 Note]', ':::',
].join('\n')
const scan = scanOutlineVideos(source)
assert.deepEqual(scan.orphans, [7])
assert.deepEqual(scan.videos.map(v => [v.line, v.player, v.markers.map(m => m.line)]), [
  [1, null, [2, 4, 5]], [8, null, [9]], [10, 'youtube', [11]]
])
const blocks = lexMarkdownBlocksWith(source.split('\n').slice(1, 15), () => null)
assert.deepEqual(blocks.map(b => b.type), ['video', 'paragraph', 'video', 'embed', 'code'])
assert.deepEqual(blocks[0].markers, [{ t: 83, name: '<b>Demo & "go"</b>' }, { t: 83, name: 'The same time' }, { t: 250, name: 'Result' }])
assert.deepEqual(blocks[2].markers, [{ t: 0, name: '0:00' }])
assert.equal(blocks[3].markers, undefined)
assert.equal(blocks[4].text, '[Marker: 0:00 Example]')
const html = renderBlock(blocks[0], new Set())
assert.match(html, /data-video-markers="[^"]+&lt;b&gt;Demo &amp; \\&quot;go\\&quot;/)
assert.doesNotMatch(html, /<b>Demo/)
const phone = JSON.stringify(parseSlideScript(source))
assert.doesNotMatch(phone, /The same time|Orphan|External|Note/)
assert.match(phone, /Example/)
assert.deepEqual(collectDeckLinks([{ sourceMarkdown: '### Demo\n[Marker: 0:30 [Hidden](https://example.com)]' }]), [])
const videoFixture = fileURLToPath(new URL('../e2e/fixtures/video-playback-12s.webm', import.meta.url))
const plainVideo = '### Demo\n![Demo](video-playback-12s.webm)\n[Marker: 0:03 A <!-- literal --> name]\n'
const deck = await prepareSource(videoFixture.replace(/webm$/, 'md'), plainVideo, null, statSync(videoFixture), {})
assert.match(deck.fullHtml, /data-video-markers="[^"]*A &lt;!-- literal --&gt; name/)
assert.ok(!parseSlideScript(plainVideo).some(block => block.text?.includes('literal')))
const editorPreview = withoutAuthoringVideoMarkers(source)
assert.doesNotMatch(editorPreview, /The same time|Orphan|External/)
assert.match(editorPreview, /Example/)
assert.match(editorPreview, /Note/)
for (const includePictures of [false, true]) {
  const cards = detectObjectBlocks(source, includePictures).filter(block => block.video)
  assert.equal(cards.length, 3)
  assert.equal(cards[0].source, image + '\n[Marker: 4:10 Result]\n\n[mArKEr: 1:23 <b>Demo & "go"</b>]\n[Marker: 1:23 The same time]\n')
}

for (const ref of [image, video]) {
  const withComment = ['### Demo', ref, '<!-- Marker context', '', '[Marker: 0:09 hidden]', '-->', '[Marker: 0:03 Demo]'].join('\n')
  const { videos, orphans } = scanOutlineVideos(withComment)
  assert.deepEqual(videos[0].markers.map(marker => marker.line), [6])
  assert.deepEqual(orphans, [])
  const outline = detectOutlineObjects(withComment)
  assert.deepEqual(outline.blocks.map(block => block.video?.ref), [videos[0].ref])
  assert.ok(!outline.warnings.some(warning => warning.kind === 'orphan-video-marker'))
}
const opaqueComment = [image, ':::notes', '<!-- Context -->', ':::', '[Marker: 0:03 Orphan]'].join('\n')
assert.deepEqual(scanOutlineVideos(opaqueComment).orphans, [4])
const fencedComment = [image, '~~~markdown', '<!-- Context -->', '~~~', '[Marker: 0:03 Orphan]'].join('\n')
assert.deepEqual(scanOutlineVideos(fencedComment).orphans, [4])

assert.ok(!actionRowsAt('slide-text').some(row => row.commandId === 'video-marker-add'))
assert.ok(actionRowsAt('slide-text', { fileVideo: true }).some(row => row.commandId === 'video-marker-add'))

for (let second = 0; second <= 86400; second += 17) {
  const time = formatMarkerTime(second)
  assert.equal(parseMarkerTime(time), second)
  assert.deepEqual(readVideoMarker(` \t[MARKER: ${time} A [] & B] \t`), { t: second, time, name: 'A [] & B' })
}
assert.deepEqual(lexMarkdownBlocksWith(['Text', '[Marker: 24:00:01 too late]'], () => null),
  [{ type: 'paragraph', text: 'Text [Marker: 24:00:01 too late]' }])
assert.equal(parseMarkerTime('75:30'), 4530)
assert.equal(parseMarkerTime('24:00:00'), 86400)
for (const value of ['24:00:01', '1:60', '1:1', '-1:00', '0:0:00', '1441:00', '1:00.5']) {
  assert.equal(parseMarkerTime(value), null, value)
}
for (const newline of ['\n', '\r\n']) for (const end of ['', newline]) {
  const initial = ['### A talk', image, '[Marker: 0:01 Intro]', '', '[Marker: 0:05 Result]'].join(newline) + end
  for (let second = 0; second < 11; second += 1) {
    const target = scanOutlineVideos(initial).videos[0]
    const add = editVideoMarker(initial, target, { action: 'add', t: second })
    if (second === 1 || second === 5) { assert.ok(add.error); continue }
    const updated = scanOutlineVideos(add.text).videos[0]
    assert.deepEqual(updated.markers.map(m => m.t), [1, 5, second].sort((a, b) => a - b))
    const name = editVideoMarker(add.text, updated, { action: 'change', line: add.line, t: second, name: 'Demo' })
    assert.equal(scanOutlineVideos(name.text).videos[0].markers.find(m => m.t === second).name, 'Demo')
    const remove = editVideoMarker(name.text, scanOutlineVideos(name.text).videos[0], { action: 'remove', line: name.line })
    assert.equal(remove.text, initial)
    assert.ok(editVideoMarker(add.text, target, { action: 'remove', line: add.line }).error)
  }
}
const rows = videoMarkerRows({ duration: 12, dataset: { videoMarkers: JSON.stringify([
  { t: 3, name: 'First at this time' }, { t: 0, name: '' }, { t: 3, name: 'Second at this time' }, { t: 20, name: 'Unreachable' }
]) } })
assert.deepEqual(rows.map(row => [row.t, row.name, row.key, row.past]), [
  [0, '0:00', 1, false], [3, 'First at this time', 2, false], [3, 'Second at this time', 3, false], [20, 'Unreachable', null, true]
])
assert.equal(adjacentVideoMarker(rows, 3, -1).t, 0, 'Previous leaves the shared marker time')
assert.equal(adjacentVideoMarker(rows, 4, -1).t, 3)
assert.equal(adjacentVideoMarker(rows, 3, 1), undefined, 'Next skips past-end markers')
console.log('PASS video marker grammar, round-trip edits on LF and CRLF, video ownership, compiled data and audience text')
