// Fit parity of the bundled slide faces against Trebuchet MS on the Ocean look (0.44.0's face and main's drawing), in
// this checkout, state by state through every reveal step. For each face the layout sampler (or, with --stress, the
// stressed fixture) is compiled twice: `font: trebuchet` (the reference) and `font: <face>`. A state fails when, in the
// face, it
//   - clips an element the reference does not clip,
//   - becomes `too-long` where the reference is not, or puts text under the 30px floor that the reference keeps above,
//   - draws text smaller or takes a worse fit step than the reference, unless the reference's own sizes and steps,
//     restored in the face, measurably overflow (the face genuinely needs the smaller step).
// Accepted differences are listed in scripts/fixtures/ocean-look/typeface-parity-exceptions.json with their reason;
// each must still occur (a stale exception fails), so the list cannot hide a change.
//
//   node scripts/test-typeface-fit-parity.mjs [--stress] [--faces inter,serif,geist] [--out <dir>]
//
// Classic against main is covered by test:slide-canvas. Outputs (decks, per-state JSON) go to --out, default a temp dir.
import { readFileSync, writeFileSync, statSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { walkSlides } from './lib/slide-readability.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback }
const stress = argv.includes('--stress')
const input = stress ? 'scripts/fixtures/ocean-look/stressed-typefaces-outline.md' : 'docs/layout-sampler-outline.md'
const faces = opt('faces', 'inter,serif,geist').split(',')
const keepOut = opt('out', '')
const out = keepOut ? resolve(keepOut) : mkdtempSync(join(tmpdir(), 'tw-typeface-parity-'))
mkdirSync(out, { recursive: true })
const HARD_TIMEOUT_MS = Number(opt('timeout-ms', stress ? 840000 : 780000))
const timer = setTimeout(() => { console.error(`typeface fit parity: timed out after ${HARD_TIMEOUT_MS} ms`); process.exit(124) }, HARD_TIMEOUT_MS)
const exceptions = JSON.parse(readFileSync('scripts/fixtures/ocean-look/typeface-parity-exceptions.json', 'utf8')).filter((e) => e.input === input)

const withFace = (text, face) => text.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_, fm) => `---\nfont: ${face}\n${fm.replace(/^(?:font|typeface):.*$/gm, '')}\n---`)

// Clipping is measured in canvas pixels (the slide's own 1920-wide units) with one tolerance, CLIP_TOLERANCE, so the
// verdict does not depend on how large the window draws the canvas. Screen-reader text (.sr-only, .qf-sr) is not
// measured; simulations are measured like any other content.
const CLIP_TOLERANCE = 1.5
function clipsNow(t) {
  const s = document.querySelector('.stage > .slide.active'), stage = s.getBoundingClientRect(), scale = stage.width / s.clientWidth, out = []
  for (const e of s.querySelectorAll('*')) {
    if (e.closest('.notes, .sr-only, .qf-sr, iframe, svg') && e.tagName.toLowerCase() !== 'svg') continue
    const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
    const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) continue
    const left = (r.left - stage.left) / scale, top = (r.top - stage.top) / scale, right = (r.right - stage.left) / scale, bottom = (r.bottom - stage.top) / scale
    const outside = left < -t || top < -t || right > s.clientWidth + t || bottom > s.clientHeight + t
    const hides = (['hidden', 'clip'].includes(cs.overflowX) && e.scrollWidth > e.clientWidth + t) || (['hidden', 'clip'].includes(cs.overflowY) && e.scrollHeight > e.clientHeight + t)
    if (outside || hides) out.push(`${e.tagName.toLowerCase()}|${(e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48) || [...e.classList].slice(0, 2).join('.')}`)
  }
  return out.sort()
}

