// Authored text and data for the TalkWeaver onboarding mockup. Wording fixes happen here only.
// Command rows are read from command-map-talkweaver.json (same folder); everything else is written below.
// Inline marks: **bold**, `chord or code`.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MAP = JSON.parse(readFileSync(join(HERE, 'command-map-talkweaver.json'), 'utf8'))
export const TASKS = MAP.tasks.map((t) => t.name)
export const cmdsOf = (task) => MAP.records.filter((r) => r.task === task && r.class === 'command')
export const LIVE_GROUPS = ['Live audience, polls and questions', 'Live board (added)']
export const isLive = (r) => LIVE_GROUPS.includes(r.subgroup)

export const TEXT = {
  badge: 'Onboarding and command help · TalkWeaver hi-fi',
  talk: 'The Saturday market',
  vaultExample: 'Example vault',
  vaultOwn: 'Personal',
  exampleMark: 'Example',
  exampleDir: '~/Documents/TalkWeaver/Example vault',
  segments: ['Learn the commands', 'How it works', 'Features to delight you'],
  firstLaunch: {
    h1: 'Choose your Vault',
    p: 'Select the folder that contains your Talk folders. TalkWeaver will scan it for `*-outline.md` files.',
    btn: 'Choose Vault Folder',
    hint: 'This is typically your `presentations/` folder.',
    or: 'or look around first',
    exTitle: 'Open the example vault',
    exSub: 'Five short demo talks with a practice slide for each of ten tasks. The vault sits in its own folder and can be removed whenever you like.',
    exBtn: 'Open example vault',
    exPath: '~/Documents/TalkWeaver/Example vault · 5 talks',
  },
  steps: {
    bar: 'First steps',
    rows: [
      { label: 'Choose your own vault', action: 'Add vault…', done: 'Personal' },
      { label: 'Make your first talk', action: 'New presentation…', done: 'Metaphor talk 2026' },
      { label: 'Open the example talk', action: 'Open', done: 'Opened' },
    ],
  },
  chaptersBar: 'Chapters',
  startHere: 'Start here',
  removeExample: 'Remove the example vault…',
  status: { none: 'Not opened', opened: 'Opened', read: 'Read', tried: (a, b) => `${a} of ${b} tried`, finished: 'Finished 6 Oct' },
  thisChapter: 'This chapter',
  practiceTalk: 'Practice talk',
  openInExample: 'Open this talk',
  openNow: 'open now',
  tryIt: 'Try it',
  connectsBar: 'What it connects to',
  chip: { slide: 'On a slide heading', count: 14 },
  actions: { title: 'Actions here', filter: 'Filter actions', all: 'All commands…', allChord: '⇧⌘P', none: (q) => `No “${q}” action here` },
  sheet: { title: 'Keyboard shortcuts', filter: 'Filter all commands', here: 'Here: on a slide heading' },
  confirm: {
    title: 'Remove the example vault?',
    lead: 'The example vault folder is moved to the Bin. Your own vaults and talks are not touched. What you have tried and read is kept.',
    binBar: 'Moved to the Bin',
    bin: [['~/Documents/TalkWeaver/Example vault', '5 talks, with any change you made to them']],
    offBar: 'Taken off the Talks panel',
    off: ['The Example vault section, and the Guide’s example steps', 'Any window showing an example talk closes first; its changes are saved before the move'],
    keptBar: 'Kept',
    kept: ['Every vault, talk and file of your own', 'What you have tried and read in the Guide', 'Your settings and shortcuts'],
    cancel: 'Cancel', ok: 'Remove example vault',
  },
  removedFlash: 'Example vault moved to the Bin. Settings → Get started brings it back.',
  menu: ['Edit this vault…', 'Show only this vault', 'Reveal in Finder', 'Close vault'],
  menuRemove: 'Remove example vault…',
  settings: { title: 'Settings', section: 'Get started', note: 'The example vault was removed.', b1: 'Show the example vault again', b2: 'Open the Guide', switchT: 'Show the Guide button in the sidebar', switchS: 'Turn off when you have finished the onboarding. Get started in Settings and the palette still open the Guide.' },
  guideBtn: 'Guide',
  guideOffFlash: 'Guide button removed from the sidebar. Settings → Get started, or the palette, brings it back.',
  palette: { filter: 'get started', rows: [['Get started: show the example vault again', ''], ['Get started: open the Guide', ''], ['Get started: show the Guide button', '']] },
}

