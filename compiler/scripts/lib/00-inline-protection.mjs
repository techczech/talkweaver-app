const MARK_SOURCE = String.raw`(?<![\w=])==(?=\S)([^=\n]*?[^=\s\n])==(?![\w=])`;

function markerRegex() {
  return new RegExp(MARK_SOURCE, "g");
}

function codeSpanAt(source, from, closeByOpen) {
  if (source[from] !== "`") return null;
  const match = closeByOpen.get(from);
  if (!match) return null;
  return {
    kind: "code",
    from,
    to: match.close + match.runLength,
    source: source.slice(from, match.close + match.runLength),
    content: source.slice(from + match.runLength, match.close)
  };
}

/**
 * Index the next exact closing backtick run for every possible opening position in one pass over
 * each line. An opening may begin inside a longer run (the historical scanner allowed that), but
 * a closer must be an exact maximal run. Clearing at every newline keeps code spans block-local.
 */
function indexCodeSpanClosers(source) {
  const closeByOpen = new Map();
  let lineRuns = [];

  const indexLine = () => {
    const nextRunByLength = new Map();
    for (let runIndex = lineRuns.length - 1; runIndex >= 0; runIndex -= 1) {
      const run = lineRuns[runIndex];
      for (let offset = 0; offset < run.length; offset += 1) {
        const runLength = run.length - offset;
        const close = nextRunByLength.get(runLength);
        if (close) closeByOpen.set(run.from + offset, { close: close.from, runLength });
      }
      nextRunByLength.set(run.length, run);
    }
    lineRuns = [];
  };

  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === "\n") {
      indexLine();
      cursor += 1;
      continue;
    }
    if (source[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    const from = cursor;
    while (source[cursor] === "`") cursor += 1;
    lineRuns.push({ from, length: cursor - from });
  }
  indexLine();
  return closeByOpen;
}

function markdownLinkAt(source, from) {
  if (source[from] !== "[") return null;
  const match = source.slice(from).match(
    /^\[([^\]\n]+)\]\(\s*([^\s)\n]+)(?:\s+(?:"([^"\n]*)"|&quot;((?:(?!&quot;)[^\n])*)&quot;))?\s*\)/
  );
  if (!match) return null;
  return {
    kind: "link",
    from,
    to: from + match[0].length,
    source: match[0],
    label: match[1],
    url: match[2],
    title: match[3] ?? match[4]
  };
}

function bareUrlAt(source, from) {
  const prefix = source.slice(from, from + 8).toLowerCase();
  if (!prefix.startsWith("http://") && !prefix.startsWith("https://")) return null;
  if (from > 0 && !/[\s(]/.test(source[from - 1])) return null;
  let to = from;
  while (to < source.length && !/[\s<]/.test(source[to])) to += 1;
  const candidate = source.slice(from, to);
  const trailing = candidate.match(/[.,;:)\]]+$/)?.[0] ?? "";
  to -= trailing.length;
  if (to <= from) return null;
  const url = source.slice(from, to);
  return { kind: "url", from, to, source: url, url };
}

/**
 * Split inline source once, before any renderer pass can inject HTML. Code spans use matching
 * backtick-run lengths; Markdown links protect label, URL, and title; bare URLs are protected
 * because this compiler turns them into anchors too.
 */
export function segmentInlineSource(source) {
  const segments = [];
  const codeCloseByOpen = indexCodeSpanClosers(source);
  let textFrom = 0;
  let cursor = 0;

  const pushProtected = (segment) => {
    if (textFrom < segment.from) {
      segments.push({
        kind: "text",
        from: textFrom,
        to: segment.from,
        source: source.slice(textFrom, segment.from)
      });
    }
    segments.push(segment);
    cursor = segment.to;
    textFrom = cursor;
  };

  while (cursor < source.length) {
    const protectedSegment =
      codeSpanAt(source, cursor, codeCloseByOpen)
      ?? markdownLinkAt(source, cursor)
      ?? bareUrlAt(source, cursor);
    if (protectedSegment) {
      pushProtected(protectedSegment);
      continue;
    }
    cursor += 1;
  }
  if (textFrom < source.length) {
    segments.push({
      kind: "text",
      from: textFrom,
      to: source.length,
      source: source.slice(textFrom)
    });
  }
  return segments;
}

/** Apply ==mark== only to a string already known to contain no protected source ranges. */
export function replaceMarkSyntax(text, replacement) {
  return text.replace(markerRegex(), (_match, inner) => replacement(inner));
}

/** Transform markers in ordinary source while leaving every protected byte unchanged. */
export function transformInlineMarks(source, replacement) {
  return segmentInlineSource(source)
    .map((segment) => segment.kind === "text"
      ? replaceMarkSyntax(segment.source, replacement)
      : segment.source)
    .join("");
}

/** Ranges cover only the marker interior; the editor leaves both == delimiters undecorated. */
export function inlineMarkRanges(source) {
  const ranges = [];
  for (const segment of segmentInlineSource(source)) {
    if (segment.kind !== "text") continue;
    const regex = markerRegex();
    let match;
    while ((match = regex.exec(segment.source))) {
      const from = segment.from + match.index + 2;
      ranges.push({ from, to: from + match[1].length });
    }
  }
  return ranges;
}
