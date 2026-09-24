import { TRIGGER_LINE_RE, tokenizeTriggerBody } from "./trigger-tokenizer.mjs";

const POLL_TYPES = new Set(['single', 'multiple', 'open', 'ranking', 'rating', 'categorisation']);

// Directives only have meaning as a whole content line, outside Markdown code fences.
export function pollDirectivesFor(lines = []) {
  const directives = [];
  const contentLines = [];
  let hasBlankRows = false;
  let fence = null;
  for (const line of lines) {
    const text = String(line).trim();
    const mark = text.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      contentLines.push(line);
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
      continue;
    }
    if (mark) { fence = mark[1]; contentLines.push(line); continue; }
    if (/^\s*(?:[-*]|\d+[.)])\s*$/.test(String(line))) hasBlankRows = true;
    if (!/^\[(scale|categories)\s*:/i.test(text)) { contentLines.push(line); continue; }
    const match = text.match(/^\[(scale|categories)\s*:\s*([^\]]*)\]$/i);
    // A closed directive followed by prose is an example, not slide metadata.
    if (!match && text.includes(']')) { contentLines.push(line); continue; }
    directives.push({
      type: /^\[scale/i.test(text) ? 'rating' : 'categorisation',
      labels: match ? match[2].split(',').map(label => label.trim()) : null
    });
    contentLines.push('');
  }
  return { directives, contentLines, hasBlankRows };
}

function listLabels(blocks) {
  const labels = [];
  const visit = children => {
    for (const child of children || []) { labels.push(child.text); visit(child.children); }
  };
  for (const block of blocks) {
    if (block?.type !== 'list' || !Array.isArray(block.items)) continue;
    block.items.forEach((label, index) => { labels.push(label); visit(block.children?.[index]); });
  }
  return labels;
}

function hasDuplicatePollMetadata(slide) {
  const node = slide.treeNode;
  if (!node) return false;
  const seen = new Set();
  let fence = null;
  const lines = [node.headingLine || '', node.triggerLine || '', ...(node.contentLines || [])];
  for (let index = 0; index < lines.length; index += 1) {
    const text = String(lines[index]).trim();
    const mark = text.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
      continue;
    }
    if (mark) { fence = mark[1]; continue; }
    if (index !== 0 && !TRIGGER_LINE_RE.test(text)) continue;
    let rest = text;
    for (;;) {
      const group = rest.match(/^([\s\S]*?)\s*\{([^}]*)\}$/);
      if (!group) break;
      rest = group[1].trimEnd();
      for (const { raw } of tokenizeTriggerBody(group[2])) {
        const key = raw.match(/^(poll|polltop|pollskip|pollresults|pollselections|pollsubmissions)(?:=|:|$)/)?.[1];
        if (!key) continue;
        if (seen.has(key)) return true;
        seen.add(key);
      }
    }
  }
  return false;
}

export function pollDefinitionFor(slide, rawBlocks, slideId, authored, warnings) {
  const explicitType = String(slide.attrs.poll ?? '').trim().toLowerCase();
  const { directives } = authored;
  const hasTop = Object.hasOwn(slide.attrs, 'polltop');
  const hasSkip = Object.hasOwn(slide.attrs, 'pollskip');
  if (!explicitType && !directives.length && !hasTop && !hasSkip) return null;
  if (explicitType && !POLL_TYPES.has(explicitType)) {
    warnings.push(`poll-type-unknown:${explicitType}`);
    return null;
  }
  const invalid = reason => { warnings.push(`poll-authoring-invalid:${slideId}:${reason}`); return null; };
  if (hasDuplicatePollMetadata(slide)) return invalid('Keep one value for each poll metadata key.');
  if (directives.length > 1) return invalid('Keep one scale or categories directive per slide.');
  const directive = directives[0];
  if (directive && (!directive.labels || directive.labels.some(label => !label)
      || new Set(directive.labels.map(label => label.toLocaleLowerCase())).size !== directive.labels.length)) {
    return invalid('Scale and category labels must be non-empty and unique.');
  }
  if (directive && explicitType && directive.type !== explicitType) return invalid('The poll type conflicts with its labels.');
  const type = explicitType || directive?.type;
  const matrix = type === 'rating' || type === 'categorisation';
  if ((matrix || type === 'ranking') && authored.hasBlankRows) return invalid('Fill in or remove every empty list item.');
  if (matrix && !directive) return invalid('Add the scale or categories directive for this poll.');
  if (!type) return invalid('Set a poll type before its options.');
  if (hasTop && type !== 'ranking') return invalid('polltop applies only to ranking polls.');
  if (hasSkip && !matrix) return invalid('pollskip applies only to rating and categorisation polls.');
  const pollId = `poll-${slideId}`;
  // Existing choice polls use their first list; expanding that set would change saved choices.
  const legacyChoices = type === 'single' || type === 'multiple';
  const labels = type === 'open' ? [] : legacyChoices
    ? (rawBlocks.find(block => block?.type === 'list' && Array.isArray(block.items))?.items || [])
    : listLabels(rawBlocks);
  const options = labels.map((label, index) => ({ optionId: `${pollId}-option-${index + 1}`, label }));
  if ((type === 'ranking' || matrix) && (!options.length || options.some(option => !option.label.trim()))) return invalid('Add non-empty list items for the poll.');
  const limits = {};
  if (type === 'multiple' && slide.attrs.pollselections !== undefined) {
    const value = Number(slide.attrs.pollselections);
    if (!Number.isSafeInteger(value) || value < 1 || value > options.length) {
      warnings.push(`poll-limit-invalid:pollselections:${slide.attrs.pollselections}`);
      return null;
    }
    limits.maxSelections = value;
  }
  if (type === 'open' && slide.attrs.pollsubmissions !== undefined) {
    const raw = String(slide.attrs.pollsubmissions);
    const value = raw === 'unlimited' ? null : Number(raw);
    if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
      warnings.push(`poll-limit-invalid:pollsubmissions:${raw}`);
      return null;
    }
    limits.maxSubmissions = value;
  }
  let rankCount;
  if (hasTop) {
    const value = String(slide.attrs.polltop);
    rankCount = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(rankCount) || rankCount < 1 || rankCount > options.length) return invalid('polltop must be an integer from 1 to the number of list items.');
  }
  const skip = String(slide.attrs.pollskip ?? 'false').toLowerCase();
  if (matrix && !['true', 'false'].includes(skip)) return invalid('pollskip must be true or false.');
  const visibilityRaw = String(slide.attrs.pollresults || 'live').trim().toLowerCase();
  const visibility = visibilityRaw === 'held' ? 'held' : 'live';
  if (visibilityRaw !== 'live' && visibilityRaw !== 'held') warnings.push(`pollresults-unknown:${visibilityRaw}`);
  return {
    pollId, type, question: slide.title, options, visibility, ...limits,
    ...(hasTop ? { rankCount } : {}),
    ...(matrix ? { labels: directive.labels.map((label, index) => ({ optionId: `${pollId}-label-${index + 1}`, label })), allowSkip: skip === 'true' } : {})
  };
}

export function rebasePollDefinition(poll, slideId) {
  const pollId = `poll-${slideId}`;
  return {
    ...poll, pollId,
    options: poll.options.map((option, index) => ({ ...option, optionId: `${pollId}-option-${index + 1}` })),
    ...(poll.labels ? { labels: poll.labels.map((label, index) => ({ ...label, optionId: `${pollId}-label-${index + 1}` })) } : {})
  };
}