const fitted = n => n.size * n.zoom * (n.transformScale ?? 1);
async function metrics(page){return page.evaluate(()=>{
 const s=document.querySelector('.stage>.slide.active'),c=s.querySelector('.slide-content'),stage=s.getBoundingClientRect(),scale=stage.width/s.clientWidth;
 const path=e=>{const a=[];while(e!==s){a.push([...e.parentElement.children].indexOf(e));e=e.parentElement}return a.reverse().join('/')};
 const all=[...s.querySelectorAll('*')];
 const list=all.filter(e=>!e.closest('.notes,.sr-only,iframe,svg')&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&e.getBoundingClientRect().height&&getComputedStyle(e).visibility!=='hidden'&&Number(getComputedStyle(e).opacity)!==0);
 const transformScale=e=>{let total=1;for(let node=e;node&&node!==s;node=node.parentElement){const value=getComputedStyle(node).transform;if(value!=='none'){const matrix=new DOMMatrixReadOnly(value);total*=Math.hypot(matrix.a,matrix.b)}}return total};
 const fitNodes=all.filter(e=>e.matches('[data-quote-fit],[data-code-fit],[data-question-fit],.qf[data-step]')).map(e=>({path:path(e),fit:Object.fromEntries(Object.entries(e.dataset).filter(([key])=>['quoteFit','codeFit','questionFit','step','qfScaled'].includes(key)))}));
 const transforms=all.filter(e=>e.style?.transform).map(e=>({path:path(e),transform:e.style.transform,origin:e.style.transformOrigin}));
 return {fit:{...c?.dataset},fitNodes,transforms,inline:c?.getAttribute('style')||'',nodes:list.map(e=>({path:path(e),sim:!!e.closest('.sim'),size:parseFloat(getComputedStyle(e).fontSize),transformScale:transformScale(e),painted:parseFloat(getComputedStyle(e).fontSize)*(parseFloat(getComputedStyle(c).zoom)||1)*scale*transformScale(e),zoom:parseFloat(getComputedStyle(c).zoom)||1,top:(e.getBoundingClientRect().top-stage.top)/scale,bottom:(e.getBoundingClientRect().bottom-stage.top)/scale}))};
})}
async function largerOverflows(page,baseline){return page.evaluate(({base,t})=>{
 const s=document.querySelector('.stage>.slide.active'),c=s.querySelector('.slide-content'),stage=s.getBoundingClientRect(),save=[];
 for(const n of base.nodes){let e=s;for(const i of n.path.split('/'))e=e?.children[+i];if(!e)continue;save.push([e,e.getAttribute('style')]);e.style.setProperty('font-size',n.size+'px','important')}
 const atPath=path=>{let e=s;for(const i of path.split('/'))e=e?.children[+i];return e};
 const attrs=[];
 for(const record of base.fitNodes||[]){const e=atPath(record.path);if(e&&e.matches('.qf')){attrs.push([e,e.getAttribute('data-step')]);if(record.fit.step)e.setAttribute('data-step',record.fit.step)}}
 for(const e of s.querySelectorAll('*'))if(e.style?.transform){save.push([e,e.getAttribute('style')]);e.style.removeProperty('transform');e.style.removeProperty('transform-origin')}
 for(const record of base.transforms||[]){const e=atPath(record.path);if(!e)continue;save.push([e,e.getAttribute('style')]);e.style.transform=record.transform;e.style.transformOrigin=record.origin}
 const oldStyle=c.getAttribute('style');c.setAttribute('style',base.inline);
 const k=stage.width/s.clientWidth;let bad=false;for(const e of s.querySelectorAll('*')){if(e.closest('.notes,.sr-only,.qf-sr,iframe,svg'))continue;const st=getComputedStyle(e),r=e.getBoundingClientRect();if(!r.height||st.visibility==='hidden'||+st.opacity===0)continue;if((r.top-stage.top)/k<-t||(r.bottom-stage.top)/k>s.clientHeight+t||(r.left-stage.left)/k<-t||(r.right-stage.left)/k>s.clientWidth+t||(['hidden','clip'].includes(st.overflowY)&&e.scrollHeight>e.clientHeight+t)||(['hidden','clip'].includes(st.overflowX)&&e.scrollWidth>e.clientWidth+t)){bad=true;break}}
 const cs=getComputedStyle(s),style=getComputedStyle(c),availH=s.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom),availW=s.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);
 for(const h1 of c.querySelectorAll('h1:not(.sr-only)')) {const r=h1.getBoundingClientRect(),head=h1.closest('.slide-head');bad ||= h1.scrollWidth>h1.clientWidth+t;if(s.dataset.titleLayout==='left'&&head)bad ||= (r.right-head.getBoundingClientRect().right)/k+parseFloat(getComputedStyle(head).paddingRight)>t;const range=document.createRange();range.selectNodeContents(h1.querySelector('.title-text')||h1);bad ||= new Set([...range.getClientRects()].filter(r=>r.width>.5&&r.height>.5).map(r=>Math.round(r.top/(stage.width/s.clientWidth)/4))).size>5;}
 if(c.querySelector(':scope > .feature-list,:scope > ul,:scope > ol,:scope > .timeline-rail,:scope > .slide-table,:scope > .columns-grid')) {let top=Infinity,bottom=-Infinity;for(const child of c.children){if(child.classList.contains('slide-head')&&s.dataset.titleLayout==='left')continue;const targets=child.classList.contains('timeline-rail')?[...child.querySelectorAll(':scope > .tl-group')]:[child.classList.contains('slot')?child.querySelector('.slot-copy')||child:child];for(const node of targets){const r=node.getBoundingClientRect();if(!r.height)continue;top=Math.min(top,r.top);bottom=Math.max(bottom,r.bottom)}}bad ||= Math.ceil((bottom-top)/(stage.width/s.clientWidth))>Math.floor(availH-(parseFloat(style.paddingTop)||0)-(parseFloat(style.paddingBottom)||0));}
 if(c.classList.contains('layout-statement')){const old=c.style.minHeight;c.style.minHeight='0';bad ||= c.scrollHeight>Math.ceil(availH)||c.scrollWidth>Math.ceil(availW);c.style.minHeight=old;const paragraphs=[...c.querySelectorAll(':scope > p:not(.kicker):not(.slide-source)')].map(p=>p.getBoundingClientRect());if(s.dataset.titleLayout==='hidden'&&paragraphs.length)bad ||= (Math.max(...paragraphs.map(r=>r.bottom))-Math.min(...paragraphs.map(r=>r.top)))/(stage.width/s.clientWidth)>.72*s.parentElement.clientHeight+.5;}
 for(const panel of c.querySelectorAll(':scope > blockquote,.image-quote blockquote')){const host=panel.closest('.image-quote')||panel;bad ||= host.scrollHeight>s.parentElement.clientHeight-(parseFloat(cs.getPropertyValue('--quote-chrome-band'))||59)-2*parseFloat(cs.paddingTop)+t;}
 for(const figure of c.querySelectorAll('.qf')){const [selector,max]=figure.matches('.qf-paper:not(.qf-side)')?['.qf-page',980]:figure.matches('.qf-tweet')?['.qf-x-card',900]:figure.matches('.qf-side')?['.qf-body-in',864]:figure.matches('.qf-video')?['.qf-yt-captions',400]:figure.matches('.qf-web')?['.qf-web-win',940]:['',0];const box=selector&&figure.querySelector(selector);if(box)bad ||= Math.max(box.getBoundingClientRect().height,figure.matches('.qf-paper:not(.qf-side)')?box.scrollHeight*k:0)/k>max+t;}
 if(oldStyle===null)c.removeAttribute('style');else c.setAttribute('style',oldStyle);for(const [e,step] of attrs){if(step===null)e.removeAttribute('data-step');else e.setAttribute('data-step',step)}for(const [e,style] of save.reverse()){if(style===null)e.removeAttribute('style');else e.setAttribute('style',style)}return bad;
},{base:baseline,t:CLIP_TOLERANCE})}

