// The note lines under the Quote form control (locked mockup, Inspector states): which form is
// showing and why. The words come from `describe-quote-source` through `quoteFormNotes`.
import React, { useMemo } from 'react'
import { describeQuoteSource, type SlideRef } from '../../../shared/layout-verbs'
import { quoteFormNotes } from '../../../shared/quote-form-notes'

export default function QuoteFormNotes({ outline, slide, compiledLayout }: { outline: string; slide: SlideRef; compiledLayout?: string }): React.JSX.Element | null {
  const notes = useMemo(() => {
    try {
      return quoteFormNotes(describeQuoteSource(outline, slide, compiledLayout))
    } catch {
      // Not a quote slide, or the slide is not in the text yet: nothing to say.
      return []
    }
  }, [outline, slide, compiledLayout])
  if (!notes.length) return null
  return (
    <>
      {notes.map((note, index) => (
        <p key={index} className="tw-inspector-group-note" role="note">
          {note.lead ? <b>{note.lead}</b> : null}
          {note.text}
        </p>
      ))}
    </>
  )
}
