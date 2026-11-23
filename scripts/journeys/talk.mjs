// The neutral talk the journeys drive: invented content that exercises (title QR with a long address, rotating section colours, a five-stop loop with long
// labels, a six-step {steps} slide, icon rows of two and three panels with detail lines, a long icon
// list beside a title, a carousel of pictures and text cards, a table, a statement, an embedded local
// widget, a mind map, a video, speaker notes and an audience timer on one section).
// makeVault(root) writes it into <root>/vault, with pictures and a video made by the repo's ffmpeg, and returns the paths.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from './lib.mjs'

export const SLUG = 'river-walk'
export const TITLE = 'Planning a river walk'

// Section colours: `{section-colour=…}` on two sections, chosen to differ from the default rotation (blue, amber,
// light, deep-blue, light-amber); `line` adds a talk-level `section-colours:` line.
export const SECTION_OVERRIDES = { 'on-the-path': 'deep-blue', 'tools-for-the-group': 'amber' }
export function outline({ sectionColours = true, line } = {}) {
  const sc = (c) => (sectionColours ? `{section-colour=${c}}\n` : '')
  return `---
title: ${TITLE}
subtitle: A guide for the volunteer walking group
author: Sample presenter
handout_url: https://handouts.walks.example.org/handouts/planning-a-river-walk-for-volunteers
${line ? `section-colours: ${line}\n` : ''}---

## Before the walk
{timer=4m}{timer-audience}

### Why we walk by the river
{statement}{id=why}

Every walk starts with **one good reason**.

:::notes
Open with the reason the group exists: people meet, the river is close, the paths are free.
:::

### The walking year
{cycle}{focus}{id=loop}

- Choosing the route through the water meadows
- Checking the footpaths after the winter floods
- Inviting new walkers from the community centre
- Walking together on the first Saturday
- Writing up what everyone noticed along the way

:::notes
Five stops, long labels: the loop should keep every word whole.
:::

### From first idea to the walk itself
{steps}{reveal}{id=steps}

- Pick a date
- Draft a route
- Walk it alone
- Fix the map
- Tell the group
- Lead the walk

## On the path
${sc('deep-blue')}
### Two things to carry
{iconrow}{id=row2}

- Water {icon=lucide:droplets}
  - A full bottle for every two hours of walking
- Map {icon=lucide:map}
  - Printed, folded, in a plastic sleeve

### Three things to watch
{iconrow}{id=row3}

- Weather {icon=lucide:cloud-rain}
  - Check the forecast the night before
- Ground {icon=lucide:footprints}
  - Mud near the weir after rain
- Light {icon=lucide:sun}
  - Turn back an hour before sunset

:::notes
Three panels with a detail line each.
:::

### What the leader checks before setting off from the car park
{iconlist}{reveal}{id=iconlist}

- Everyone has signed the attendance sheet {icon=lucide:clipboard-check}
- The first-aid kit is complete and dry {icon=lucide:briefcase-medical}
- A phone is charged and has the ranger's number {icon=lucide:phone}
- The slowest walker knows the pace is theirs {icon=lucide:footprints}
- Gates are left as they were found {icon=lucide:door-open}
- Dogs stay on leads near the cattle {icon=lucide:dog}
- Litter goes home in the leader's bag {icon=lucide:trash-2}

## Along the river

### Places on the way
{carousel}{id=carousel}

#### The old mill

![The old mill by the weir](assets/mill.png)

#### What to say at the mill

- The mill ground flour until the floods of the last century
- Ask walkers what they think the wheel powered

#### The footbridge

![The footbridge over the river](assets/bridge.png)

#### What to say at the bridge

- Count the arches together
- Point out the flood marks on the stone

### Walk lengths
{table}{id=table}

| Walk | Distance | Time | Stiles |
| --- | --- | --- | --- |
| Meadow loop | 3 km | 1 hour | 0 |
| Mill and back | 6 km | 2 hours | 2 |
| Long river walk | 11 km | 4 hours | 5 |

:::notes
The long walk needs a second leader.
:::

## Tools for the group
${sc('amber')}
### Try the pace planner
{id=widget}

[Simulation: widgets/pace.html]

### Ask the planner
{chat reveal=steps}{id=sim}

\`\`\`chat
user: How long is the walk to the mill and back?
model-reasoning: The mill and back is six kilometres on flat paths.
bot: About two hours at an easy pace, six kilometres in all.
user: And the long river walk?
bot: Around four hours, with five stiles to cross.
user: Where do we meet?
bot: At the car park by the community centre, at nine.
user: What if it rains?
bot: The walk goes ahead; bring a waterproof and boots.
user: Can dogs come?
bot: Yes, on leads near the cattle and the sheep.
user: Is there a café on the way?
bot: There is one at the mill, open from ten.
user: How steep is the path to the bridge?
bot: Gentle all the way; one short climb at the weir.
user: Who leads the walk?
bot: Two leaders: one at the front and one at the back.
user: What should I bring to eat?
bot: A packed lunch and a flask; we stop at the bridge.
\`\`\`

### Everything a walk needs
{mindmap}{id=mindmap}

- A good walk
  - People
    - Leader
    - Back marker
  - Route
    - Map
    - Gates
  - Kit
    - Water
    - First aid

### A short clip from the last walk
{media}{id=video}

![Ripples on the river](assets/river.mp4)

## After the walk

### Thank you for walking
{statement}{id=close}

See you **on the first Saturday**.

:::notes
Remind people of the date and where the handout lives.
:::
`
}

/** The section each slide belongs to, by the id a Run's slide marks use: the section dividers (named after their
 *  section), the slides under them and the carousel's cards (marked by card while presenting). The title slide
 *  has no section: a chapter there would carry the talk's title. */