const rank = { base: 0, leading: 1, gap: 2, date: 2, fallback: 1, stepped: 1, type: 3, 'too-long': 4 }
const severity = (fit) => Math.max(...['listFit', 'textFit', 'statementFit'].map((k) => rank[fit[k]] || 0))

async function compileFace(face) {
  const path = resolve(input)
  const model = await prepareSource(path, withFace(readFileSync(path, 'utf8'), face), `parity-${face}`, statSync(path), undefined,
    { allowedAssetRoots: [dirname(path), resolve('docs'), resolve('e2e/fixtures'), resolve('scripts/fixtures')] })
  const html = join(out, `${face}.html`)
  writeFileSync(html, String(model.fullHtml))
  return html
}

async function walkFace(face, reference) {
  const states = {}
  const coverage = await walkSlides(await compileFace(face), async (page, state) => {
    const got = await metrics(page)
    got.clips = await page.evaluate(clipsNow, CLIP_TOLERANCE)
    const base = reference?.[state.at]
    if (base) {
      const sizeOf = new Map(base.nodes.map((b) => [b.path, b]))
      got.smaller = got.nodes.some((n) => { const b = sizeOf.get(n.path); return b && fitted(n) < fitted(b) - 0.1 })
      got.worse = severity(got.fit) > severity(base.fit) || got.fitNodes.some((node) => {
        const previous = base.fitNodes.find((b) => b.path === node.path)
        return previous && Object.entries(node.fit).some(([key, value]) => key === 'step' ? +value > +(previous.fit.step || value) : previous.fit[key] !== undefined && (rank[value] || 0) > (rank[previous.fit[key]] || 0))
      })
      got.tooLong = ['listFit', 'textFit', 'statementFit'].some((k) => got.fit[k] === 'too-long' && base.fit[k] !== 'too-long')
      got.newFloor = got.nodes.some((n) => n.painted < 29.9 && base.nodes.some((b) => b.path === n.path && b.painted >= 29.9))
      const was = new Map(); for (const k of base.clips) was.set(k, (was.get(k) ?? 0) + 1)
      got.newClips = got.clips.filter((k) => { const n = was.get(k) ?? 0; if (n > 0) { was.set(k, n - 1); return false } return true })
      got.overflowAtReference = (got.smaller || got.worse) ? await largerOverflows(page, base) : false
    }
    states[state.at] = got
  }, { settleMs: 140 })
  if (coverage.issues.length) throw new Error(`${face}: walk incomplete: ${coverage.issues.slice(0, 5).join('; ')}`)
  return states
}

