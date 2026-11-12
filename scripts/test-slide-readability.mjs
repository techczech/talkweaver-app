// The readability probe (scripts/lib/slide-readability.mjs) must never certify text a person cannot read:
//   1. white type on a black fill under a white gradient image is reported as unresolved (not a pass);
//   2. near-black type on white inside an ancestor at opacity .05 is a contrast fault (every ancestor's opacity counts,
//      opaque fills on the way or not);
//   3. a passed {focus} item is held to 3:1, a blurred not-yet item is skipped;
//   4. plain near-black on white passes, white on a white highlight fails;
//   5. a run covered by a sibling painted over it (a white sheet at .99, a picture) is a fault or unresolved.
import { strict as assert } from 'node:assert'
import { chromium } from 'playwright'
import { readabilityProbe } from './lib/slide-readability.mjs'

const slide = (body) => `<!doctype html><html><head><style>
  html, body { margin: 0; background: #fff; } .stage { width: 1600px; height: 900px; position: relative; }
  .slide { width: 1600px; height: 900px; position: absolute; inset: 0; font: 40px/1.3 sans-serif; color: #16181D; }
  .slide-content { padding: 80px; }
</style></head><body><div class="stage"><section class="slide active" data-id="t"><div class="slide-content">${body}</div></section></div></body></html>`

const browser = await chromium.launch({ headless: true })
const probe = async (body) => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.setContent(slide(body))
  const got = await page.evaluate(readabilityProbe, { floorPx: 30, smallFloorPx: 24 })
  await page.close()
  return got
}
try {
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
  const clear = await probe('<div style="position:relative"><p>Words under a clear layer</p><div style="position:absolute;inset:0"></div></div>')
  assert.equal(clear.contrast.length + clear.unresolved.length, 0, 'a layer that paints nothing over the words changes nothing')
  console.log('PASS slide readability probe: gradients unresolved, ancestor opacity counted, passed items at 3:1, chips caught, covered runs caught')
} finally {
  await browser.close()
}
