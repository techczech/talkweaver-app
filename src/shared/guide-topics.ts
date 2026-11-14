// The Guide's How it works and Features to delight you segments (onboarding 0.38.1 ticket 11; locked
// drawing states 08, 09, 10, 11 and 18). Pure data and pure functions.
//
// Owner check 10 Oct: the wording here supersedes HOW and DELIGHT in the drawing's text module. Features
// lists only things a person can do (a key or a menu route); descriptions of how TalkWeaver works are
// How it works topics, which say plainly what TalkWeaver does and, where it applies, what PowerPoint or
// Keynote does. No slogan contrasts (scripts/test-guide-topics.mjs checks the forbidden patterns).
// The section headings are the drawing's. Topic 3's claim is checked against the compiler (lock decision 6).
//
// Read marks live in the Guide's record (guide-learn.ts, `read`): how.N for a How it works topic,
// feature.N for a Features row (N is the row's number in the drawing; rows added later are appended, so a kept mark keeps its row).
import type { GuideLearn } from './guide-learn.ts'

export const TOPIC_STATUS = { none: 'Not opened', read: 'Read' } as const
export const TOPIC_TRY_LABEL = 'Try it'
export const HOW_BAR = 'How it works'
export const CONNECTS_BAR = 'What it connects to'
export const CONNECTS_NOTE = 'What it connects to. States are read from this Mac.'

/** What Try it does: open an example talk in its own window, or run a command that needs no talk open. */
export type TopicTarget =
  | { kind: 'talk'; talk: string }
  | { kind: 'command'; id: TopicCommand }

/** The commands a Try it may run: each opens a view that needs no talk open. */
export type TopicCommand = 'search-talks' | 'history' | 'settings' | 'studio'

export interface TopicTry {
  target: TopicTarget
  /** The bold sentence beside the button. */
  lead: string
  /** What it does, one sentence; backticks mark a trigger. */
  does: string
}

export type TopicPicture = 'outline' | 'vault' | 'headings' | 'layouts' | 'identity' | 'pathways' | 'presenter' | 'deliveries' | 'cloudflare' | 'handout'
  | 'layers' | 'studio' | 'export' | 'transcription' | 'ocean'

export interface HowTopic {
  id: string
  title: string
  sentences: string[]
  picture: TopicPicture
  tryIt: TopicTry
}

const talk = (name: string, lead: string, does: string): TopicTry => ({ target: { kind: 'talk', talk: name }, lead, does })
const command = (id: TopicCommand, lead: string, does: string): TopicTry => ({ target: { kind: 'command', id }, lead, does })

