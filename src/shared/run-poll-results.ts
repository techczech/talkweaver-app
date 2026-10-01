// A Run's poll results as History's Run card (H1) and the read-only share link show them: one
// summary per poll the Run keeps, counted from its stored answers. Shared by main and the renderer,
// so it carries no Node or DOM code. Boards are not polls here (run-board.ts shows them).

export interface RunPollLike {
  id: string
  type: string
  question: string
  slideId?: string
  options: Array<{ optionId: string; label: string }>
  labels?: Array<{ optionId: string; label: string }>
}

export interface RunPollResponseLike {
  pollId: string
  choice?: unknown
  text?: string
}

export type RunPollSummary =
  | { kind: 'bars'; pollId: string; type: string; question: string; slideId?: string; people: number; rows: Array<{ label: string; count: number }> }
  | { kind: 'scale'; pollId: string; type: string; question: string; slideId?: string; people: number; labels: string[]; rows: Array<{ label: string; counts: number[] }> }
  | { kind: 'text'; pollId: string; type: string; question: string; slideId?: string; people: number; responses: string[] }

const TYPE_WORD: Record<string, string> = {
  single: 'single choice', multiple: 'multiple choice', open: 'open answer', ranking: 'ranking', rating: 'rating', categorisation: 'categorisation',
}

export function pollTypeWord(type: string): string {
  return TYPE_WORD[type] ?? type
}

/** Every poll on the Run except boards, with its counts; polls nobody answered are left out. */
export function runPollSummaries(run: { polls?: RunPollLike[]; pollResponses?: RunPollResponseLike[] }): RunPollSummary[] {
  const responses = run.pollResponses ?? []
  return (run.polls ?? []).filter((poll) => poll.type !== 'board').flatMap((poll): RunPollSummary[] => {
    const mine = responses.filter((response) => response.pollId === poll.id)
    if (!mine.length) return []
    const base = { pollId: poll.id, type: poll.type, question: poll.question, ...(poll.slideId ? { slideId: poll.slideId } : {}), people: mine.length }
    if (poll.type === 'open') {
      return [{ kind: 'text', ...base, responses: mine.map((response) => typeof response.text === 'string' ? response.text : typeof response.choice === 'string' ? response.choice : '').filter(Boolean) }]
    }
    if (poll.type === 'rating' || poll.type === 'categorisation') {
      const labels = poll.labels ?? []
      const rows = poll.options.map((option) => ({ label: option.label, counts: labels.map((label) => mine.filter((response) =>
        response.choice && typeof response.choice === 'object' && !Array.isArray(response.choice)
        && (response.choice as Record<string, unknown>)[option.optionId] === label.optionId).length) }))
      return [{ kind: 'scale', ...base, labels: labels.map((label) => label.label), rows }]
    }
    // Single and multiple choice count each option picked; a ranking counts first places.
    const rows = poll.options.map((option) => ({ label: option.label, count: mine.filter((response) => {
      const choice = response.choice
      if (poll.type === 'ranking') return Array.isArray(choice) && choice[0] === option.optionId
      return Array.isArray(choice) ? choice.includes(option.optionId) : choice === option.optionId
    }).length }))
    return [{ kind: 'bars', ...base, rows }]
  })
}
