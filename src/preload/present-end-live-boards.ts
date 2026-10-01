// End live with a board still open (feedback-boards ticket 06, drawing D20): the one question asked
// at End live when the session has an open board — close the board now, or keep it open for late
// cards on the join link. Asked once, here; without an open board End live asks its plain question.
// Every board question is audience-facing author text: it is set as text, never as markup.

export interface OpenBoard { pollId: string; question: string; cards: number }
export type EndLiveBoardsChoice = 'close' | 'keep'

const quote = (text: string): string => `“${text.trim() || 'Board'}”`
const cardCount = (n: number): string => `${n} card${n === 1 ? '' : 's'}`

/** The popover's words (D20). */
export function endLiveBoardsCopy(boards: OpenBoard[]): { title: string; sub: string; close: [string, string]; keep: [string, string] } {
  const named = boards.map((board) => `${quote(board.question)} (${cardCount(board.cards)})`)
  const which = boards.length === 1 ? `One board is still open: ${named[0]}.`
    : `${boards.length} boards are still open: ${named.slice(0, -1).join(', ')} and ${named.at(-1)}.`
  const plural = boards.length === 1 ? 'board' : 'boards'
  return {
    title: 'End the live session?',
    sub: `Phones stop following. ${which}`,
    close: [`Close the ${plural} now`, 'The Run keeps it as it is.'],
    keep: ['Keep it open for late cards', 'The join link still takes cards. Refresh it into the Run from History; close it there.'],
  }
}

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * Ask, and resolve with the choice, or null for Cancel (or Esc). "Keep it open" starts selected, as
 * drawn. The popover sits under the top bar at its right and takes the keyboard while it is open:
 * Enter ends live with the selected choice, Esc cancels.
 */
export function askEndLiveWithBoards(doc: Document, boards: OpenBoard[], initial: EndLiveBoardsChoice = 'keep'): Promise<EndLiveBoardsChoice | null> {
  doc.getElementById('twEndLiveBoards')?.remove()
  const copy = endLiveBoardsCopy(boards)
  const root = element(doc, 'div')
  root.id = 'twEndLiveBoards'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-labelledby', 'twEndLiveBoardsTitle')
  const title = element(doc, 'p', 'tw-elb-title', copy.title)
  title.id = 'twEndLiveBoardsTitle'
  root.append(title, element(doc, 'p', 'tw-elb-sub', copy.sub))
  const radios: Record<EndLiveBoardsChoice, HTMLInputElement> = {} as Record<EndLiveBoardsChoice, HTMLInputElement>
  for (const [value, [label, hint]] of [['close', copy.close], ['keep', copy.keep]] as Array<[EndLiveBoardsChoice, [string, string]]>) {
    const choice = element(doc, 'label', 'tw-elb-choice')
    choice.dataset.choice = value
    const input = element(doc, 'input')
    input.type = 'radio'
    input.name = 'twEndLiveBoardsChoice'
    input.value = value
    input.checked = value === initial
    radios[value] = input
    choice.append(input, element(doc, 'b', undefined, label), element(doc, 'small', undefined, hint))
    root.append(choice)
  }
  const actions = element(doc, 'div', 'tw-elb-actions')
  const cancel = element(doc, 'button', 'tw-elb-cancel', 'Cancel')
  const end = element(doc, 'button', 'tw-elb-end', 'End live')
  cancel.type = 'button'
  end.type = 'button'
  actions.append(cancel, end)
  root.append(actions)
  // On the body, fixed under the top bar: inside the bar it would be clipped by the bar's own box.
  doc.body.append(root)
  end.focus()
  return new Promise((resolve) => {
    const finish = (value: EndLiveBoardsChoice | null): void => {
      doc.removeEventListener('keydown', onKey, true)
      root.remove()
      resolve(value)
    }
    const chosen = (): EndLiveBoardsChoice => radios.close.checked ? 'close' : 'keep'
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(null) }
      else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement && event.target === cancel)) {
        event.preventDefault(); event.stopImmediatePropagation(); finish(chosen())
      } else if (!root.contains(event.target as Node)) event.stopImmediatePropagation()
    }
    doc.addEventListener('keydown', onKey, true)
    cancel.addEventListener('click', () => finish(null))
    end.addEventListener('click', () => finish(chosen()))
  })
}