export const HOW_TOPICS: readonly HowTopic[] = [
  {
    id: 'how.1', title: 'A talk is a text outline.', picture: 'outline',
    sentences: [
      'In PowerPoint each presentation is a single file. In TalkWeaver the core is a text outline, and all its assets are in an easy-to-review folder.',
      'You can package and share a presentation as a single HTML file, by exporting it with Share › HTML presentation or by sharing it through Cloudflare with Share › Share for comments.'
    ],
    tryIt: talk('The Saturday market', 'Open The Saturday market.', 'Opens the example talk in its own window: one folder, one outline, every slide a heading in it.')
  },
  {
    id: 'how.2', title: 'A vault is a folder of talks.', picture: 'vault',
    sentences: [
      'Each talk is a folder that holds its outline and its assets, and you can open it in Finder like any other folder.',
      'A vault is a folder of talks, and you can have several vaults. TalkWeaver also keeps delivery records and slide history in the vault.'
    ],
    tryIt: command('search-talks', 'Show the Talks panel.', 'Shows the list of talks, where each vault lists its own.')
  },
  {
    id: 'how.3', title: 'Headings become slides.', picture: 'headings',
    sentences: [
      'Each heading in the outline becomes a slide. A word in braces on the line under a heading picks its layout: `{statement}` makes a statement slide.',
      'In PowerPoint you add each slide and place its boxes by hand. In TalkWeaver you type the headings and the slides are made from them.'
    ],
    tryIt: talk('The Saturday market', 'Open the Start here slide.', 'Opens the example talk, whose Start here slide is a statement slide: `{statement}` sits under its heading.')
  },
  {
    id: 'how.4', title: 'You choose a layout for each slide.', picture: 'layouts',
    sentences: [
      'Press ⌘L to see your own slide in each layout and pick one. In PowerPoint you move boxes around a template to fit your text.',
      'In TalkWeaver a slide whose text does not fit its layout is flagged, and the text is not shrunk to fit.'
    ],
    tryIt: talk('The Saturday market', 'Open The Saturday market.', 'Opens the example talk. Put the caret on any slide and press ⌘L to see it in each layout.')
  },
  {
    id: 'how.5', title: 'A slide keeps its identity.', picture: 'identity',
    sentences: [
      'When you reuse a slide in another talk, TalkWeaver records where it is used and keeps its versions.',
      'A slide copied in PowerPoint has no record of where it came from.'
    ],
    tryIt: talk('Garden notes', 'Open Garden notes.', 'Opens the example talk that shares three slides with The Saturday market.')
  },
  {
    id: 'how.6', title: 'A pathway is a shorter version of a talk.', picture: 'pathways',
    sentences: [
      'A pathway is a ticked list of slides from the same talk, such as a 20-minute version of an hour-long talk.',
      'When you improve a slide, every pathway that includes it shows the change. In PowerPoint a shorter version is usually a duplicate of the whole deck.'
    ],
    tryIt: talk('Walking the old town', 'Open Walking the old town.', 'Opens the example talk that has a ten-minute pathway.')
  },
  {
    id: 'how.7', title: 'Presenter and audience are separate.', picture: 'presenter',
    sentences: [
      'Speaker notes and the clock appear only in the presenter window. They are not written into the audience deck, the handout or what you share for comments. The “share with notes” file from Build variants includes them on purpose.',
      'In PowerPoint and Keynote the speaker notes are saved in the presentation file.'
    ],
    tryIt: talk('Lightning round', 'Open Lightning round.', 'Opens the example talk, whose slides carry speaker notes.')
  },
  {
    id: 'how.8', title: 'Every delivery is kept.', picture: 'deliveries',
    sentences: [
      'A run through the presenter can be saved as a delivery, a rehearsal or a recording, with its audio, polls and questions attached.',
      'Tools › Runs lists them. PowerPoint can record a presentation and export it as a video, but it keeps no record of when and where you gave the talk.'
    ],
    tryIt: command('history', 'Open TalkWeaver Runs.', 'Opens the Runs view, where each kept delivery is listed.')
  },
  {
    id: 'how.9', title: 'No TalkWeaver account or server.', picture: 'cloudflare',
    sentences: [
      'Publishing, going live and sharing run in your own Cloudflare account.',
      'TalkWeaver has no account of its own and no server that holds your talks.'
    ],
    tryIt: command('settings', 'Open Settings.', 'Opens Settings, where Publishing holds your own Cloudflare account.')
  },
  {
    id: 'how.10', title: 'The handout is made from the outline.', picture: 'handout',
    sentences: [
      'Share › Handout builds a handout from the talk’s outline, and Share › Publish to Cloudflare puts it online at a link you can give out.',
      'Because the handout and the slides are built from the same outline, they match each time you build them. In PowerPoint a handout is a separate export.'
    ],
    tryIt: talk('The Saturday market', 'Open The Saturday market.', 'Opens the example talk, whose Share menu builds and publishes its handout.')
  },
  // Topics 11 to 15 (0.44): recording, the Studio editor, export, transcription and the Ocean look. Facts and
  // labels match talkweaver.app/guide (recording, studio, exporting, transcription, slide-look) and the code.
  {
    id: 'how.11', title: 'A recording is kept in layers.', picture: 'layers',
    sentences: [
      'In the presenter view, choose Slides and voice or Slides, voice and camera, then choose Record or press ⇧R.',
      'TalkWeaver records the slides, your voice and the camera as separate layers and saves them with the Run. The slides layer shows only your slides, never your desktop.'
    ],
    tryIt: talk('Lightning round', 'Open Lightning round.', 'Opens the example talk. In its presenter view, Record starts a recording after a 3, 2, 1 countdown.')
  },
  {
    id: 'how.12', title: 'Studio edits a recording without changing it.', picture: 'studio',
    sentences: [
      // Record one slide again is off in 0.44.5 (recording-takes.ts, takesEnabled). When it ships, the first
      // sentence ends "…, leave a slide out, and use Record this slide again to record one slide anew and then
      // Use this take or Use the first take." and the second says "…camera files, and every take, are never changed."
      'In Tools › TalkWeaver Studio…, select a Run and choose Edit video. You can trim the start and end, cut words from the transcript, apply the cuts Tidy up… suggests, move a slide change and leave a slide out.',
      'Every edit is saved in a separate edits file, and Undo takes it back; the recorded slides, voice and camera files are never changed.'
    ],
    tryIt: command('studio', 'Open TalkWeaver Studio.', 'Opens Studio, which lists the Runs you have recorded.')
  },
  {
    id: 'how.13', title: 'A video is made from the edited recording.', picture: 'export',
    sentences: [
      'In Studio, Export video… makes an MP4 that follows your edits, with a chapter for each slide.',
      'Under Also save, you can tick Captions file (SRT and WebVTT), Chapter list to paste into YouTube and Sound only (M4A).',
      'Look and sound… in the editor has Smooth each join with a quick fade, so your face does not jump, and Even out the volume. The Camera switch in the player puts your camera in the video or leaves it out, and Face: corner on a slide chooses where it appears there: In the corner, Side by side, Face only or Slide only.'
    ],
    tryIt: command('studio', 'Open TalkWeaver Studio.', 'Opens Studio. Select a recorded Run and choose Export video… to see what it saves.')
  },
  {
    id: 'how.14', title: 'Your words are written out on this Mac.', picture: 'transcription',
    sentences: [
      'In Settings › Recording, the Words written out by setting chooses the engine. This Mac (built in) needs macOS 26, and on an older Mac you set up an engine in Settings › Get started › Transcription.',
      'Precise word timing places cuts on word boundaries in English and Czech and needs macOS 14 or newer. Without it, cuts snap to clear pauses.'
    ],
    tryIt: command('settings', 'Open Settings.', 'Opens Settings, where Recording holds Words written out by, Language for words and Precise word timing.')
  },
  {
    id: 'how.15', title: 'Slides use the Ocean look.', picture: 'ocean',
    sentences: [
      'Every talk you compile uses the Ocean look, including talks made before, and your outline stays as it is.',
      'In the Talk tab, Design › Palette has four choices: Ocean; Ocean, bold amber; Classic, the earlier look; and Green (classic).',
      'A slide that does not fit the Ocean arrangement falls back to the earlier arrangement in the new colours, and a slide that still does not fit is flagged.'
    ],
    tryIt: talk('The Saturday market', 'Open The Saturday market.', 'Opens the example talk in the Ocean look. Its Talk tab holds Design › Palette.')
  }
]

