import type { PollChoice, PollDefinition, PollOption, PollStateMessage } from './protocol'

type PollExtras = Pick<PollDefinition, 'rankCount' | 'labels' | 'allowSkip'>

/** Definition metadata is public; aggregates below must pass the visibility gate. */
export function parsePollExtras(poll: Record<string, unknown>, options: PollOption[]): PollExtras | null {
  if (poll.type === 'ranking') {
    if (poll.labels !== undefined || poll.allowSkip !== undefined) return null
    if (poll.rankCount === undefined) return {}
    return Number.isInteger(poll.rankCount) && Number(poll.rankCount) >= 1 && Number(poll.rankCount) <= options.length
      ? { rankCount: Number(poll.rankCount) } : null
  }
  if (poll.type === 'rating' || poll.type === 'categorisation') {
    if (poll.rankCount !== undefined || !Array.isArray(poll.labels) || poll.labels.length < 1) return null
    if (poll.allowSkip !== undefined && typeof poll.allowSkip !== 'boolean') return null
    const labels: PollOption[] = []
    for (const value of poll.labels) {
      if (!value || typeof value !== 'object' || typeof value.optionId !== 'string' || !value.optionId.trim()
        || typeof value.label !== 'string' || !value.label.trim()) return null
      labels.push({ optionId: value.optionId, label: value.label })
    }
    if (new Set(labels.map(label => label.optionId)).size !== labels.length
      || new Set(labels.map(label => label.label.trim())).size !== labels.length) return null
    return { labels, ...(poll.allowSkip !== undefined ? { allowSkip: poll.allowSkip as boolean } : {}) }
  }
  return poll.rankCount === undefined && poll.labels === undefined && poll.allowSkip === undefined ? {} : null
}

export function extendedDefinitionFields(poll: Pick<PollDefinition, 'rankCount' | 'labels' | 'allowSkip'>): PollExtras {
  return {
    ...(poll.rankCount !== undefined ? { rankCount: poll.rankCount } : {}),
    ...(poll.labels ? { labels: poll.labels.map(label => ({ ...label })) } : {}),
    ...(poll.allowSkip !== undefined ? { allowSkip: poll.allowSkip } : {}),
  }
}

export function validExtendedChoice(poll: PollDefinition, choice: PollChoice): PollChoice {
  const optionIds = new Set(poll.options.map(option => option.optionId))
  if (poll.type === 'ranking') {
    const count = poll.rankCount ?? poll.options.length
    if (!Array.isArray(choice) || choice.length !== count || new Set(choice).size !== choice.length
      || choice.some(id => !optionIds.has(id))) throw new Error(`Rank exactly ${count} different choices.`)
    return [...choice]
  }
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new Error('Choose one label for each item.')
  const entries = Object.entries(choice)
  const labelIds = new Set((poll.labels || []).map(label => label.optionId))
  if (!entries.length || (!poll.allowSkip && entries.length !== poll.options.length)
    || entries.some(([row, label]) => !optionIds.has(row) || !labelIds.has(label))) {
    throw new Error(poll.allowSkip ? 'Answer at least one item using the available labels.' : 'Choose one label for every item.')
  }
  return Object.fromEntries(entries)
}

export function extendedPollResults(poll: PollDefinition, votes: Record<string, PollChoice>): Partial<PollStateMessage> {
  const ballots = Object.values(votes)
  const responseCount = ballots.length
  if (poll.type === 'ranking') {
    const tallies = Object.fromEntries(poll.options.map(option => [option.optionId, 0]))
    const firstPlaces = { ...tallies }
    const count = poll.rankCount ?? poll.options.length
    for (const ballot of ballots) {
      if (!Array.isArray(ballot)) continue
      ballot.forEach((id, index) => {
        if (!Object.hasOwn(tallies, id)) return
        tallies[id] += Math.max(0, count - index)
        if (index === 0) firstPlaces[id] += 1
      })
    }
    return { tallies, firstPlaces, responseCount }
  }
  const categoryTallies = Object.fromEntries(poll.options.map(option => [option.optionId,
    Object.fromEntries((poll.labels || []).map(label => [label.optionId, 0])),
  ]))
  for (const ballot of ballots) {
    if (!ballot || typeof ballot !== 'object' || Array.isArray(ballot)) continue
    for (const [row, label] of Object.entries(ballot)) {
      if (Object.hasOwn(categoryTallies, row) && Object.hasOwn(categoryTallies[row], label)) categoryTallies[row][label] += 1
    }
  }
  return { categoryTallies, responseCount }
}