const problems = []
const summary = {}
try {
  const reference = await walkFace('trebuchet')
  for (const face of faces) {
    const states = await walkFace(face, reference)
    const missing = Object.keys(reference).filter((at) => !(at in states))
    const found = []
    for (const [at, s] of Object.entries(states)) {
      if (!(at in reference)) { found.push({ at, kind: 'unmatched' }); continue }
      for (const key of s.newClips) found.push({ at, kind: 'clip', detail: key })
      if (s.tooLong) found.push({ at, kind: 'too-long' })
      if (s.newFloor) found.push({ at, kind: 'floor' })
      if ((s.smaller || s.worse) && !s.overflowAtReference) found.push({ at, kind: s.worse ? 'worse' : 'smaller' })
    }
    for (const at of missing) found.push({ at, kind: 'missing' })
    const accepted = exceptions.filter((e) => e.face === face)
    for (const f of found) {
      const ok = accepted.find((e) => e.state === f.at && e.kind === f.kind)
      if (ok) ok.seen = true
      else problems.push(`${face} ${f.at}: ${f.kind}${f.detail ? ` (${f.detail})` : ''}`)
    }
    for (const e of accepted) if (!e.seen) problems.push(`${face} ${e.state}: listed exception (${e.kind}) no longer occurs; remove it`)
    const rows = Object.values(states)
    summary[face] = { states: rows.length, differ: rows.filter((r) => r.smaller || r.worse).length, justified: rows.filter((r) => (r.smaller || r.worse) && r.overflowAtReference).length, problems: found.length, accepted: accepted.length }
    writeFileSync(join(out, `states-${face}.json`), JSON.stringify(states))
    console.log(`${face}: ${JSON.stringify(summary[face])}`)
  }
} finally {
  clearTimeout(timer)
  if (!keepOut) rmSync(out, { recursive: true, force: true })
}
if (problems.length) { console.error(`typeface fit parity (${input}): ${problems.length} problem(s)\n${problems.join('\n')}`); process.exit(1) }
console.log(`typeface fit parity (${input}): ${faces.join(', ')} against Trebuchet on the Ocean look: no new clipping, too-long or sub-floor text, and every smaller or worse fit step is needed by measured overflow (${exceptions.length} listed exception(s) still occur)`)