// The ten chapters: icon, history shown on the chapter list (state 04).
export const ICONS = {
  'Write the outline': 'pen-line', 'Build a slide': 'layout-template', 'Reuse slides': 'library', 'See the talk': 'eye',
  'Shape the talk': 'route', 'Present': 'presentation', 'Share': 'share', 'Manage talks': 'folders',
  'Check and repair': 'stethoscope', 'Set up TalkWeaver': 'sliders-horizontal',
}
export const HISTORY = {
  'Write the outline': { tried: 6 }, 'Build a slide': { opened: true }, 'Reuse slides': {}, 'See the talk': { finished: true },
  'Shape the talk': {}, 'Present': {}, 'Share': {}, 'Manage talks': {}, 'Check and repair': {}, 'Set up TalkWeaver': {},
}

// How it works — titles and sentences from topics-how-this-app-works-writeflex-and-talkweaver.md, TalkWeaver section.
export const HOW = [
  ['The outline is the talk.', 'Each talk is its own folder on disk with one Markdown outline in it. Slides, the handout, the presenter view and the venue screen are all made from it; you can export the talk as one HTML file or publish it as a handout. There is no canvas.'],
  ['A vault is a folder of talks.', 'Each talk is a folder with an outline. TalkWeaver also keeps delivery records and slide history in the vault. You can have several vaults.'],
  ['Headings become slides; a word in braces picks the layout.', '`{statement}` under a heading makes it a statement slide.'],
  ['You choose a layout, you do not draw one.', '⌘L shows your own slide in each layout. A slide that cannot fit is flagged, never shrunk.'],
  ['A slide keeps its identity.', 'Reuse it in another talk and TalkWeaver knows where it is used and keeps its versions.'],
  ['Pathways are cuts, not copies.', 'A 20-minute version is a ticked list of the same slides. Improve a slide once.'],
  ['Presenter and audience are separate.', 'Notes and the clock are yours; speaker notes never go into the deck, the handout or anything shared.'],
  ['Every delivery is kept.', 'A run through the presenter can be saved as a delivery, rehearsal or recording, with its audio, polls and questions attached.'],
  ['No TalkWeaver account or server.', 'Publishing, going live and sharing run in your own Cloudflare account.'],
]
// The one topic drawn open (state 09): topic 3. Page text is the topics-file sentence plus two plain restatements; open question 6.
export const TOPIC_OPEN = {
  index: 2,
  sentences: ['Each heading in your outline becomes a slide.', 'A word in braces under the heading picks its layout: `{statement}` under a heading makes it a statement slide.', 'The outline stays plain text; there is nothing to draw.'],
  tryChord: 'Open the Start here slide',
  tryDoes: 'Opens the example talk on its statement slide and puts the caret on the `{statement}` line.',
}
export const HOW_STATE = ['read', 'read', 'none', 'none', 'none', 'none', 'none', 'none', 'none']

export const DELIGHT = [
  ['What presentations are', [
    ['A talk is a folder.', 'Talks panel'], ['A handout comes with every talk.', 'Share menu, History'], ['More than text on a slide.', 'Insert menu'],
    ['See why a slide looks as it does.', '⌘P, palette'], ['Slides from other talks.', '⌘S, ⇧⌘S'],
  ]],
  ['How you present', [
    ['sub', 'Without any connection'],
    ['Reveal, focus, highlight.', 'R, F, H'], ['Timer and outline.', 'P, T, O'], ['Notes as a teleprompter.', 'View menu'],
    ['Paste to show.', '⌘V, ⌥⌘I'], ['Galleries, media and embeds.', 'Z, M, V, E'],
    ['sub', 'Live, if you choose to connect'],
    ['Ask the room.', 'Q, K, ⇧Q'], ['Hear from the room.', 'A'], ['Present without your laptop on the projector.', 'Copy venue-screen link'], ['A QR code from any slide.', 'U'],
  ]],
  ['What you can do with a presentation afterwards', [
    ['Every delivery is on record.', 'Tools › History'], ['Record and keep the talk.', '⇧R, Tools › Studio'], ['Publish the handout.', 'Share menu'],
    ['Share for comments.', 'Share menu'], ['Shorter versions without copies.', '⌘⌥P'],
  ]],
  ['How you connect, and what each needs', []],
]
export const DELIGHT_READ = new Set(['A talk is a folder.', 'Reveal, focus, highlight.'])

