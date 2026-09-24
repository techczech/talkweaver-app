import React from 'react'

const help: Record<string, { text: string; example?: string }> = {
  'poll=single': { text: 'In the slide text, add each answer as a bullet. The slide title is the question; each person chooses one answer.', example: '- First option\n- Second option' },
  'poll=multiple': { text: 'In the slide text, add each answer as a bullet. Use Maximum selections to limit how many each person can choose.', example: '- First option\n- Second option' },
  'poll=open': { text: 'Use the slide title for your question. No options are needed in the slide text; people type their own answers.' },
  'poll=ranking': { text: 'In the slide text, add each option as a bullet. People rank all options by default; set Number to rank for an exact top N.', example: '- First option\n- Second option\n- Third option' },
  'poll=rating': { text: 'In the slide text, add the scale on its own line, then each item to rate as a bullet. Separate scale labels with commas; each person chooses one label per item.', example: '[scale: 1, 2, 3]\n\n- First item\n- Second item' },
  'poll=categorisation': { text: 'In the slide text, add the categories on their own line, then each item as a bullet. Separate category labels with commas; each person chooses one category per item.', example: '[categories: Individual, Shared]\n\n- First item\n- Second item' },
}

export default function PollAuthoringHelp({ token }: { token: string }): React.JSX.Element | null {
  const value = help[token]
  if (!value) return null
  return <aside className="poll-authoring-help" role="note" aria-label="How to add poll options">
    <p>{value.text}</p>
    {value.example && <pre>{value.example}</pre>}
  </aside>
}