export const isHowTopicId = (value: unknown): value is string => typeof value === 'string' && HOW_TOPICS.some((topic) => topic.id === value)

// ── Features to delight you ─────────────────────────────────────────────────────────────────────

export interface FeatureRow { id: string; n: number; title: string; hint: string }
export interface FeatureGroup { /** A small heading above the rows ("Without any connection"), or null. */ sub: string | null; rows: FeatureRow[] }
export interface FeatureSection { n: number; title: string; groups: FeatureGroup[] }

type Source = ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]>
const FEATURE_SOURCE: Source = [
  ['What presentations are', [
    ['Make a table, chart, mindmap or diagram from plain text.', 'Insert menu'],
    ['Ask why a slide looks the way it does.', '⌘K, Explain rendering'],
    ['Search the slides of every talk at once and insert one.', '⌘S, ⇧⌘S']
  ]],
  ['How you present', [
    ['sub', 'Without any connection'],
    ['Reveal a slide step by step, focus on one part, highlight text.', 'R, F, H'], ['Start the timer, set its duration and open the outline.', 'P, T, O'], ['Scroll your notes like a teleprompter.', 'View menu'],
    ['Paste an image or text from the clipboard to show it at once.', '⌘V, ⌥⌘I'], ['Open an image gallery, play media, take a video or an embedded page full screen.', 'Z, M, V'],
    ['sub', 'Live, if you choose to connect'],
    ['Open a poll for the room and show its results.', 'Q, K, ⇧Q'], ['Read the questions the audience has sent.', 'A'], ['Copy a link that shows your slides on a venue screen without your laptop.', 'Copy venue-screen link'], ['Show a QR code for the audience link from any slide.', 'U']
  ]],
  ['What you can do with a presentation afterwards', [
    ['Record the talk and keep the recording.', '⇧R, Tools › Studio'], ['Publish the handout to Cloudflare.', 'Share menu'],
    ['Send a talk to colleagues for comments.', 'Share menu'], ['Make a shorter version without copying any slides.', '⌘⌥P'],
    ['Edit a recording: trim it, cut words, move a slide change.', 'Tools › Studio'],
    ['Export a video with chapters, captions and a YouTube chapter list.', 'Studio › Export video…']
  ]]
]

/** The fourth section: its rows are What it connects to (guide-connections.ts). */
export const CONNECTIONS_SECTION_TITLE = 'How you connect, and what each needs'

function buildSections(): FeatureSection[] {
  let n = 0
  const sections: FeatureSection[] = FEATURE_SOURCE.map(([title, items], index) => {
    const groups: FeatureGroup[] = []
    let current: FeatureGroup = { sub: null, rows: [] }
    for (const [a, b] of items) {
      if (a === 'sub') { if (current.rows.length || current.sub) groups.push(current); current = { sub: b, rows: [] }; continue }
      n += 1
      current.rows.push({ id: `feature.${n}`, n, title: a, hint: b })
    }
    groups.push(current)
    return { n: index + 1, title, groups }
  })
  sections.push({ n: 4, title: CONNECTIONS_SECTION_TITLE, groups: [] })
  return sections
}
export const FEATURE_SECTIONS: readonly FeatureSection[] = buildSections()
export const FEATURE_ROWS: readonly FeatureRow[] = FEATURE_SECTIONS.flatMap((s) => s.groups.flatMap((g) => g.rows))
export const isFeatureId = (value: unknown): value is string => typeof value === 'string' && FEATURE_ROWS.some((row) => row.id === value)

// ── Read state ──────────────────────────────────────────────────────────────────────────────────

export const isRead = (learn: GuideLearn, id: string): boolean => learn.read.includes(id)
export const topicStatusText = (learn: GuideLearn, id: string): string => (isRead(learn, id) ? TOPIC_STATUS.read : TOPIC_STATUS.none)
/** "2 of 9 read": the count on the How it works bar. */
export const howReadCount = (learn: GuideLearn): string => `${HOW_TOPICS.filter((topic) => isRead(learn, topic.id)).length} of ${HOW_TOPICS.length} read`

/** The sentences as one string, for comparing with the topics file. */
export const topicBody = (topic: HowTopic): string => topic.sentences.join(' ')
