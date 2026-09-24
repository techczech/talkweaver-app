export const WARNING_SEVERITIES = ['error', 'warning', 'hint']
export const WARNING_SURFACES = ['strip-badge', 'inspector', 'doctor', 'never-ui']

const warning = (id, severity, message, remedy, surfaces = ['doctor']) => ({
  id, severity, message, remedy, surfaces
})

// Compiler warning definitions are data so every UI surface uses the same language and remedy.
// `{payload}` is the complete suffix after the first colon; `{1}`, `{2}`… address its segments.
export const WARNING_REGISTRY = [
  warning('accent-unknown', 'warning', 'Unknown accent colour: {payload}.', 'Choose a named accent from Deck design.'),
  warning('beats-records-mismatch', 'error', 'Presentation sequence and slide records disagree at {payload}.', 'Rebuild the deck and inspect the affected slide structure.'),
  warning('bg-unknown', 'warning', 'Unknown background treatment: {payload}.', 'Choose a registered background treatment.'),
  warning('blocks-unparsed', 'warning', 'The block grid value could not be read: {payload}.', 'Use a rows-by-columns value such as 2x3.'),
  warning('cards-iconlist-alias', 'hint', 'Slide {payload} writes {iconlist} on a cards slide; it is read as the cards Icons option.', 'Write {icons} on the cards slide, or leave the alias — both render the same icons.', ['inspector', 'doctor']),
  warning('carousel-on-sections', 'warning', 'Carousel mode cannot sequence section node {payload}.', 'Apply carousel to child slides rather than the section heading.'),
  warning('chart-unparsed', 'warning', 'A chart line could not be parsed: {payload}.', 'Rewrite the line using the documented chart syntax.'),
  warning('colour-unknown', 'warning', 'Unknown deck title colour: {payload}.', 'Choose a title colour offered by Deck settings.'),
  warning('code-too-long', 'warning', 'Code on slide {payload} cannot fit at the 31px type floor.', 'Shorten the code, split it across slides or move detail into notes.', ['strip-badge', 'inspector', 'doctor']),
  warning('claim-style-unknown', 'warning', 'Unknown deck claim treatment: {payload}.', 'Choose a claim treatment offered by Deck settings.'),
  warning('compare-extra-groups', 'warning', 'Compare slide “{payload}” has more than two groups.', 'Keep two comparison groups or choose a multi-group layout.'),
  warning('conceptmap-unparsed', 'warning', 'A concept-map line could not be parsed: {payload}.', 'Rewrite the line using the documented concept-map syntax.'),
  warning('contrast-groups-count', 'warning', 'Contrast slide {payload} does not have the expected group count.', 'Use two or three groups, or choose a different layout.'),
  warning('contrast-variant-unknown', 'warning', 'Unknown contrast variant: {payload}.', 'Choose a registered contrast variant.'),
  warning('countdown-unparsed', 'warning', 'Countdown duration could not be read: {payload}.', 'Use a duration such as 5m or 30s.'),
  warning('deck-flag-unknown', 'warning', 'Deck setting “{1}” could not be read as on or off: {2}.', 'Write true or false, or clear the setting to take the default.'),
  warning('divider-default-suppressed-by-tokens', 'hint', 'Slide {1} kept its own triggers ({2}) instead of becoming a section divider.', 'Remove those triggers if this heading should divide the talk.'),
  warning('duplicate-slide-id-merged', 'warning', 'Duplicate slide identity was merged into {payload}.', 'Give each slide a unique stamped id before reusing it.'),
  warning('duplicate-slide-id', 'error', 'Duplicate slide id: {payload}.', 'Give each slide a unique stamped id.'),
  warning('duration-unparsed', 'warning', 'Talk duration could not be read: {payload}.', 'Use a duration in minutes or a supported time format.'),
  warning('font-unknown', 'warning', 'Unknown deck font: {payload}.', 'Choose a font offered by Deck design.'),
  warning('frontmatter-trigger-ignored', 'hint', 'Slide-only trigger was ignored in frontmatter: {payload}.', 'Move this trigger to the relevant slide.'),
  warning('heading-level-gap', 'warning', 'Heading hierarchy jumps at line {payload}.', 'Adjust the heading level so it descends one level at a time.'),
  warning('icon-gap', 'hint', 'No curated icon matches “{payload}”.', 'Choose an icon explicitly or reword the concept.', ['never-ui']),
  warning('icon-semantic-needed', 'hint', 'Slide {1} needs an icon decision for “{2}”.', 'Choose an explicit icon for the item or leave the list plain.', ['never-ui']),
  warning('icon-suggested', 'hint', 'Slide {payload} could use an icon treatment.', 'Add {iconlist} only if icons improve the slide.', ['never-ui']),
  warning('iconlist-no-icons', 'warning', 'No icons resolved for this icon list on slide {payload}; it rendered plain.', 'Choose concrete icon names for the items or remove the icon-list treatment.', ['strip-badge', 'inspector', 'doctor']),
  warning('iconlist-unknown', 'warning', 'Unknown icon-list variant: {payload}.', 'Choose a registered icon-list variant.'),
  warning('image-grid-stray-labels', 'warning', 'Image grid “{1}” has {2} unmatched label content.', 'Pair each label with an image or remove the stray text.'),
  warning('invalid-slide-role', 'warning', 'Slide {1} has unknown role “{2}”.', 'Choose a registered slide role.'),
  warning('legacy-outline', 'hint', 'This talk uses the legacy outline format.', 'Migrate the outline to the current format before structural editing.'),
  warning('linking-slide-missing-target', 'warning', 'Linking slide {payload} has no target.', 'Set the slide it prepares for.'),
  warning('links-index-empty', 'hint', 'The links index is switched on but this deck has no links to list.', 'Add a link to a slide, or switch the links index off.'),
  warning('logo-colour-unknown', 'warning', 'Unknown deck logo colour: {payload}.', 'Choose unified or brand for the logo colour.'),
  warning('media-budget-exhausted', 'hint', 'Slide {1} keeps {2} outside this export: the deck’s media budget is spent.', 'Keep the assets folder beside this copy, or trim the deck’s media.', ['doctor']),
  warning('missing-asset', 'error', 'Slide {1} cannot find asset {2}.', 'Restore the asset or update the source path.'),
  warning('missing-image', 'error', 'Slide {1} cannot find image {2}.', 'Restore the image or update the source path.'),
  warning('missing-source-ref', 'warning', 'Slide {payload} has no source reference.', 'Add a source reference or mark the slide as linking.'),
  warning('palette-unknown', 'warning', 'Unknown deck palette: {payload}.', 'Choose a palette offered by Deck settings.'),
  warning('poll-authoring-invalid', 'warning', 'Invalid poll on slide {1}: {2}', 'Correct the poll type, labels or options before collecting responses.'),
  warning('poll-type-unknown', 'warning', 'Unknown poll type: {payload}.', 'Choose single, multiple, open, ranking, rating or categorisation for the poll.'),
  warning('poll-limit-invalid', 'error', 'Poll limit is invalid: {payload}.', 'Set a positive whole number; selections must not exceed the number of options. Free text also accepts unlimited.', ['strip-badge', 'inspector', 'doctor']),
  warning('pollresults-unknown', 'warning', 'Unknown poll result visibility: {payload}.', 'Choose live or held for the poll results.'),
  warning('quote-too-long', 'warning', 'Quote on slide {payload} cannot fit at the 31px type floor.', 'Shorten the quotation or split it across slides.', ['strip-badge', 'inspector', 'doctor']),
  warning('remind-missing-time', 'warning', 'Reminder has no usable time: {payload}.', 'Add remind-at or remind-in to the reminder.'),
  warning('remind-unparsed', 'warning', 'Reminder time could not be read: {payload}.', 'Use a supported clock time or relative duration.'),
  warning('retired-title-compact', 'hint', 'Slide {payload} still sets the retired compact title treatment.', 'Remove the token — the slide already renders in its layout’s own title regime.', ['inspector', 'doctor']),
  warning('remote-embed', 'hint', 'Slide {payload} contains a remote embed.', 'Check the site online before presenting.', ['doctor']),
  warning('remote-video', 'hint', 'Slide {payload} contains a remote video.', 'Check the video online before presenting.', ['doctor']),
  warning('role-token-overrides-structure', 'hint', 'Slide {1} takes the role “{2}” you set rather than the divider role its child headings imply.', 'Remove the role trigger if this heading should divide the talk.'),
  warning('section-only-trigger-level', 'warning', 'Trigger “{2}” only applies to ## sections, but it appears on heading level {3}.', 'Move the trigger to a ## section heading.', ['strip-badge', 'inspector', 'doctor']),
  warning('section-timer-unparsed', 'warning', 'Section timer could not be read: {payload}.', 'Use a supported duration such as 10m.'),
  warning('statement-unknown', 'warning', 'Unknown statement variant: {payload}.', 'Choose a registered statement variant.'),
  warning('timer-threshold-clamped', 'warning', 'The deck sets “{1}” to {2} minutes, later than warn-at ({3}); it was brought back to {3}.', 'Set urgent-at below warn-at so the two thresholds do not invert.'),
  warning('timer-threshold-unreadable', 'warning', 'Presenter clock threshold “{1}” could not be read: {2}.', 'Use a whole number of minutes before the deadline.'),
  warning('title-style-unknown', 'warning', 'Unknown title slide style: {payload}.', 'Choose a title style offered by Deck settings.'),
  warning('trigger-conflict', 'warning', 'Conflicting trigger values: {payload}.', 'Keep one value for this trigger.', ['strip-badge', 'inspector', 'doctor']),
  warning('unknown-image-type', 'warning', 'Slide {1} uses an unsupported image type: {2}.', 'Convert the image to PNG, JPEG, GIF, SVG or WebP.'),
  warning('unknown-liststyle', 'warning', 'Unknown list style: {payload}.', 'Choose a registered list style.'),
  warning('unknown-trigger', 'error', 'Unknown trigger: {payload}.', 'Choose a trigger from the layout and option registers.', ['strip-badge', 'inspector', 'doctor']),
  warning('unresolved-trigger', 'error', 'Unresolved trigger: {payload}.', 'Register the token or fix it — the Layout Doctor lists every occurrence.', ['strip-badge', 'inspector', 'doctor']),
  warning('video-asset-only', 'hint', 'Slide {1} video stays as an external asset: {2}.', 'Keep the video beside shared exports and verify its poster.', ['doctor'])
]