export const SECTIONS = {
  'Before the walk': ['before-the-walk', 'why', 'loop', 'steps'],
  'On the path': ['on-the-path', 'row2', 'row3', 'iconlist'],
  'Along the river': ['along-the-river', 'carousel', 'the-old-mill', 'what-to-say-at-the-mill', 'the-footbridge', 'what-to-say-at-the-bridge', 'table'],
  'Tools for the group': ['tools-for-the-group', 'widget', 'sim', 'mindmap', 'video'],
  'After the walk': ['after-the-walk', 'close'],
}
export const SECTION_OF = { 'deck-title': TITLE, ...Object.fromEntries(Object.entries(SECTIONS).flatMap(([title, ids]) => ids.map((id) => [id, title]))) }
/** Slides the journey expects to visit, by id, in deck order (the auto title slide comes first). */
export const SLIDE_IDS = ['why', 'loop', 'steps', 'row2', 'row3', 'iconlist', 'carousel', 'table', 'widget', 'sim', 'mindmap', 'video', 'close']
/** The deck in order, as the handout and the single-file presentation number it: a slide by its id, a section
 *  divider by its section's title (its id is generated). */
export const DECK = [{ id: 'deck-title' }, ...Object.entries(SECTIONS).flatMap(([title, ids]) => [{ section: title }, ...ids.filter((id) => SLIDE_IDS.includes(id)).map((id) => ({ id }))]), { id: 'deck-thanks' }]

/** The deck: the title slide, five section dividers, the thirteen slides above and the closing slide. */
export const EXPECTED_SLIDES = 1 + 5 + SLIDE_IDS.length + 1
/** Slides with steps, as the outline writes them: {focus} on the five-stop loop, {reveal} on the six steps
 *  and the seven-item icon list, and the chat's eighteen steps ({chat reveal=steps}: nine questions, nine
 *  answers, the reasoning line its own step). The deck marks each step element with data-mode-state: hidden,
 *  current, soft, full, fuzzy (written h c s f z). A chat's steps never dim, so its "all full" step folds onto
 *  the last one (collapse; compiler/scripts/lib/09-output-builders.mjs, maxStepFor). */
export const MODE_LETTER = { hidden: 'h', current: 'c', soft: 's', full: 'f', fuzzy: 'z' }
export const STEP_SLIDES = { loop: { mode: 'focus', n: 5 }, steps: { mode: 'reveal', n: 6 }, iconlist: { mode: 'reveal', n: 7 }, sim: { mode: 'reveal', n: 18, collapse: true } }
export const CAROUSEL_CARDS = 4
/** Printed pages: one per slide, one per card on the carousel. */
export const EXPECTED_PRINT_PAGES = EXPECTED_SLIDES - 1 + CAROUSEL_CARDS
/** The step signatures a slide passes through going forwards (see STEP_SLIDES): for {reveal} all hidden, then
 *  each item current in turn with the earlier ones soft, then all full; for {focus} the same from all fuzzy.
 *  With collapse the last item's step is the all-full one. */
export function expectedSteps(id) {
  const s = STEP_SLIDES[id]
  if (!s) return null
  const rest = s.mode === 'reveal' ? 'h' : 'z'
  const seq = [rest.repeat(s.n)]
  for (let k = 1; k <= (s.collapse ? s.n - 1 : s.n); k++) seq.push('s'.repeat(k - 1) + 'c' + rest.repeat(s.n - k))
  seq.push('f'.repeat(s.n))
  return seq
}

const WIDGET = `<!doctype html><html><head><meta charset="utf-8"><title>Pace planner</title>
<style>html,body{margin:0;height:100%;background:rgb(30,110,160);color:#fff;font:28px system-ui;display:grid;place-items:center}
button{font:inherit;padding:.3em .8em}</style></head><body>
<div><div id="mark">Pace planner</div><p>Walkers: <output id="n">8</output></p><button id="b">Add a walker</button></div>
<script>window.__w={raf:0};(function t(){__w.raf++;requestAnimationFrame(t)})();
document.getElementById('b').onclick=()=>{const o=document.getElementById('n');o.textContent=Number(o.textContent)+1}</script>
</body></html>`

export function makeVault(root, opts = {}) {
  const vault = join(root, 'vault')
  const talkDir = join(vault, SLUG)
  mkdirSync(join(talkDir, 'assets'), { recursive: true })
  mkdirSync(join(talkDir, 'widgets'), { recursive: true })
  const outlinePath = join(talkDir, `${SLUG}-outline.md`)
  writeFileSync(outlinePath, outline(opts))
  writeFileSync(join(talkDir, 'widgets', 'pace.html'), WIDGET)
  const gen = (args) => {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { timeout: 60000 })
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
  }
  gen(['-f', 'lavfi', '-i', 'testsrc2=s=1200x800:d=1', '-frames:v', '1', join(talkDir, 'assets', 'mill.png')])
  gen(['-f', 'lavfi', '-i', 'smptebars=s=1200x800:d=1', '-frames:v', '1', join(talkDir, 'assets', 'bridge.png')])
  gen(['-f', 'lavfi', '-i', 'testsrc=s=640x360:r=25:d=4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', join(talkDir, 'assets', 'river.mp4')])
  // A second talk, so the Slide Browser (which leaves out the talk you are on) has slides to show.
  mkdirSync(join(vault, 'winter-walks'), { recursive: true })
  writeFileSync(join(vault, 'winter-walks', 'winter-walks-outline.md'), '---\ntitle: Winter walks\n---\n\n## Short days\n\n### Start early\n\n- Light goes by four\n\n### Dress for the cold\n\n- Layers, a hat and gloves\n')
  return { vault, talkDir, outlinePath }
}
