const ASPECTS: Readonly<Record<string, string>> = {
  design: 'the design', title: 'the title', points: 'the points', icons: 'the icons',
  picture: 'the picture', table: 'the table', colour: 'the section colour',
  more: 'the presentation options', sketch: 'this sketch', split: 'the breakdown', scratch: 'this Scratchpad item', talkdesign: 'the talk’s design'
}

const REQUESTS: Readonly<Record<string, string>> = {
  design: 'Choose the arrangement, title treatment and icons that suit this slide’s content.',
  title: 'Review the placement, style, size and icon of the title on this slide.',
  points: 'Review how the points are arranged and how their text is sized.',
  icons: 'Review the icons beside each point. Use fitting icons from the sets in the talkweaver skill.',
  picture: 'Review which side of the slide holds the picture.',
  table: 'Review the header row, column rules and first-column treatment. Keep the cell text.',
  colour: 'Review the colour of this section slide. Keep the talk’s rotation elsewhere.',
  more: 'Review how this slide reveals its content and offers audience reactions.'
}

export function handoffAspectName(aspect: string): string {
  return ASPECTS[aspect] ?? aspect
}

export interface HandoffSource {
  path: string
  scratch?: {
    kind: 'sketch' | 'visual' | 'snapshot'
    title: string
    file?: string
    folder: string
    markdown?: string
    after?: { title: string; id?: string }
  }
  slide?: {
    id?: string
    title: string
    section: string
    line: number
    number: number
    current: string
    points: string[]
  }
}

export function buildHandoffPrompt(aspect: string, source: HandoffSource, goal: string): string {
  const { path, slide } = source
  const file = `Talk file: ${path}`
  const instruction = 'Use the talkweaver skill and edit the talk’s Markdown file directly. Save the file once. TalkWeaver will show the changes for review. Tell me in one or two sentences what you changed.'
  const wish = goal.trim() ? `What I want: ${goal.trim()}` : ''
  if (source.scratch) {
    const item = source.scratch
    const finish = 'Use the talkweaver skill. Tell me in one or two sentences what you changed.'
    const scope = 'Do not edit the talk file or insert anything into the talk. I review and insert it in TalkWeaver.'
    if (aspect === 'sketch' || aspect === 'split') return [
      aspect === 'split' ? 'Propose how to break this TalkWeaver sketch into slides.' : 'Improve this TalkWeaver sketch before it becomes slides.',
      file, `Sketch file: ${item.file}`,
      aspect === 'split'
        ? 'Mark a section line with “## ” and a slide-title line with “### ”. Keep every line and word in its section. I will review this in As marked.'
        : 'Tidy the order and grouping of the points. Keep my wording unless a line is unclear, and say which lines you changed.',
      wish, 'Edit only the named sketch file.', scope, finish
    ].filter(Boolean).join('\n')
    return [
      'Improve one item in this TalkWeaver talk’s Slide Scratchpad.',
      file, `Item: ${item.title}`, item.file ? `Item file: ${item.file}` : `Scratchpad folder: ${item.folder}`,
      item.after ? `Current insertion place: after “${item.after.title}”${item.after.id ? ` (id ${item.after.id})` : ''}.` : '',
      wish,
      item.kind === 'snapshot'
        ? 'The item is a read-only snapshot. Write a new Markdown sketch in the Scratchpad folder with ### marking the slide title. Keep the original snapshot and scratchpad-state.json intact.'
        : 'Edit only the named Scratchpad file. Keep its name and format.',
      scope, finish, item.markdown ? `Selected snapshot:\n${item.markdown}` : '',
    ].filter(Boolean).join('\n')
  }
  if (!slide) return [
    'Improve the design of this TalkWeaver talk.', file,
    'Review the talk-wide design settings in the file’s header: title style, icons beside points, section colours and typeface.',
    wish, 'Keep every slide’s wording, pictures, notes, id and per-slide choices.', instruction
  ].filter(Boolean).join('\n')
  const points = (aspect === 'points' || aspect === 'icons') && slide.points.length
    ? slide.points.map((point, index) => `  ${index + 1}. ${point}`).join('\n') : ''
  return [
    'Improve one aspect of one slide in this TalkWeaver talk.', file,
    slide.id ? `Slide: “${slide.title}” (id ${slide.id}; currently slide ${slide.number}).`
      : `This slide has no id. Find it by its saved heading “${slide.title}”, ${slide.section ? `in the section “${slide.section}”, ` : 'before any section, '}at line ${slide.line}.`,
    REQUESTS[aspect] ?? `Review only the ${aspect} options on this slide.`,
    slide.current ? `Current settings: ${slide.current}` : '', points, wish,
    slide.id
      ? 'Change only the named aspect. Keep the id line, wording, pictures, notes and every other slide.'
      : 'Change only the named aspect. Keep the heading, position, wording, pictures, notes and every other slide.',
    instruction
  ].filter(Boolean).join('\n')
}
