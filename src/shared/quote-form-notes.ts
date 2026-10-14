// The note lines under the Inspector's Quote form control (locked mockup section 7, ADR-0038):
// one or two short lines that say which form is showing and why. A pure function of
// `describe-quote-source`'s result, so a surface and a test read the same words.
//
// Until the video, book, paper and web renderers land (tickets 02–04 and 07), a slide whose form
// resolves to one of them is drawn as Plain and says so in one plain sentence. Each of those tickets
// deletes its form from UNBUILT_FORM_NOTE_FORMS (the compiler's BUILT_FORMS is the one source).
import { BUILT_FORMS, quoteFormLabel, unbuiltFormNote } from '../../compiler/scripts/lib/quote-forms.mjs'
import type { QuoteSourceDescription } from './layout-verbs.ts'

/** One line: `lead` is shown bold, then `text` follows it as written (it carries its own leading space). */
export interface QuoteFormNote { lead: string; text: string }

const FOUND_REASON: Record<string, string> = {
  'x-link': 'The source line links to a post on x.com.',
  'youtube-link': 'The source line links to YouTube.',
  isbn: 'The source line has an ISBN.',
  'book-reference': 'The source line has a title in asterisks, a year and a page.'
}

const CHOSEN: Record<string, { lead: string; text: string }> = {
  plain: { lead: 'Always the plain quote', text: ', whatever the source line holds.' },
  tweet: { lead: 'Always a tweet.', text: ' Name, handle and date are read from the source line.' },
  video: { lead: 'Always a video.', text: ' Channel, title and time are read from the source line.' },
  book: { lead: 'Always a book.', text: ' Authors, title, publisher, year and page are read from the source line.' },
  paper: { lead: 'Always a paper.', text: ' Authors, title, journal, year and page are read from the source line.' },
  web: { lead: 'Always a web page.', text: ' Site, headline, author and date are read from the source line.' }
}

function pictureNote(description: QuoteSourceDescription): QuoteFormNote | null {
  const { form, picture } = description
  if (form === 'tweet') return picture ? { lead: '', text: 'The picture on this slide is not drawn: a tweet takes no picture.' } : null
  // The picture decides between the player and the left panel (spec 1, decision 6); the note says which and why.
  if (form === 'video') {
    return picture
      ? { lead: '', text: 'Picture on this slide: it fills the left panel.' }
      : { lead: '', text: 'No picture on this slide: the YouTube player. Add a screenshot of the speaker to get the left panel.' }
  }
  if (form === 'book') {
    return picture
      ? { lead: '', text: 'Picture on this slide: it fills the left panel as the cover.' }
      : { lead: '', text: 'No picture on this slide: a cover is made from the title and authors.' }
  }
  // Same rule for a paper: a picture of the page fills the left panel, else the journal page is drawn.
  if (form === 'paper') {
    if (picture) return { lead: '', text: 'Picture on this slide: it fills the left panel.' }
    return { lead: '', text: description.chosen ? 'No picture on this slide: the journal page.' : 'No picture on this slide: the journal page. Add a screenshot of the page to get the left panel.' }
  }
  // The web page: a picture fills the left panel under the address bar, else the page is drawn in a browser window.
  if (form === 'web') {
    if (picture) return { lead: '', text: 'Picture on this slide: it fills the left panel under the address bar.' }
    // A web form found by the app's own edit (a link in the source line) offers the panel; one chosen with no link just says what it draws.
    return { lead: '', text: description.webLink ? 'No picture on this slide: the page in a browser window. Add a screenshot of the page to get the left panel.' : 'No picture on this slide: the page in a browser window.' }
  }
  return null
}

/** The note lines for the slide, at most two (the fetch block of ticket 06 sits under them). */
export function quoteFormNotes(description: QuoteSourceDescription): QuoteFormNote[] {
  const label = quoteFormLabel(description.form)
  // More than one quote on the slide: no form applies, whatever was chosen or found.
  if (description.several) {
    if (description.chosen && description.form === 'plain') return [CHOSEN.plain]
    return [{ lead: 'Showing as Plain.', text: ' This slide has more than one quote, so it shows as a plain quote.' }]
  }
  // Something else paints beside the quote (a list, a paragraph...): the card would cover it, so the slide is plain.
  if (description.otherContent) {
    if (description.chosen && description.form === 'plain') return [CHOSEN.plain]
    return [{ lead: 'Showing as Plain.', text: ' This slide has other content beside the quote, so it shows as a plain quote.' }]
  }
  // A form with no renderer yet: one plain sentence, and why it was found when Automatic found it.
  if (description.unbuilt) {
    const notes: QuoteFormNote[] = [{ lead: '', text: unbuiltFormNote(description.form) }]
    if (!description.chosen && FOUND_REASON[description.detectedBy]) notes.push({ lead: '', text: FOUND_REASON[description.detectedBy] })
    return notes
  }
  if (description.chosen) {
    // A web page whose source line has a link: the app wrote the token when the link was added (spec 3.1, 17.5).
    // Nothing records who wrote it, so a page chosen by hand over an existing link reads the same way (assumption 22).
    // The same for a paper over a DOI.
    const webSetOnEdit = description.form === 'web' && description.webLink
    const paperSetOnEdit = description.form === 'paper' && description.doiLink
    const base = webSetOnEdit
      ? { lead: '', text: `Set when you added the link to ${description.webLink}.` }
      : paperSetOnEdit ? { lead: '', text: 'Set when you added the DOI.' } : CHOSEN[description.form]
    const notes: QuoteFormNote[] = [base ?? { lead: `Always ${label}.`, text: '' }]
    if (description.refused) notes.push({ lead: '', text: `The words are too long for the ${label} form at its smallest size, so the slide shows as a plain quote.` })
    else {
      const picture = pictureNote(description)
      if (picture) notes.push(picture)
    }
    return notes
  }
  // Automatic.
  if (description.form === 'plain') {
    if (description.webLink) {
      return [
        { lead: 'Showing as Plain.', text: '' },
        { lead: '', text: 'The source line has a web link. Choose Web to show it as a web page.' }
      ]
    }
    if (description.doiLink) {
      return [
        { lead: 'Showing as Plain.', text: '' },
        { lead: '', text: 'The source line has a DOI. Choose Paper to show it as a paper.' }
      ]
    }
    return [
      { lead: 'Showing as Plain.', text: ' The source line has no link, and no reference that says what kind of source this is.' },
      { lead: '', text: 'Choose Tweet, Video, Book, Paper or Web to set it yourself.' }
    ]
  }
  if (description.refused) {
    return [
      { lead: 'Showing as Plain.', text: ` The words are too long for the ${label} form at its smallest size.` },
      { lead: '', text: 'Shorten the quotation, or choose Plain, which splits a long quote across slides.' }
    ]
  }
  const notes: QuoteFormNote[] = [{ lead: `Showing as ${label}.`, text: ` ${FOUND_REASON[description.detectedBy] ?? ''}`.trimEnd() }]
  const picture = pictureNote(description)
  if (picture) notes.push(picture)
  return notes
}

/** The forms that still draw as Plain, for a test to prove the table and the compiler agree. */
export const UNBUILT_FORM_NOTE_FORMS: readonly string[] = ['video', 'book', 'paper', 'web'].filter((form) => !BUILT_FORMS.has(form))
