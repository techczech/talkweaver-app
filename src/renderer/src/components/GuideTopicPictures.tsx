import type { ReactNode } from 'react'
import type { TopicPicture } from '../../../shared/guide-topics'

// The pictures of How it works, one per topic (onboarding ticket 11; state 09 draws the third; 11 to 15 came with 0.44). Drawn as SVG in the
// app's own look (the paper, line and ink colours, the mono face of the outline editor); nothing here is
// a screenshot. Each is decorative: the topic's sentences say all of it, so every picture is hidden from
// assistive technology.

const MONO = "var(--font-mono, 'JetBrains Mono', monospace)"
const UI = 'var(--font-ui, sans-serif)'

/** A slide thumbnail: a title and a few grey lines, or a big statement. */
function Slide({ x, y, w = 62, h = 38, title, statement, lines = 2, accent }: { x: number; y: number; w?: number; h?: number; title?: string; statement?: string; lines?: number; accent?: boolean }): ReactNode {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={3} fill="#fffdf8" stroke={accent ? 'var(--oxford)' : 'var(--line)'} strokeWidth={accent ? 1.5 : 1} />
      {statement ? (
        <text x={x + w / 2} y={y + h / 2 + 3} textAnchor="middle" fontFamily={UI} fontSize={9} fontWeight={700} fill="var(--ink)">{statement}</text>
      ) : (
        <>
          {title && <text x={x + 6} y={y + 12} fontFamily={UI} fontSize={7.5} fontWeight={700} fill="var(--ink)">{title}</text>}
          {Array.from({ length: lines }, (_, i) => <rect key={i} x={x + 6} y={y + 18 + i * 6} width={w - 12 - i * 10} height={2.5} rx={1} fill="var(--line)" />)}
        </>
      )}
    </g>
  )
}

function Code({ x, y, w, rows, hl }: { x: number; y: number; w: number; rows: string[]; hl?: number }): ReactNode {
  return (
    <g>
      <rect x={x} y={y} width={w} height={rows.length * 14 + 10} rx={4} fill="#fffdf8" stroke="var(--line)" />
      {rows.map((row, i) => (
        <g key={i}>
          {hl === i && <rect x={x + 5} y={y + 6 + i * 14} width={w - 10} height={13} rx={2} fill="var(--hover)" />}
          <text x={x + 9} y={y + 16 + i * 14} fontFamily={MONO} fontSize={8.5} fill={row.startsWith('#') ? 'var(--oxford)' : 'var(--ink)'} fontWeight={row.startsWith('#') ? 700 : 400}>{row}</text>
        </g>
      ))}
    </g>
  )
}

const Arrow = ({ x, y }: { x: number; y: number }): ReactNode => (
  <path d={`M${x} ${y} h22 m-5 -5 l5 5 l-5 5`} fill="none" stroke="var(--oxford)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
)

const Folder = ({ x, y, label, fill = '#fffdf8' }: { x: number; y: number; label: string; fill?: string }): ReactNode => (
  <g>
    <path d={`M${x} ${y + 5} a3 3 0 0 1 3 -3 h9 l4 4 h20 a3 3 0 0 1 3 3 v19 a3 3 0 0 1 -3 3 h-33 a3 3 0 0 1 -3 -3 z`} fill={fill} stroke="var(--line)" />
    <text x={x + 19} y={y + 41} textAnchor="middle" fontFamily={UI} fontSize={7.5} fill="var(--muted)">{label}</text>
  </g>
)

