import assert from 'node:assert/strict'
import { replaceRemoteEmbedFrames } from '../src/main/embed-preview-policy.ts'
const frame = (url, extra = '') => `<iframe data-src="${url}" data-embed-url="${url}" sandbox="allow-scripts"${extra}></iframe>`
const called = []
const capture = async url => { called.push(url); return 'data:image/png;base64,AAAA' }
const remote = await replaceRemoteEmbedFrames(frame('https://example.org/?a=1&amp;b=2'), capture)
assert.deepEqual(called, ['https://example.org/?a=1&b=2'])
assert.ok(remote.includes('<img data-tw-embed-artwork'))
assert.ok(!remote.includes('<iframe'))
for (const url of ['file:///tmp/private', 'twfile://vault/private', 'https://127.0.0.1/', 'https://user:password@example.org/', 'javascript:alert(1)']) {
  const out = await replaceRemoteEmbedFrames(frame(url), () => { throw Error('unsafe URL reached capture') })
  assert.ok(!out.includes('<iframe'))
  assert.ok(out.includes('preview unavailable'))
}
assert.ok((await replaceRemoteEmbedFrames(frame('https://example.org/'), async () => null)).includes('preview unavailable'))
const video = frame('https://youtube.com/embed/abc', ' data-embed-video="1"')
assert.ok(!(await replaceRemoteEmbedFrames(video, capture)).includes('<iframe'), 'non-normalised YouTube URL is not a player exemption')
for (const url of ['https://www.youtube-nocookie.com/embed/abcdefghijk', 'https://player.vimeo.com/video/123']) {
  const player = frame(url, ' data-embed-video="1"'); assert.equal(await replaceRemoteEmbedFrames(player, capture), player)
}
const local = '<iframe data-embed-doc="&lt;h1>Local&lt;/h1>" sandbox="allow-scripts allow-forms"></iframe>'
assert.equal(await replaceRemoteEmbedFrames(local, capture), local)
console.log('PASS: remote preview replacement, URL boundary, refusal, video and local preservation')
const { isLocalEmbedFrame } = await import('../src/main/navigation-guard.ts')
assert.equal(isLocalEmbedFrame({ url: 'about:srcdoc' }), true)
assert.equal(isLocalEmbedFrame({ url: 'about:blank', parent: { url: 'about:srcdoc' } }), true)
assert.equal(isLocalEmbedFrame({ url: 'twpresent://preview/deck.html', parent: { url: 'file:///app.html' } }), false)
console.log('PASS: local widget ancestry navigation boundary')
// Security review: attacker-controlled text must never exempt an ordinary web page.
for (const hostile of [
  frame('https://example.org/?data-embed-video=1'),
  frame('https://example.org/', ' title="data-embed-video=1"'),
  frame('https://example.org/', ' data-note="data-embed-video=1"'),
  frame('https://example.org/', ' data-embed-video="1"'),
  frame('https://youtube-nocookie.com.evil.example/embed/abcdefghijk', ' data-embed-video="1"'),
  '<iframe data-embed-url="https://www.youtube-nocookie.com/embed/abcdefghijk" data-src="https://example.org/" data-embed-video="1"></iframe>'
]) {
  const fixed = await replaceRemoteEmbedFrames(hostile, capture)
  assert.ok(!fixed.includes('<iframe'), `hostile video exemption remained live: ${hostile}`)
}
console.log('PASS: hostile video URL/title/attribute regressions')
const { createEmbedPreviewQueue } = await import('../src/main/embed-preview-queue.ts')
const started = []
const owner = new AbortController()
let release
const queued = createEmbedPreviewQueue((url, signal) => new Promise(resolve => {
  started.push(url)
  release = () => resolve('image')
  signal.addEventListener('abort', () => resolve(null), { once: true })
}), 3)
const obsolete = ['old-1', 'old-2', 'old-3'].map(url => queued(url, owner.signal))
assert.equal(await queued('over-budget'), null, 'active plus waiting captures are capped')
assert.deepEqual(started, ['old-1'])
owner.abort()
assert.deepEqual(await Promise.all(obsolete), [null, null, null])
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(started, ['old-1'], 'obsolete waiting captures never start')
const next = queued('new-talk')
assert.deepEqual(started, ['old-1', 'new-talk'], 'new talk proceeds after cancelled active capture')
release()
assert.equal(await next, 'image')
const switchTalk = new AbortController()
let captures = 0
await assert.rejects(() => replaceRemoteEmbedFrames(frame('https://example.org/one') + frame('https://example.org/two'), async () => {
  captures++; switchTalk.abort(); return 'data:image/png;base64,AAAA'
}, switchTalk.signal), /cancelled/)
assert.equal(captures, 1, 'talk cancellation is checked per capture, before a second URL starts')
for (const hostile of [
  '<iframe data-embed-url="https://www.youtube-nocookie.com/embed/abcdefghijk" data-src="https://www.youtube-nocookie.com/embed/abcdefghijk" data-embed-video="1" srcdoc="&lt;script>bad()&lt;/script>"></iframe>',
  '<iframe DATA-EMBED-URL="https://example.org/?data-embed-video=1" TITLE="data-embed-video=1"></iframe>'
]) assert.ok(!(await replaceRemoteEmbedFrames(hostile, capture)).includes('<iframe'))
console.log('PASS: bounded capture queue, obsolete talk cancellation, per-capture stop and parsed override attributes')
let obsoleteDeck = false, deckCaptures = 0
await assert.rejects(() => replaceRemoteEmbedFrames(frame('https://example.org/one') + frame('https://example.org/two'), async () => {
  deckCaptures++; obsoleteDeck = true; return 'data:image/png;base64,AAAA'
}, undefined, () => obsoleteDeck), /cancelled/)
assert.equal(deckCaptures, 1, 'thumbnail recency/yield is checked per capture')
const conflictingPlayers = '<iframe data-src="https://player.vimeo.com/video/123" data-embed-url="https://www.youtube-nocookie.com/embed/abcdefghijk" data-embed-video="1"></iframe>'
assert.ok(!(await replaceRemoteEmbedFrames(conflictingPlayers, capture)).includes('<iframe'))
console.log('PASS: obsolete deck yield and conflicting provider attributes')
const { createLatestThumbnailRequestHandler } = await import('../src/main/thumbnail-queue.ts')
let finishOldPreparation, staleRenders = 0
const latestDeck = createLatestThumbnailRequestHandler(() => new Promise(resolve => { finishOldPreparation = resolve }), async () => { staleRenders++; return 'rendered' }, 'cancelled')
const oldPreparation = latestDeck('editor', 'old talk')
latestDeck.cancel('editor')
finishOldPreparation('prepared')
assert.equal(await oldPreparation, 'cancelled')
assert.equal(staleRenders, 0, 'a talk switch during preparation cannot enqueue a new obsolete capture later')
console.log('PASS: cancellation during thumbnail preparation prevents later obsolete capture')
const began=Date.now();let timedOut=false,attempts=0
const bounded=await replaceRemoteEmbedFrames(Array.from({length:8},(_,i)=>frame('https://example.org/'+i)).join(''),(_url,signal)=>{attempts++;signal.addEventListener('abort',()=>timedOut=true);return new Promise(()=>{})},undefined,undefined,40)
assert.ok(Date.now()-began<500,'all eight unavailable frames share one overall deadline')
assert.equal(attempts,1)
assert.equal(timedOut,true,'deadline cancels the underlying queued/active work')
assert.equal((bounded.match(/preview unavailable/g)||[]).length,8)
console.log('PASS: one overall artwork deadline and underlying capture cancellation')
