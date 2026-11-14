// The readability probe (scripts/lib/slide-readability.mjs) must never certify text a person cannot read:
//   1. white type on a black fill under a white gradient image is reported as unresolved (not a pass);
//   2. near-black type on white inside an ancestor at opacity .05 is a contrast fault (every ancestor's opacity counts,
//      opaque fills on the way or not);
//   3. a passed {focus} item is held to 3:1, a blurred not-yet item is skipped;
//   4. plain near-black on white passes, white on a white highlight fails;
//   5. a run covered by a sibling painted over it (a white sheet at .99, a picture) is a fault or unresolved.
//   6. text broken only by <wbr> (or zero-width spaces) is one run whose key is the unbroken text's, so a before and
//      after pair that differ only by break opportunities gates 0; the QR address caption's floor is a counted
//      exclusion, its contrast is still measured; a broken address that really shrinks or loses contrast still gates.
import { strict as assert } from 'node:assert'
import { chromium } from 'playwright'
import { readabilityProbe } from './lib/slide-readability.mjs'
import { newFloorFailures } from './lib/readability-acceptance.mjs'
import { compareTalk, gateOf } from './lib/audit-compare.mjs'

const slide = (body) => `<!doctype html><html><head><style>
  html, body { margin: 0; background: #fff; } .stage { width: 1600px; height: 900px; position: relative; }
  .slide { width: 1600px; height: 900px; position: absolute; inset: 0; font: 40px/1.3 sans-serif; color: #16181D; }
  .slide-content { padding: 80px; }
</style></head><body><div class="stage"><section class="slide active" data-id="t"><div class="slide-content">${body}</div></section></div></body></html>`