const PICTURES: Record<TopicPicture, () => ReactNode> = {
  // One outline file, and what is made from it.
  outline: () => (
    <>
      <Code x={10} y={14} w={118} rows={['## 01 Stalls', '### Four stalls', '### Opening hours', '### Who runs it']} />
      <Arrow x={138} y={55} />
      <Slide x={168} y={14} title="Four stalls" />
      <Slide x={238} y={14} title="Opening hours" />
      <rect x={168} y={60} width={62} height={38} rx={3} fill="#fffdf8" stroke="var(--line)" />
      <text x={199} y={83} textAnchor="middle" fontFamily={UI} fontSize={8} fill="var(--muted)">Handout</text>
      <rect x={238} y={60} width={62} height={38} rx={3} fill="#fffdf8" stroke="var(--line)" />
      <text x={269} y={83} textAnchor="middle" fontFamily={UI} fontSize={8} fill="var(--muted)">Presenter</text>
    </>
  ),
  // A vault: a folder of talk folders.
  vault: () => (
    <>
      <rect x={10} y={10} width={310} height={90} rx={6} fill="none" stroke="var(--oxford)" strokeDasharray="4 3" />
      <text x={20} y={26} fontFamily={UI} fontSize={8.5} fontWeight={700} fill="var(--oxford)">Vault</text>
      <Folder x={24} y={38} label="Market" />
      <Folder x={84} y={38} label="Garden" />
      <Folder x={144} y={38} label="Old town" />
      <rect x={210} y={40} width={96} height={42} rx={3} fill="#fffdf8" stroke="var(--line)" />
      <text x={218} y={54} fontFamily={UI} fontSize={7.5} fontWeight={700} fill="var(--ink)">Kept by TalkWeaver</text>
      <text x={218} y={66} fontFamily={UI} fontSize={7.5} fill="var(--muted)">deliveries</text>
      <text x={218} y={76} fontFamily={UI} fontSize={7.5} fill="var(--muted)">slide history</text>
    </>
  ),
  // The headings sentence: the three lines of an outline, and the statement slide they make (state 09).
  headings: () => (
    <>
      <Code x={12} y={14} w={122} rows={['### Four stalls', '{statement}', 'Bread, veg, plants,', 'books']} hl={1} />
      <Arrow x={146} y={55} />
      <rect x={180} y={14} width={140} height={78} rx={3} fill="#fffdf8" stroke="var(--line)" />
      <rect x={180} y={14} width={40} height={78} rx={3} fill="#d6ece8" />
      <text x={186} y={50} fontFamily={UI} fontSize={9} fontWeight={800} fill="var(--ink)">Four</text>
      <text x={186} y={61} fontFamily={UI} fontSize={9} fontWeight={800} fill="var(--ink)">stalls</text>
      <text x={228} y={51} fontFamily={UI} fontSize={7.5} fill="var(--muted)"><tspan x={228} dy={0}>Bread, veg, plants,</tspan><tspan x={228} dy={10}>books</tspan></text>
    </>
  ),
  // One slide in four layouts; one flagged, none shrunk.
  layouts: () => (
    <>
      <Slide x={12} y={12} w={70} h={42} title="Four stalls" lines={3} />
      <Slide x={92} y={12} w={70} h={42} statement="Four stalls" />
      <rect x={172} y={12} width={70} height={42} rx={3} fill="#fffdf8" stroke="var(--line)" />
      {[0, 1, 2, 3].map((i) => <rect key={i} x={180 + (i % 2) * 28} y={20 + Math.floor(i / 2) * 15} width={24} height={11} rx={2} fill="var(--hover)" stroke="var(--line)" />)}
      <rect x={252} y={12} width={70} height={42} rx={3} fill="#fffdf8" stroke="var(--amber)" strokeWidth={1.5} />
      <text x={287} y={36} textAnchor="middle" fontFamily={UI} fontSize={8} fontWeight={700} fill="var(--amber)">Too long</text>
      <text x={12} y={72} fontFamily={UI} fontSize={8} fill="var(--muted)">List</text>
      <text x={92} y={72} fontFamily={UI} fontSize={8} fill="var(--muted)">Statement</text>
      <text x={172} y={72} fontFamily={UI} fontSize={8} fill="var(--muted)">Cards</text>
      <text x={252} y={72} fontFamily={UI} fontSize={8} fill="var(--amber)">Flagged, not shrunk</text>
      <text x={12} y={96} fontFamily={MONO} fontSize={8.5} fill="var(--oxford)">⌘L</text>
      <text x={34} y={96} fontFamily={UI} fontSize={8} fill="var(--muted)">shows your own slide in each</text>
    </>
  ),
  // One slide, two talks.
  identity: () => (
    <>
      <rect x={12} y={14} width={96} height={30} rx={3} fill="#fffdf8" stroke="var(--line)" />
      <text x={20} y={33} fontFamily={UI} fontSize={8.5} fontWeight={700} fill="var(--ink)">The Saturday market</text>
      <rect x={12} y={62} width={96} height={30} rx={3} fill="#fffdf8" stroke="var(--line)" />
      <text x={20} y={81} fontFamily={UI} fontSize={8.5} fontWeight={700} fill="var(--ink)">Garden notes</text>
      <path d="M108 29 C140 29 140 55 168 55 M108 77 C140 77 140 55 168 55" fill="none" stroke="var(--oxford)" strokeWidth={1.4} />
      <Slide x={168} y={36} w={72} h={42} title="Opening hours" accent />
      <text x={250} y={50} fontFamily={UI} fontSize={8} fontWeight={700} fill="var(--oxford)">One slide</text>
      <text x={250} y={62} fontFamily={UI} fontSize={8} fill="var(--muted)">used in 2 talks</text>
      <text x={250} y={74} fontFamily={UI} fontSize={8} fill="var(--muted)">2 versions</text>
    </>
  ),
  // A pathway: the same slides, ticked.
  pathways: () => (
    <>
      {[0, 1, 2, 3, 4, 5].map((i) => <Slide key={i} x={10 + i * 52} y={14} w={46} h={30} title={`Slide ${i + 1}`} lines={1} accent={[0, 2, 3, 5].includes(i)} />)}
      {[0, 2, 3, 5].map((i) => (
        <g key={i}>
          <circle cx={10 + i * 52 + 38} cy={21} r={5} fill="var(--green)" />
          <path d={`M${10 + i * 52 + 35.5} 21 l1.8 1.8 l3.2 -3.4`} fill="none" stroke="#fff" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ))}
      <text x={10} y={68} fontFamily={UI} fontSize={8.5} fontWeight={700} fill="var(--ink)">Full talk: 30 minutes</text>
      <text x={10} y={84} fontFamily={UI} fontSize={8.5} fontWeight={700} fill="var(--oxford)">Ten minutes: the ticked four</text>
      <text x={10} y={98} fontFamily={UI} fontSize={8} fill="var(--muted)">Improve a slide once; both versions change.</text>
    </>
  ),
  // Two screens: the presenter's and the audience's.
  presenter: () => (
    <>
      <rect x={12} y={10} width={150} height={88} rx={4} fill="#fffdf8" stroke="var(--line)" />
      <text x={20} y={24} fontFamily={UI} fontSize={8} fontWeight={700} fill="var(--oxford)">Presenter</text>
      <rect x={20} y={30} width={56} height={34} rx={2} fill="var(--hover)" stroke="var(--line)" />
      <text x={86} y={42} fontFamily={MONO} fontSize={11} fontWeight={700} fill="var(--ink)">08:42</text>
      {[0, 1, 2, 3].map((i) => <rect key={i} x={86} y={50 + i * 5} width={66 - i * 8} height={2.5} rx={1} fill="var(--line)" />)}
      <text x={20} y={80} fontFamily={UI} fontSize={7.5} fill="var(--muted)">Notes and the clock: yours only</text>
      <rect x={178} y={10} width={144} height={88} rx={4} fill="#fffdf8" stroke="var(--line)" />
      <text x={186} y={24} fontFamily={UI} fontSize={8} fontWeight={700} fill="var(--oxford)">Audience</text>
      <rect x={186} y={30} width={128} height={46} rx={2} fill="#d6ece8" />
      <text x={250} y={58} textAnchor="middle" fontFamily={UI} fontSize={11} fontWeight={800} fill="var(--ink)">Four stalls</text>
      <text x={186} y={90} fontFamily={UI} fontSize={7.5} fill="var(--muted)">No notes in the deck or the handout</text>
    </>
  ),
  // Kept deliveries.
  deliveries: () => (
    <>
      {[['26 Sep', 'Rehearsal', '9 min'], ['2 Oct', 'Delivery', '11 min'], ['6 Oct', 'Recording', '10 min']].map(([date, kind, len], i) => (
        <g key={date}>
          <rect x={12} y={12 + i * 30} width={220} height={24} rx={4} fill="#fffdf8" stroke="var(--line)" />
          <text x={22} y={28 + i * 30} fontFamily={MONO} fontSize={8.5} fill="var(--muted)">{date}</text>
          <text x={72} y={28 + i * 30} fontFamily={UI} fontSize={8.5} fontWeight={700} fill="var(--ink)">{kind}</text>
          <text x={190} y={28 + i * 30} fontFamily={UI} fontSize={8.5} fill="var(--muted)">{len}</text>
        </g>
      ))}
      <text x={246} y={32} fontFamily={UI} fontSize={8} fill="var(--oxford)">audio</text>
      <text x={246} y={46} fontFamily={UI} fontSize={8} fill="var(--oxford)">polls</text>
      <text x={246} y={60} fontFamily={UI} fontSize={8} fill="var(--oxford)">questions</text>
      <text x={246} y={74} fontFamily={UI} fontSize={8} fill="var(--oxford)">attached</text>
    </>
  ),
  // One outline, and the handout page built from it.
  handout: () => (
    <>
      <Code x={10} y={14} w={118} rows={['## 01 Stalls', '### Four stalls', '### Opening hours', '### Who runs it']} />
      <Arrow x={138} y={55} />
      <rect x={176} y={10} width={74} height={90} rx={3} fill="#fffdf8" stroke="var(--oxford)" strokeWidth={1.5} />
      <text x={184} y={26} fontFamily={UI} fontSize={8} fontWeight={700} fill="var(--ink)">Handout</text>
      {[0, 1, 2, 3, 4].map((i) => <rect key={i} x={184} y={34 + i * 10} width={58 - (i % 2) * 14} height={3} rx={1} fill="var(--line)" />)}
      <text x={262} y={46} fontFamily={UI} fontSize={7.5} fill="var(--muted)">Share ›</text>
      <text x={262} y={58} fontFamily={UI} fontSize={7.5} fill="var(--muted)">Handout</text>
      <text x={262} y={74} fontFamily={UI} fontSize={7.5} fill="var(--oxford)">Publish to</text>
      <text x={262} y={85} fontFamily={UI} fontSize={7.5} fill="var(--oxford)">Cloudflare</text>
    </>
  ),
  // Your own Cloudflare account, and no TalkWeaver server in between.
  cloudflare: () => (
    <>
      <rect x={12} y={30} width={80} height={46} rx={4} fill="#fffdf8" stroke="var(--line)" />
      <text x={52} y={57} textAnchor="middle" fontFamily={UI} fontSize={9} fontWeight={700} fill="var(--ink)">Your Mac</text>
      <Arrow x={104} y={53} />
      <path d="M232 74 h-52 a14 14 0 0 1 -2 -27.800 a18 18 0 0 1 34 -4 a15 15 0 0 1 20 31.800 z" fill="#fffdf8" stroke="var(--oxford)" strokeWidth={1.4} />
      <text x={206} y={64} textAnchor="middle" fontFamily={UI} fontSize={8} fontWeight={700} fill="var(--oxford)">Your Cloudflare</text>
      <text x={206} y={94} textAnchor="middle" fontFamily={UI} fontSize={8} fill="var(--muted)">no TalkWeaver account or server</text>
    </>
  ),
  // A recording: three layers on one time line, saved with the Run.
  layers: () => (
    <>
      <text x={12} y={18} fontFamily={UI} fontSize={8} fontWeight={700} fill="var(--oxford)">Record  ⇧R</text>
      {[['Slides', 'var(--oxford)'], ['Voice', 'var(--green)'], ['Camera', 'var(--amber)']].map(([name, colour], i) => (
        <g key={name}>
          <text x={12} y={39 + i * 22} fontFamily={UI} fontSize={8} fill="var(--ink)">{name}</text>
          <rect x={58} y={30 + i * 22} width={190} height={13} rx={3} fill="#fffdf8" stroke="var(--line)" />
          {name === 'Slides'
            ? [0, 1, 2, 3].map((s) => <rect key={s} x={60 + s * 47} y={32} width={43} height={9} rx={2} fill="var(--hover)" stroke={colour} strokeWidth={0.8} />)
            : name === 'Voice'
              ? Array.from({ length: 46 }, (_, s) => { const h = 2 + ((s * 7) % 9); return <rect key={s} x={61 + s * 4} y={58.5 - h / 2} width={2} height={h} rx={1} fill={colour} /> })
              : <rect x={60} y={76} width={186} height={9} rx={2} fill="var(--hover)" stroke={colour} strokeWidth={0.8} />}
        </g>
      ))}
      <rect x={262} y={30} width={62} height={57} rx={4} fill="#fffdf8" stroke="var(--oxford)" strokeWidth={1.4} />
      <text x={293} y={54} textAnchor="middle" fontFamily={UI} fontSize={8.5} fontWeight={700} fill="var(--oxford)">Run</text>
      <text x={293} y={67} textAnchor="middle" fontFamily={UI} fontSize={7.5} fill="var(--muted)">three layers</text>
    </>
  ),
  // The editor: transcript words, one cut, one moved slide change; the recording below is untouched.
  studio: () => (
    <>
      <rect x={10} y={8} width={312} height={64} rx={4} fill="#fffdf8" stroke="var(--line)" />
      <text x={18} y={22} fontFamily={UI} fontSize={8} fontWeight={700} fill="var(--oxford)">Four stalls</text>
      <text x={18} y={38} fontFamily={UI} fontSize={8.5} fill="var(--ink)">There are four stalls</text>
      <text x={114} y={38} fontFamily={UI} fontSize={8.5} fill="var(--muted)" textDecoration="line-through">four stalls</text>
      <text x={168} y={38} fontFamily={UI} fontSize={8.5} fill="var(--ink)">on Saturday.</text>
      <text x={18} y={56} fontFamily={UI} fontSize={8} fontWeight={700} fill="var(--oxford)">Opening hours</text>
      <text x={84} y={56} fontFamily={UI} fontSize={7.5} fill="var(--muted)">Moved</text>
      <text x={250} y={22} fontFamily={UI} fontSize={7.5} fill="var(--muted)">Tidy up…</text>
      <text x={250} y={56} fontFamily={UI} fontSize={7.5} fill="var(--muted)">Undo  ⌘Z</text>
      <rect x={10} y={80} width={150} height={20} rx={3} fill="var(--hover)" stroke="var(--line)" />
      <text x={18} y={93} fontFamily={UI} fontSize={7.5} fill="var(--ink)">Edits file: your cuts</text>
      <rect x={172} y={80} width={150} height={20} rx={3} fill="#fffdf8" stroke="var(--line)" />
      <text x={180} y={93} fontFamily={UI} fontSize={7.5} fill="var(--muted)">Recorded files: unchanged</text>
    </>
  ),
  // Export: the edited video with chapters, and the files saved beside it.
  export: () => (
    <>
      <rect x={10} y={10} width={150} height={88} rx={4} fill="#fffdf8" stroke="var(--line)" />
      <rect x={18} y={18} width={134} height={56} rx={2} fill="#1273c4" />
      <text x={85} y={50} textAnchor="middle" fontFamily={UI} fontSize={10} fontWeight={800} fill="#fff">Four stalls</text>
      <rect x={124} y={56} width={24} height={15} rx={2} fill="var(--hover)" stroke="#fff" />
      {[0, 1, 2, 3].map((i) => <rect key={i} x={18 + i * 34} y={82} width={31} height={6} rx={1.5} fill={i === 1 ? 'var(--oxford)' : 'var(--line)'} />)}
      <text x={18} y={96} fontFamily={UI} fontSize={7} fill="var(--muted)">MP4 · a chapter for each slide</text>
      <Arrow x={168} y={54} />
      {['Captions: SRT and WebVTT', 'Chapter list for YouTube', 'Sound only: M4A'].map((name, i) => (
        <g key={name}>
          <rect x={198} y={22 + i * 24} width={124} height={18} rx={3} fill="#fffdf8" stroke="var(--line)" />
          <text x={206} y={34 + i * 24} fontFamily={UI} fontSize={7.5} fill="var(--ink)">{name}</text>
        </g>
      ))}
      <text x={198} y={16} fontFamily={UI} fontSize={7.5} fontWeight={700} fill="var(--oxford)">Also save</text>
    </>
  ),
  // Words written out on this Mac, and precise word timing for cuts.
  transcription: () => (
    <>
      <rect x={12} y={12} width={96} height={60} rx={4} fill="#fffdf8" stroke="var(--line)" />
      <text x={60} y={36} textAnchor="middle" fontFamily={UI} fontSize={9} fontWeight={700} fill="var(--ink)">This Mac</text>
      {Array.from({ length: 18 }, (_, s) => { const h = 3 + ((s * 5) % 11); return <rect key={s} x={24 + s * 4} y={52 - h / 2} width={2} height={h} rx={1} fill="var(--green)" /> })}
      <Arrow x={118} y={42} />
      <rect x={150} y={12} width={172} height={60} rx={4} fill="#fffdf8" stroke="var(--line)" />
      {['There', 'are', 'four', 'stalls'].map((word, i) => (
        <g key={word}>
          <rect x={158 + i * 38} y={26} width={34} height={16} rx={2} fill="var(--hover)" stroke="var(--oxford)" strokeWidth={0.8} />
          <text x={175 + i * 38} y={37} textAnchor="middle" fontFamily={UI} fontSize={8} fill="var(--ink)">{word}</text>
        </g>
      ))}
      <text x={158} y={60} fontFamily={UI} fontSize={7.5} fill="var(--muted)">Each word has its start and end</text>
      <text x={12} y={90} fontFamily={UI} fontSize={7.5} fill="var(--muted)">Built in: macOS 26</text>
      <text x={150} y={90} fontFamily={UI} fontSize={7.5} fill="var(--muted)">Precise word timing: English, Czech</text>
    </>
  ),
  // The same statement slide in three palettes.
  ocean: () => (
    <>
      {[['Ocean', '#1273c4', '#fff'], ['Ocean, bold amber', '#ff9f1c', '#16181d'], ['Classic', '#fffdf8', 'var(--ink)']].map(([name, ground, ink], i) => (
        <g key={name}>
          <rect x={12 + i * 106} y={14} width={96} height={58} rx={3} fill={ground} stroke="var(--line)" />
          {i === 2 && <rect x={12 + i * 106} y={14} width={26} height={58} rx={3} fill="#d6ece8" />}
          <text x={(i === 2 ? 73 : 60) + i * 106} y={47} textAnchor="middle" fontFamily={UI} fontSize={10} fontWeight={800} fill={ink}>Four stalls</text>
          <text x={12 + i * 106} y={86} fontFamily={UI} fontSize={8} fill={i === 0 ? 'var(--oxford)' : 'var(--muted)'} fontWeight={i === 0 ? 700 : 400}>{name}</text>
        </g>
      ))}
      <text x={12} y={100} fontFamily={UI} fontSize={7.5} fill="var(--muted)">Talk tab › Design › Palette</text>
    </>
  )
}

export default function TopicPicture({ picture }: { picture: TopicPicture }): JSX.Element {
  return (
    <svg className="guide-pic" viewBox="0 0 332 108" role="presentation" aria-hidden="true" data-guide-picture={picture}>
      {PICTURES[picture]()}
    </svg>
  )
}