const warningById = new Map(WARNING_REGISTRY.map((entry) => [entry.id, entry]))

export function warningDefinition(rawWarning) {
  const id = String(rawWarning).split(':', 1)[0]
  return warningById.get(id) ?? null
}

export function formatWarning(rawWarning) {
  const raw = String(rawWarning)
  const [id, ...parts] = raw.split(':')
  const definition = warningById.get(id)
  if (!definition) return raw
  const payload = parts.join(':')
  const message = definition.message
    .replaceAll('{payload}', payload)
    .replace(/\{(\d+)\}/g, (_match, index) => parts[Number(index) - 1] ?? '')
  return `${message} ${definition.remedy}`.trim()
}

export function warningsForSurface(rawWarnings, surface) {
  if (!Array.isArray(rawWarnings)) return []
  const output = []
  for (const rawWarning of rawWarnings) {
    const definition = warningDefinition(rawWarning)
    // Future compiler codes must remain visible and harmless until parity adds their definition.
    if (!definition || definition.surfaces.includes(surface)) output.push(formatWarning(rawWarning))
  }
  return output
}

/** Like warningsForSurface, but keeps id + severity so surfaces can style errors distinctly. */
export function warningBadgesForSurface(rawWarnings, surface) {
  if (!Array.isArray(rawWarnings)) return []
  const output = []
  for (const rawWarning of rawWarnings) {
    const definition = warningDefinition(rawWarning)
    if (!definition || definition.surfaces.includes(surface)) {
      output.push({
        id: definition?.id ?? String(rawWarning).split(':', 1)[0],
        severity: definition?.severity ?? 'warning',
        text: formatWarning(rawWarning)
      })
    }
  }
  return output
}