// What it connects to: names, needs and "without it" from the topics file. State is read from this Mac (open question 4).
export const CONNECTS = [
  { icon: 'cloud', name: 'Cloudflare Pages', need: 'Publishing handouts, short links', without: 'Handout and HTML deck save as files', state: 'Not set up', tone: 'off', action: 'Set up in Settings', hint: 'Account, project and token in Settings → Publishing.' },
  { icon: 'radio', name: 'Cloudflare live service', need: 'Going live, polls, questions, reactions, boards, venue screen, share for comments', without: 'Presenting works; nothing is lost if the connection drops', state: 'Not set up — set up in Settings (coming in 0.39)', tone: 'wait', action: 'Not available yet', hint: '' },
  { icon: 'upload', name: 'Cloudflare R2', need: 'Uploading recordings', without: 'Recordings stay on the Mac', state: 'Not set up', tone: 'off', action: 'Set up in Settings' },
  { icon: 'mic', name: 'Local transcription', need: 'Scripts and notes from a recording (Python, a speech model, ffmpeg)', without: 'Recording and playback work', state: 'Partly found: Python, ffmpeg. No speech model', tone: 'part', action: 'Show what is missing' },
  { icon: 'file-text', name: 'LibreOffice and Poppler', need: 'Pictures of the original slides in the Importer', without: 'Text, notes and media still import', state: 'Found on this Mac', tone: 'on', action: '' },
  { icon: 'sparkles', name: 'Your own agent', need: 'Import clean-up, write-ups', without: 'Raw script, manual corrections', state: 'Not set up', tone: 'off', action: 'Set up in Settings' },
  { icon: 'git-branch', name: 'A synced folder', need: 'Vaults on several machines; conflict copies are recognised (OneDrive, Dropbox, Google Drive, Git)', without: 'A local folder', state: 'Found on this Mac: Git, on vault Personal', tone: 'on', action: '' },
  { icon: 'copy', name: 'Single-HTML backups', need: 'Presenting from any computer if the Mac fails (a folder for a playable copy of each talk)', without: 'Nothing else changes', state: 'Not set up', tone: 'off', action: 'Choose a folder…' },
  { icon: 'layout-grid', name: 'SlideWell (separate app)', need: 'Browsing and reusing old PowerPoint decks', without: 'The Importer still brings decks in', state: 'Not found on this Mac', tone: 'off', action: 'Get SlideWell' },
]