const browser = await chromium.launch({ headless: true })
const probe = async (body, outside = '') => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.setContent(slide(body).replace('</body>', `${outside}</body>`))
  const got = await page.evaluate(readabilityProbe, { floorPx: 30, smallFloorPx: 24 })
  await page.close()
  return got
}
try {
  assert.equal(newFloorFailures([{ key: 'neutral-run', px: 25 }], [{ key: 'neutral-run', px: null }]).length, 1, 'R3: a baseline without a numeric measurement cannot waive a floor failure')
  const badge = await probe('<span class="code-lang" style="font-size:10px;color:white;background:white">JS</span>')
  assert.equal(badge.floor.length, 0, 'language badge keeps its named floor exclusion')
  assert.equal(badge.contrast.length, 1, 'language badge still has to pass contrast')
  assert.ok(badge.exclusions.codeLanguageFloor > 0)
  const unpainted = await probe('<div style="opacity:0"><p>Neutral hidden words</p></div>')
  assert.ok(unpainted.exclusions.zeroOpacity > 0, 'opacity-zero exclusions are counted')
  const hiddenBody = await probe('<p style="font-size:10px">Neutral unpainted body words</p>', '<style>body{opacity:0}</style>')
  assert.ok(hiddenBody.exclusions.zeroOpacity > 0, 'body opacity exclusions must also be counted')
  assert.equal(hiddenBody.floor.length, 0, 'unpainted body text is excluded before floor measurement')
  const outside = await probe('<p>Neutral</p>', '<div style="position:absolute;left:80px;top:80px;width:300px;height:200px;z-index:9999;background:white"></div>')
  assert.ok(outside.exclusions.outsideSlidePaint > 0, 'outside-slide paint exclusions are counted')
  assert.equal(outside.contrast.length, 0, 'slide-asset probe excludes the external layer explicitly')
  const split = await probe('<p style="width:1200px;color:white;background:linear-gradient(to right,white 0px,white 300px,black 300px,black 1200px)">Several neutral words across a two colour background</p>')
  assert.ok(split.contrast.length + split.unresolved.length, 'R5: crossing a hard-stop band cannot pass')
  const partial = await probe('<div style="position:relative"><p>Several neutral words across a partial overlay</p><div style="position:absolute;left:0;top:0;width:80px;height:100px;background:white;opacity:.99"></div></div>')
  assert.ok(partial.contrast.length + partial.unresolved.length, 'R5: a partial sibling overlay cannot pass')
  const partialGround = await probe('<div style="position:relative;background:white"><div style="position:absolute;left:200px;top:0;width:800px;height:100px;background:black"></div><p style="position:relative;z-index:1;color:white;width:1200px">Several neutral words across a partial background</p></div>')
  assert.ok(partialGround.contrast.length + partialGround.unresolved.length, 'R5: readable midpoint and overlay intersection cannot certify an unreadable uncovered fragment')
  const partialPicture = await probe('<div style="position:relative"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="position:absolute;left:0;top:0;width:80px;height:100px"><p style="position:relative;z-index:1">Several neutral words across a partial picture background</p></div>')
  assert.ok(partialPicture.unresolved.length, 'R5: a partial picture background is unresolved, never a guessed ratio that the audit discards')
  const childOverlay = await probe('<p style="position:relative">Several neutral words across a partial child overlay<span style="position:absolute;left:0;top:0;width:80px;height:100px;background:white;opacity:.99"></span></p>')
  assert.ok(childOverlay.contrast.length + childOverlay.unresolved.length, 'R5: a painted child over its parent text cannot pass')
  const whiteOnWhite = await probe('<p style="color:#fff;background-color:#000;background-image:linear-gradient(#fff,#fff)">White on a white gradient</p>')
  assert.equal(whiteOnWhite.contrast.length, 1, 'white type on a black fill under a white gradient is a contrast fault (the gradient is what is seen)')
  const gradient = await probe('<p style="color:#fff;background-color:#000;background-image:linear-gradient(#fff,#000)">White on a two-colour gradient</p>')
  assert.equal(gradient.unresolved.length, 1, 'a run over a gradient of several colours is unresolved')
  assert.equal(gradient.contrast.length, 0, 'and is not counted as a pass or a measured ratio')
  const picture = await probe('<p style="color:#fff;background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)">Over a background picture</p>')
  assert.equal(picture.unresolved.length, 1, 'a run over a background picture is unresolved')

  const flat = await probe('<p style="color:#16181D;background-image:linear-gradient(#E8F1FC,#E8F1FC)">On a flat gradient</p>')
  assert.equal(flat.unresolved.length + flat.contrast.length, 0, 'a one-colour gradient is read as its colour (and passes here)')
  const flatBad = await probe('<p style="color:#E8F1FC;background-image:linear-gradient(#E8F1FC,#E8F1FC)">Same colour</p>')
  assert.equal(flatBad.contrast.length, 1, 'and a run in that same colour fails')

  const faint = await probe('<div style="opacity:.05"><div style="background:#fff"><p>Nearly invisible words</p></div></div>')
  assert.equal(faint.contrast.length, 1, 'an ancestor at opacity .05 makes the run fail, past an opaque fill')

  const passedOk = await probe('<ul><li class="mode-el" data-mode-state="soft" style="opacity:.6">A passed point</li></ul>')
  assert.equal(passedOk.contrast.length, 0, 'near-black at .6 on white (4.65:1) passes the 3:1 a passed item needs')
  const passedBad = await probe('<ul><li class="mode-el" data-mode-state="soft" style="opacity:.2">A passed point</li></ul>')
  assert.equal(passedBad.contrast.length, 1, 'a passed item faded to .2 fails')
  const notYet = await probe('<ul><li class="mode-el" data-mode-state="fuzzy" style="opacity:.15;filter:blur(2px)">Not yet</li></ul>')
  assert.equal(notYet.contrast.length, 0, 'a not-yet (blurred) item is skipped')

  const plain = await probe('<p>Plain words</p>')
  assert.equal(plain.contrast.length + plain.unresolved.length, 0, 'near-black on white passes')
  const chip = await probe('<p><strong style="background:#fff;color:#fff">white chip</strong></p>')
  assert.equal(chip.contrast.length, 1, 'white on a white highlight fails')
  const sheet = await probe('<div style="position:relative"><p>Covered words</p><div style="position:absolute;inset:0;background:#fff;opacity:.99"></div></div>')
  assert.equal(sheet.contrast.length + sheet.unresolved.length, 1, 'black words under a white sheet at .99 are a fault')
  const covered = await probe('<div style="position:relative"><p>Words under a picture</p><div style="position:absolute;inset:0;background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)"></div></div>')
  assert.equal(covered.unresolved.length, 1, 'words under a picture drawn over them are unresolved')
  // R5 false unresolved: a label beside a diagram (inside the svg's box, on no painted shape) is measured normally;
  // a label on a painted shape stays unresolved.
  const diagram = '<svg width="600" height="300" style="position:absolute;left:0;top:0"><circle cx="520" cy="220" r="60" fill="#1273C4"/></svg>'
  const besideDiagram = await probe(`<div style="position:relative;height:300px">${diagram}<p style="position:relative;margin:0;color:#16181D">Neutral label</p></div>`)
  assert.equal(besideDiagram.unresolved.length + besideDiagram.contrast.length, 0, 'a dark label beside a diagram, on no painted shape, is measured on the page ground')
  const onDiagram = await probe(`<div style="position:relative;height:300px">${diagram}<p style="position:absolute;left:470px;top:200px;margin:0;font-size:30px;color:#fff">Neutral</p></div>`)
  assert.equal(onDiagram.unresolved.length, 1, 'a label drawn on a diagram shape stays unresolved')
  // visually hidden captions (1px box, clip-path inset(50%), clip rect) are not painted, so not measured
  const hidden = await probe('<p>Neutral visible words</p><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;color:#fff;font-size:10px">Neutral hidden caption</span><span style="position:absolute;clip:rect(0 0 0 0);color:#fff;font-size:10px">Neutral clipped caption</span>')
  assert.equal(hidden.contrast.length + hidden.unresolved.length + hidden.floor.length, 0, 'visually hidden captions are not measured')
  assert.ok(hidden.exclusions.visuallyHidden >= 2, 'and are counted as an exclusion')
  // the enlarge control on a video is media chrome, counted as an exclusion
  const enlarge = await probe('<figure class="slide-figure slide-video" style="position:relative;width:640px;height:360px;margin:0"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="width:640px;height:360px"><button class="video-enlarge" style="position:absolute;right:8px;top:8px;font-size:20px;color:#fff;background:transparent;border:0">⤢</button></figure>')
  assert.equal(enlarge.unresolved.length + enlarge.contrast.length + enlarge.floor.length, 0, 'the enlarge control is not slide text')
  assert.ok(enlarge.exclusions.mediaControl > 0, 'and is counted as an exclusion')
  const clear = await probe('<div style="position:relative"><p>Words under a clear layer</p><div style="position:absolute;inset:0"></div></div>')
  assert.equal(clear.contrast.length + clear.unresolved.length, 0, 'a layer that paints nothing over the words changes nothing')
  // 6. break opportunities do not split a run
  const broken = await probe('<p style="font-size:12px">handouts.fyi/<wbr>neutral/<wbr>k8wf</p>')
  const whole = await probe('<p style="font-size:12px">handouts.fyi/neutral/k8wf</p>')
  assert.equal(broken.floor.length, 1, 'text separated only by <wbr> is one run')
  assert.equal(broken.floor[0].text, 'handouts.fyi/neutral/k8wf', 'with the joined text')
  assert.equal(broken.floor[0].key, whole.floor[0].key, 'and the key the unbroken text had')
  assert.equal(broken.emptyBand, whole.emptyBand, 'and its element still counts as content in the empty band')
  const zw = await probe('<p style="font-size:12px">handouts.fyi/\u200Bneutral/\u200Bk8wf</p>')
  assert.equal(zw.floor[0].key, whole.floor[0].key, 'zero-width spaces are left out of the key')
  const later = await probe('<p style="font-size:12px"><b>Neutral</b> see handouts.fyi/<wbr>k8wf <i>now</i> end</p>')
  const laterWhole = await probe('<p style="font-size:12px"><b>Neutral</b> see handouts.fyi/k8wf <i>now</i> end</p>')
  assert.deepEqual(later.floor.map((r) => r.key), laterWhole.floor.map((r) => r.key), 'runs after a broken one keep their child index')
  // the QR caption as v0.44.0 and main write it, small and ink on white
  const caption = (shown, style = '') => `<figure class="slide-qr"><div style="width:200px;height:200px;background:#000"></div><figcaption class="qr-caption" style="font-size:12px${style}"><a style="color:inherit" href="https://handouts.fyi/k8wf">${shown}</a></figcaption></figure>`
  const qrBefore = await probe(caption('handouts.fyi/k8wf'))
  const qrAfter = await probe(caption('handouts.fyi/<wbr>k8wf'))
  assert.equal(qrAfter.floor.length, 0, 'the QR address caption is left out of the floor')
  assert.ok(qrAfter.exclusions.qrCaptionFloor > 0, 'and counted as an exclusion')
  const qrFaint = await probe(caption('handouts.fyi/<wbr>k8wf', ';color:#ddd'))
  assert.equal(qrFaint.contrast.length, 1, 'its contrast is still measured')
  const state = (got) => ({ at: 's#0', id: 's', step: 0, layout: 'title', clips: [], overlaps: [], autoIcons: 0, visual: 'v0', ...got })
  const side = (got) => ({ states: [state(got)], coverage: { complete: true, issues: [], neverShown: [] } })
  const gate = (b, a) => gateOf(compareTalk(side(b), side(a)))
  assert.equal(gate(qrBefore, qrAfter), 0, 'the neutral QR before/after pair gates 0')
  assert.equal(gate(whole, broken), 0, 'an address that only gained break opportunities gates 0')
  const shrunk = await probe('<p style="font-size:8px">handouts.fyi/<wbr>neutral/<wbr>k8wf</p>')
  assert.equal(gate(whole, shrunk), 1, 'a broken address that really shrinks still gates')
  const fainter = await probe('<p style="font-size:12px;color:#ccc">handouts.fyi/<wbr>neutral/<wbr>k8wf</p>')
  assert.equal(gate(whole, fainter), 1, 'and one that loses contrast still gates')
  assert.equal(gate(qrBefore, qrFaint), 1, 'and so does a QR caption that loses contrast')
  console.log('PASS slide readability probe: gradients unresolved, ancestor opacity counted, passed items at 3:1, chips caught, covered runs caught, <wbr>-broken text one run')
} finally {
  await browser.close()
}
