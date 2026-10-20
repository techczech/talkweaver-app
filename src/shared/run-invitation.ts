// The text "Copy invitation text" puts on the clipboard for a published Run (work-files ticket 16;
// journeys Amendment 2 lock: the invitation mentions both links). Pure: no Electron, no clock.
//
// It names the session, then each page a participant is asked to use, in the order they use them:
// the pre-work page with when it closes, the post-work page with when it opens, and the session
// handout last. A phase the Run does not have is left out; a Run with neither gets the handout alone.
// Every line is plain text: whoever pastes it (an email, a chat) decides how it looks.
import { dayLabel, whenLabel } from './run-checklist.ts'
import { SESSION_END, workPageUrl } from './run-work.ts'

export interface InvitationRun {
  eventTitle?: string
  talkTitle: string
  /** `YYYY-MM-DD` and `HH:MM`, in the Run's zone. */
  plannedDate?: string
  startTime?: string
  /** The Run's published handout link. */
  handoutUrl: string
  work?: {
    pre?: { closes: string }
    post?: { opens: string; closes: string }
  }
}

export function runInvitationText(run: InvitationRun): string {
  const handout = run.handoutUrl.trim()
  const event = (run.eventTitle ?? '').trim()
  const talk = run.talkTitle.trim()
  const title = event && talk && event !== talk ? `${event}: ${talk}` : event || talk
  const date = /^\d{4}-\d{2}-\d{2}$/.test(run.plannedDate ?? '') ? dayLabel(run.plannedDate!) : ''
  const time = /^\d{2}:\d{2}$/.test(run.startTime ?? '') ? run.startTime! : ''
  const when = [date, time].filter(Boolean).join(', ')
  const local = (value: string | undefined): string => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value ?? '') ? whenLabel(value!) : '')

  const blocks: string[] = [[title, when].filter(Boolean).join('\n')]
  const pre = run.work?.pre
  const post = run.work?.post
  if (pre) {
    const closes = local(pre.closes)
    blocks.push(`Before the session, please do the pre-work${closes ? ` (open until ${closes})` : ''}:\n${workPageUrl(handout, 'pre')}`)
  }
  if (post) {
    const opens = post.opens === SESSION_END ? 'when the session ends' : local(post.opens) ? `on ${local(post.opens)}` : ''
    const closes = local(post.closes)
    const timing = [opens ? `opens ${opens}` : '', closes ? `closes ${closes}` : ''].filter(Boolean).join(' and ')
    blocks.push(`After the session, the post-work${timing ? ` (${timing})` : ''}:\n${workPageUrl(handout, 'post')}`)
  }
  blocks.push(`${pre || post ? 'The session handout' : 'The handout for the session'}:\n${handout}`)
  return blocks.filter(Boolean).join('\n\n')
}