// The example talk. [type, text]. types: h2 h3 chip p li q blank.
export const PRACTICE = {
  start: [['h2', '00 Start here'], ['h3', 'Start here'], ['chip', '{id=s1}'], ['chip', '{statement}'], ['p', 'This talk is the example. Each section teaches the commands for one task, on slides you can change freely.'],
    ['q', '**Try it.** Press `⌥↵` on a chapter in the Guide to open its practice slides. Nothing here can be broken: `⌘Z` undoes.']],
  write: (movedDown) => {
    const stalls = [['h3', 'Four stalls'], ['chip', '{id=s3}'], ['li', 'Bread and cakes'], ['li', 'Vegetables'], ['li', 'Plants'], ['li', 'Second-hand books'],
      ['q', '**Try it: move a slide.** Put the caret on the heading above and press `⌘⇧↓`. The whole slide moves below **Opening hours**.']]
    const hours = [['h3', 'Opening hours'], ['chip', '{id=s4}'], ['p', 'Saturdays, eight until one.']]
    return [['h2', '01 Write the outline'], ...(movedDown ? [...hours, ...stalls] : [...stalls, ...hours])]
  },
  present: [['h2', '06 Present'], ['h3', 'Move through the talk'], ['chip', '{id=s21}'], ['p', 'Open the presenter with `F5`.'],
    ['q', '**Try it.** Press `→` for the next slide, `←` to go back, and the letter **O** for the outline.']],
}
// The example vault holds five talks; each chapter has a practice talk and section.
export const EX_TALKS = [
  ['The Saturday market', 22, 'Start talk. Practice for Write the outline, Build a slide, See the talk'],
  ['Garden notes', 14, 'Shares three slides with The Saturday market, one with two versions. Practice for Reuse slides'],
  ['Walking the old town', 30, 'Has a ticked ten-minute pathway. Practice for Shape the talk'],
  ['Lightning round', 8, 'Notes and a kept delivery. Practice for Present and Share'],
  ['Harvest supper (draft)', 6, 'A draft with an empty slide and a missing picture. Practice for Manage talks, Check and repair, Set up TalkWeaver'],
]
export const CHAPTER_TALK = {
  'Write the outline': ['The Saturday market', '01 Write the outline'], 'Build a slide': ['The Saturday market', '02 Build a slide'],
  'See the talk': ['The Saturday market', '04 See the talk'], 'Reuse slides': ['Garden notes', '03 Reuse slides'],
  'Shape the talk': ['Walking the old town', '05 Shape the talk'], 'Present': ['Lightning round', '06 Present'],
  'Share': ['Lightning round', '07 Share'], 'Manage talks': ['Harvest supper (draft)', '08 Manage talks'],
  'Check and repair': ['Harvest supper (draft)', '09 Check and repair'], 'Set up TalkWeaver': ['Harvest supper (draft)', '10 Set up TalkWeaver'],
}
export const SLIDE_TITLES = ['Start here', 'Four stalls', 'Opening hours', 'Who runs it', 'Finding us', 'Move through the talk', 'Thank you']

// State captions: [number, group, caption]. Letters after a number mark the A/B drawings.
export const STATES = [
  ['01', 'First launch', 'First launch: Choose your Vault, with the second choice, Open the example vault (five talks)'],
  ['02', 'First launch', 'Example vault open: Guide opened in the right-hand column by the Guide button at the foot of the left sidebar'],
  ['03', 'Two vaults', 'Own vault and example vault side by side in the Talks panel; Guide first tab of the right column'],
  ['17', 'Two vaults', 'The ⋯ menu on the example vault’s header: Remove example vault…'],
  ['04', 'Learn a task', 'Learn the commands: ten chapters, each with its history and its practice talk'],
  ['05', 'Learn a task', 'Chapter in progress: the practice slide with its instruction, and This chapter'],
  ['06', 'Learn a task', 'Tick: ⌘⇧↓ used once, its row ticked, the count rises from 6 to 7'],
  ['07', 'Learn a task', 'Present chapter: the Guide is its own column beside Next and Notes in the presenter; the window widens'],
  ['08', 'How it works', 'How it works: nine topics with Not opened or Read'],
  ['09', 'How it works', 'A topic: heading, three sentences, one picture, Try it'],
  ['10', 'Features to delight you', 'Features to delight you, top: four sections, the first two'],
  ['18', 'Features to delight you', 'Features to delight you, scrolled: section three, and the first connections of section four'],
  ['11', 'Features to delight you', 'What it connects to, scrolled to the end: rows 4 to 9, each with a state read from this Mac (rows 1 to 3 are in state 18)'],
  ['12', 'What can I do here', '⌘K Actions here in the outline editor, with the place chip in the status bar'],
  ['13', 'What can I do here', 'A filter with no match here: No “publish” action here, All commands… highlighted'],
  ['14', 'What can I do here', '⌘/ keyboard sheet, opening on Here: on a slide heading'],
  ['15', 'Finishing', 'Remove example vault: confirmation with three bounded lists'],
  ['16', 'Finishing', 'After removal: flash, no Example section, Settings → Get started with the Guide button switch'],
  ['16b', 'Finishing', 'After removal: the same commands in the palette'],
  ['19', 'Finishing', 'Guide button switched off in Settings: the sidebar foot has no Guide button'],
]
