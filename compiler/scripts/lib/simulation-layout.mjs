// AI chat and terminal simulation slides: {chat}, {chat-lanes}, {terminal}, {terminal-agent}.
//
// One deep module behind two calls (spec: docs/design/2026-10-08-ai-chat-and-terminal-simulation-
// designs/ai-chat-and-terminal-simulation-locked-spec.md, with the "Decisions after lock" appended):
//   annotateSimulationLayout(blocks, layout, attrs, slide, warn)  -- 08-source-adapters, beside
//     annotateCodeLayout: reads the options, picks the parser from the layout tag, stores the parsed
//     session on the fence block as `block.sim`, and raises the sim-* warnings.
//   renderSimulation(block)  -- 06-block-renderers: block.sim -> HTML. Every piece of author text
//     (turns, labels, tool payloads, titles) goes through escapeHtml, exactly as `trace` does.
//
// The module holds both parsers (labelled turns, shell session), the exchange state machine and the
// four renderers. Nothing here runs in the browser; the disclosure and step behaviour is CSS
// (layouts/simulation.css) plus the deck runtimes' `.sim-toggle` handlers, and typing / streaming
// is runtime/sim-typing.js (the markup only carries data-stream="on" on a streaming chat).
import { escapeHtml, slugify } from "./01-cli-utils.mjs";
import { resolveAuthoredMode } from "./02-triggers-layout.mjs";

export const SIMULATION_LAYOUTS = Object.freeze(["chat", "chat-lanes", "terminal", "terminal-agent"]);
/** Layout inferred from an untagged fence: ```chat -> chat, ```terminal -> terminal (same place `trace` is inferred). */
export const simulationLayoutForFence = (lang) => (SIM_FENCE_LANGS.has(lang) ? lang : "");
export const isSimulationLayout = (layout) => SIMULATION_LAYOUTS.includes(layout);
const SIM_FENCE_LANGS = new Set(["chat", "terminal"]);

// Which layouts an option belongs to. An option given to another layout is ignored with a hint.
const OPTION_APPLIES = Object.freeze({
  reveal: SIMULATION_LAYOUTS,
  size: SIMULATION_LAYOUTS,
  sidebar: ["chat", "chat-lanes"],
  stream: ["chat", "chat-lanes"],
  model: ["chat", "chat-lanes", "terminal-agent"],
  open: ["chat", "chat-lanes", "terminal-agent"],
  "window-title": ["terminal", "terminal-agent"]
});

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

const textOption = (attrs, key) => (typeof attrs?.[key] === "string" && attrs[key].trim() ? attrs[key].trim() : "");
const choiceOption = (attrs, key, allowed, fallback) => {
  const value = typeof attrs?.[key] === "string" ? attrs[key] : "";
  return allowed.includes(value) ? value : fallback;
};

/** Read every option for `layout`. `ignored` lists keys the author gave to a layout they do not apply to. */
export function simulationOptions(layout, attrs = {}) {
  const ignored = [];
  for (const [key, layouts] of Object.entries(OPTION_APPLIES)) {
    if (attrs[key] !== undefined && !layouts.includes(layout)) ignored.push(key);
  }
  const terminalAgent = layout === "terminal-agent";
  return {
    // {reveal}, {reveal=steps} and {mode=reveal} all mean step reveal; {mode=focus} is treated as reveal.
    reveal: resolveAuthoredMode(attrs) ? "steps" : "all",
    size: choiceOption(attrs, "size", ["compact", "large"], "compact"),
    sidebar: choiceOption(attrs, "sidebar", ["on", "off"], "on"),
    // stream=on: the answer and reasoning stream in as they come on screen (runtime/sim-typing.js).
    stream: choiceOption(attrs, "stream", ["on", "off"], "off"),
    model: textOption(attrs, "model") || "Model",
    open: choiceOption(attrs, "open", ["all", "none"], "none"),
    windowTitle: textOption(attrs, "window-title") || (terminalAgent ? "agent-cli" : "shell"),
    ignored
  };
}

/** The stepping mode a simulation slide carries: focus is treated as reveal (spec 5.2). */
export function simulationMode(layout, mode) {
  return isSimulationLayout(layout) && mode === "focus" ? "reveal" : mode;
}

// ---------------------------------------------------------------------------------------------
// Labelled turns: chat, chat-lanes, terminal-agent
// ---------------------------------------------------------------------------------------------

const LABEL_RE = /^(user|bot|model-reasoning|context-retrieval|tool-call|tool-results)(?:[ \t]*\(([^)]*)\))?[ \t]*:(.*)$/i;
const UNKNOWN_LABEL_RE = /^(assistant|model|agent|ai|system|human|reasoning|thinking|agent-reasoning|tool|tool-use|tool-result|tool-calls|context|retrieval)(?:[ \t]*\([^)]*\))?[ \t]*:/i;
const NEAREST_LABEL = Object.freeze({
  assistant: "bot", model: "bot", agent: "bot", ai: "bot", system: "user", human: "user",
  reasoning: "model-reasoning", thinking: "model-reasoning", "agent-reasoning": "model-reasoning",
  tool: "tool-call", "tool-use": "tool-call", "tool-calls": "tool-call",
  "tool-result": "tool-results", context: "context-retrieval", retrieval: "context-retrieval"
});

const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

/** Strip the indent common to every non-blank line. */
function dedent(lines) {
  let min = Infinity;
  for (const line of lines) if (line.trim()) min = Math.min(min, indentOf(line));
  if (!Number.isFinite(min) || min === 0) return lines.slice();
  return lines.map((line) => line.slice(Math.min(min, indentOf(line))));
}

/**
 * Lines of a tool payload (spec 1.5: verbatim). Only the turn's common continuation indent and the
 * blank lines that separate it from the labels around it are removed; internal blank lines and
 * trailing spaces are kept.
 */
function verbatimLines(head, continuation) {
  const lines = [...(head ? [head] : []), ...dedent(continuation)];
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

/** Text turn body: continuation lines join with a space, a blank line starts a new paragraph. */
function paragraphsOf(head, continuation) {
  const paragraphs = [];
  let current = [];
  for (const line of [head, ...continuation]) {
    const text = String(line).trim();
    if (!text) {
      if (current.length) paragraphs.push(current.join(" "));
      current = [];
    } else current.push(text);
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs;
}

/** `(4s)` -> "4 s"; `(250ms)` -> "250 ms"; `(2min)` -> "2 min"; anything else verbatim. */
export function formatSimDuration(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|min)$/i);
  return match ? `${match[1]} ${match[2].toLowerCase()}` : text;
}

/**
 * Parse a labelled-turn body into exchanges (spec 1.5 and 2).
 * Returns { exchanges, warnings } where each warning is [code, ...payload segments] without the slide id.
 * exchange = { user, parts, bot }; user/bot = { paragraphs }; part kinds:
 *   reasoning { duration, paragraphs } · context { sources } · tool { name, args, results|null } · result-only { lines }
 */
export function parseSimulationTurns(text) {
  const warnings = [];
  const source = dedent(String(text ?? "").replace(/\r\n?/g, "\n").split("\n"));
  const turns = [];
  let current = null;
  let before = false;
  for (const line of source) {
    const label = line.match(LABEL_RE);
    if (label) {
      current = { label: label[1].toLowerCase(), paren: label[2], head: label[3].replace(/^[ \t]+/, ""), continuation: [] };
      turns.push(current);
      continue;
    }
    const unknown = line.match(UNKNOWN_LABEL_RE);
    if (unknown) {
      const word = unknown[1].toLowerCase();
      warnings.push(["sim-unknown-label", word, NEAREST_LABEL[word]]);
    }
    if (current) current.continuation.push(line);
    else if (line.trim()) before = true;
  }
  if (before) warnings.push(["sim-text-before-label"]);

  const exchanges = [];
  let exchange = null;
  const fresh = () => ({ user: null, parts: [], bot: null });
  const hasContent = (ex) => Boolean(ex.user || ex.parts.length || ex.bot);
  const open = () => { if (!exchange) exchange = fresh(); return exchange; };
  const close = () => { if (exchange && hasContent(exchange)) exchanges.push(exchange); exchange = null; };

  for (const turn of turns) {
    if (turn.paren !== undefined && turn.label !== "model-reasoning") warnings.push(["sim-option-ignored", "duration"]);
    if (turn.label === "user") {
      if (exchange && hasContent(exchange)) close();
      const paragraphs = paragraphsOf(turn.head, turn.continuation);
      if (paragraphs.length) open().user = { paragraphs };
      continue;
    }
    // Everything else is a hidden part or the answer; an answer already given closes the exchange.
    if (exchange && exchange.bot) close();
    if (turn.label === "bot") {
      const paragraphs = paragraphsOf(turn.head, turn.continuation);
      if (paragraphs.length) open().bot = { paragraphs };
    } else if (turn.label === "model-reasoning") {
      const paragraphs = paragraphsOf(turn.head, turn.continuation);
      const duration = formatSimDuration(turn.paren);
      if (paragraphs.length || duration) open().parts.push({ kind: "reasoning", duration, paragraphs });
    } else if (turn.label === "context-retrieval") {
      const sources = verbatimLines(turn.head, turn.continuation)
        .map((line) => line.trim().replace(/^-\s+/, "").trim())
        .filter(Boolean);
      if (sources.length) open().parts.push({ kind: "context", sources });
      else warnings.push(["sim-context-empty"]);
    } else if (turn.label === "tool-call") {
      // First token = tool name; the rest is the arguments, verbatim: only the separator after the
      // name (spaces, or the one line break when the arguments start on the next line) is removed.
      const full = verbatimLines(turn.head, turn.continuation).join("\n");
      const name = (full.match(/^\S+/) || [""])[0];
      if (name) open().parts.push({ kind: "tool", name, args: full.slice(name.length).replace(/^[ \t]*\n?/, ""), results: null });
    } else if (turn.label === "tool-results") {
      const lines = verbatimLines(turn.head, turn.continuation);
      const target = open();
      // The nearest preceding tool call in this exchange that has no results yet (spec 1.5).
      let call = null;
      for (let i = target.parts.length - 1; i >= 0; i -= 1) {
        if (target.parts[i].kind === "tool" && target.parts[i].results === null) { call = target.parts[i]; break; }
      }
      if (call) call.results = lines;
      else {
        target.parts.push({ kind: "result-only", lines });
        warnings.push(["sim-results-without-call"]);
      }
    }
  }
  close();
  if (!exchanges.length) warnings.push(["sim-empty"]);
  return { exchanges, warnings };
}

// ---------------------------------------------------------------------------------------------
// Shell session: terminal
// ---------------------------------------------------------------------------------------------

const PROMPT_ONLY_RE = /^(?:(\S+) )?\$\s*$/;
const COMMAND_RE = /^(?:(\S+) )?\$ (.*)$/;

/**
 * Parse a shell session (spec 1.6). Returns { cmds, cursor, warnings }.
 * cmd = { prompt, command|null, out[] }: `command` is null for output that precedes any command.
 * cursor = { prompt }: the closing prompt with the block cursor (the fence's own last prompt-only
 * line, or one added automatically with the current path).
 */
export function parseShellSession(text) {
  const warnings = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) {
    warnings.push(["sim-empty"]);
    return { cmds: [], cursor: { prompt: "$" }, warnings };
  }
  const promptFor = (path) => (path ? `${path} $` : "$");
  let path = "";
  const cmds = [];
  let cursor = null;
  lines.forEach((raw, i) => {
    const escaped = raw.startsWith("\\") && (PROMPT_ONLY_RE.test(raw.slice(1)) || COMMAND_RE.test(raw.slice(1)));
    const line = escaped ? raw.slice(1) : raw;
    const bare = !escaped && line.match(PROMPT_ONLY_RE);
    const typed = !escaped && !bare && line.match(COMMAND_RE);
    if (bare || typed) {
      const match = bare || typed;
      if (match[1]) path = match[1];
      if (bare && i === lines.length - 1) { cursor = { prompt: promptFor(path) }; return; }
      cmds.push({ prompt: promptFor(path), command: bare ? "" : match[2], out: [] });
      return;
    }
    if (!cmds.length) cmds.push({ prompt: "", command: null, out: [] });
    cmds[cmds.length - 1].out.push(line);
  });
  return { cmds, cursor: cursor || { prompt: promptFor(path) }, warnings };
}

// ---------------------------------------------------------------------------------------------
// Annotation (the 08-source-adapters seam)
// ---------------------------------------------------------------------------------------------

/**
 * Annotate the slide's first chat/terminal fence with its parsed session. `slide` = { id, title }.
 * `warn` receives finished warning strings (`code:slideId:payload`). Blocks are mutated in place.
 */
export function annotateSimulationLayout(blocks, layout, attrs, slide, warn) {
  if (!isSimulationLayout(layout)) return;
  const slideId = String(slide?.id ?? "");
  const emit = (parts) => warn([parts[0], slideId, ...parts.slice(1)].join(":"));
  const fences = (blocks || []).filter((b) => b && b.type === "code" && SIM_FENCE_LANGS.has(b.lang));
  if (!fences.length) { emit(["sim-no-fence"]); return; }
  const [fence, ...extra] = fences;
  for (const block of extra) { block.simIgnored = true; emit(["sim-extra-fence"]); }

  const options = simulationOptions(layout, attrs);
  for (const key of options.ignored) emit(["sim-option-ignored", key]);
  if (fence.lang === "chat" && layout === "terminal") emit(["sim-fence-tag-mismatch"]);

  const sim = { design: layout, options, title: String(slide?.title ?? ""), idBase: slugify(slideId) || "slide" };
  const parsed = layout === "terminal"
    ? parseShellSession(fence.text)
    : parseSimulationTurns(fence.text);
  if (layout === "terminal") { sim.cmds = parsed.cmds; sim.cursor = parsed.cursor; }
  else sim.exchanges = parsed.exchanges;
  for (const w of parsed.warnings) emit(w);
  delete options.ignored;
  fence.sim = sim;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const ICON_PATHS = Object.freeze({
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowup: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  chevrondown: '<path d="M6 9l6 6 6-6"/>',
  spark: '<path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20.5 20.5l-5.4-5.4"/>',
  wrench: '<path d="M15.5 4.5a4.5 4.5 0 0 0-5.3 5.9L4 16.6V20h3.4l6.2-6.2a4.5 4.5 0 0 0 5.9-5.3l-2.7 2.7-2.6-.7-.7-2.6z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  thumb: '<path d="M7 11v9H4.5A1.5 1.5 0 0 1 3 18.5v-6A1.5 1.5 0 0 1 4.5 11H7l3.6-7a2.2 2.2 0 0 1 2.9 2.6L12.8 10H18a2 2 0 0 1 2 2.4l-1.1 6A2 2 0 0 1 17 20H7"/>',
  retry: '<path d="M20 11a8 8 0 0 0-14.8-3.2M4.5 4v4h4"/><path d="M4 13a8 8 0 0 0 14.8 3.2M19.5 20v-4h-4"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'
});

// Inline SVG, not a shared <use> sprite: a slide stays self-contained in the handout, thumbnails and
// the presenter preview iframes, and no duplicate ids reach the page.
const icon = (name, extra = "") =>
  `<svg class="sim-ic${extra ? ` ${extra}` : ""}" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
const chevron = () => icon("chevron", "sim-chevron");

const SIDEBAR_RECENT = Object.freeze(["Trip ideas", "Reply to Sam", "VAT question", "Weekly menu"]);

function makeIds(sim) {
  let n = 0;
  return () => `sim-${sim.idBase}-${++n}`;
}

const paragraphsHtml = (paragraphs, cls = "") =>
  paragraphs.map((p) => `<p${cls ? ` class="${cls}"` : ""}>${escapeHtml(p)}</p>`).join("");
const stepClass = (isStep) => (isStep ? " sim-step" : "");
const joinLines = (lines) => escapeHtml(lines.join("\n"));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function callHtml(part) {
  const args = part.args ? ` ${escapeHtml(part.args)}` : "";
  return `<code class="sim-call"><b>${escapeHtml(part.name)}</b>${args}</code>`;
}
function resultsBlock(lines) {
  return `<div class="sim-results"><p class="sim-results-head">${icon("check")}Tool results</p><pre class="sim-results-lines">${joinLines(lines)}</pre></div>`;
}
function sourcesList(sources) {
  return `<ul class="sim-sources">${sources.map((s) => `<li class="sim-source">${icon("doc")}<span>${escapeHtml(s)}</span></li>`).join("")}</ul>`;
}
const reasoningLabel = (part) => (part.duration ? `Thought for ${escapeHtml(part.duration)}` : "Reasoning");

// ---- chat (rows) ----

function rowsPart(part, nextId) {
  const id = nextId();
  const toggle = (iconName, label) =>
    `<button class="sim-toggle" type="button" aria-expanded="true" aria-controls="${id}">${icon(iconName)}<span>${label}</span>${chevron()}</button>`;
  if (part.kind === "reasoning") {
    return `<div class="sim-part sim-reasoning sim-step">${toggle("spark", reasoningLabel(part))}<div class="sim-body" id="${id}">${paragraphsHtml(part.paragraphs, "sim-reasoning-text")}</div></div>`;
  }
  if (part.kind === "context") {
    return `<div class="sim-part sim-context sim-step">${toggle("search", `Searched ${plural(part.sources.length, "source")}`)}<div class="sim-body" id="${id}">${sourcesList(part.sources)}</div></div>`;
  }
  if (part.kind === "tool") {
    const results = part.results ? resultsBlock(part.results) : "";
    return `<div class="sim-part sim-tool sim-step">${toggle("wrench", `Used ${escapeHtml(part.name)}`)}<div class="sim-body" id="${id}"><div class="sim-tool-detail">${callHtml(part)}${results}</div></div></div>`;
  }
  return `<div class="sim-part sim-result-only sim-step">${toggle("check", "Tool results")}<div class="sim-body" id="${id}"><div class="sim-tool-detail">${resultsBlock(part.lines)}</div></div></div>`;
}

// ---- chat-lanes (cards) ----

function lanesPart(part, nextId) {
  const id = nextId();
  const head = (iconName, label, control = "") =>
    `<div class="sim-part-head"><span class="sim-part-label">${icon(iconName)}${label}</span>${control}</div>`;
  const resultsControl = `<button class="sim-toggle sim-toggle-results" type="button" aria-expanded="true" aria-controls="${id}"><span class="sim-when-closed">Show results</span><span class="sim-when-open">Hide results</span>${chevron()}</button>`;
  if (part.kind === "reasoning") {
    const label = part.duration ? `Reasoning · ${escapeHtml(part.duration)}` : "Reasoning";
    return `<div class="sim-part sim-reasoning sim-step">${head("spark", label)}<div class="sim-body" id="${id}">${paragraphsHtml(part.paragraphs, "sim-reasoning-text")}</div></div>`;
  }
  if (part.kind === "context") {
    return `<div class="sim-part sim-context sim-step">${head("search", "Context retrieved")}<div class="sim-body" id="${id}">${sourcesList(part.sources)}</div></div>`;
  }
  if (part.kind === "tool") {
    const control = part.results ? resultsControl : "";
    const body = part.results ? `<div class="sim-body" id="${id}">${resultsBlock(part.results)}</div>` : "";
    return `<div class="sim-part sim-tool sim-step">${head("wrench", "Tool call", control)}${callHtml(part)}${body}</div>`;
  }
  return `<div class="sim-part sim-result-only sim-step">${head("check", "Tool results", resultsControl)}<div class="sim-body" id="${id}">${resultsBlock(part.lines)}</div></div>`;
}

const ACTIONS_HTML = `<div class="sim-actions" aria-hidden="true">${icon("copy")}${icon("thumb")}${icon("thumb", "sim-ic-flip")}${icon("retry")}</div>`;

function chatExchange(ex, index, sim, nextId) {
  const lanes = sim.design === "chat-lanes";
  const anchor = index === 0 && Boolean(ex.user);
  const hasParts = ex.parts.length > 0;
  let html = '<section class="sim-exchange">';
  if (ex.user) {
    const out = lanes && hasParts
      ? `<span class="sim-link sim-link-out${ex.bot ? "" : " sim-link-solo"}" aria-hidden="true"></span>`
      : "";
    html += `<div class="sim-turn sim-user${stepClass(!anchor)}"><p class="sim-bubble">${ex.user.paragraphs.map(escapeHtml).join("<br><br>")}</p>${out}</div>`;
  }
  if (hasParts) {
    const render = lanes ? lanesPart : rowsPart;
    html += `<div class="sim-behind">${ex.parts.map((p) => render(p, nextId)).join("")}</div>`;
  }
  if (ex.bot) {
    const link = lanes && hasParts
      ? `<span class="sim-link sim-link-in${ex.user ? "" : " sim-link-solo"}" aria-hidden="true"></span>`
      : "";
    html += `<div class="sim-turn sim-answer sim-step"><span class="sim-avatar" aria-hidden="true">${icon("spark")}</span><div class="sim-answer-text">${paragraphsHtml(ex.bot.paragraphs)}${ACTIONS_HTML}</div>${link}</div>`;
  }
  return `${html}</section>`;
}

function renderChat(sim) {
  const lanes = sim.design === "chat-lanes";
  const { options } = sim;
  const nextId = makeIds(sim);
  const sidebar = options.sidebar === "on"
    ? `<div class="sim-sidebar"><div class="sim-newchat">${icon("plus")}New chat</div><div class="sim-recent-label">Recent</div><div class="sim-recent sim-recent-current">${escapeHtml(sim.title)}</div>${SIDEBAR_RECENT.map((s) => `<div class="sim-recent">${s}</div>`).join("")}</div>`
    : "";
  const chrome = `<div class="sim-window" aria-hidden="true">${sidebar}<div class="sim-topbar"><span class="sim-model">${escapeHtml(options.model)}${icon("chevrondown")}</span></div><div class="sim-composer"><span class="sim-composer-plus">${icon("plus")}</span><span class="sim-composer-placeholder">Ask anything</span><span class="sim-composer-send">${icon("arrowup")}</span></div></div>`;
  const panel = lanes ? '<div class="sim-panel"><p class="sim-panel-title">Behind the scenes</p></div>' : "";
  const thread = sim.exchanges.map((ex, i) => chatExchange(ex, i, sim, nextId)).join("");
  return `<div class="${rootClasses(sim, `sim-chat ${lanes ? "sim-chat-lanes" : "sim-chat-rows"}`)}" data-sidebar="${options.sidebar}" data-open="${options.open}"${options.stream === "on" ? ' data-stream="on"' : ""}>${chrome}${panel}<div class="sim-scroll"><div class="sim-thread">${thread}</div></div></div>`;
}

// ---- terminal-agent ----

function agentExchange(ex, index, sim, nextId) {
  let html = '<section class="sim-exchange sim-agent-exchange">';
  if (ex.user) {
    html += `<div class="sim-promptbox${stepClass(!(index === 0))}"><span class="sim-gt">&gt;</span>${escapeHtml(ex.user.paragraphs.join(" "))}</div>`;
  }
  for (const part of ex.parts) {
    if (part.kind === "reasoning") {
      const dim = part.paragraphs.length ? `<span class="sim-dim">${escapeHtml(part.paragraphs.join(" "))}</span>` : "";
      const lead = part.duration ? `✻ Thinking for ${escapeHtml(part.duration)}… ` : "✻ Thinking… ";
      html += `<div class="sim-part sim-reasoning sim-step">${lead}${dim}</div>`;
    } else if (part.kind === "context") {
      const n = part.sources.length;
      html += `<div class="sim-part sim-context sim-step"><div class="sim-block-head"><span class="sim-bullet">●</span><b>Read</b>(${plural(n, "document")})</div>${part.sources.map((s) => `<div class="sim-sub"><span class="sim-elbow">⎿</span>${escapeHtml(s)}</div>`).join("")}</div>`;
    } else if (part.kind === "tool") {
      html += `<div class="sim-part sim-tool sim-step"><div class="sim-block-head"><span class="sim-bullet">●</span><b>${escapeHtml(part.name)}</b>(${escapeHtml(part.args)})</div>${part.results ? agentResults(part.results, nextId) : ""}</div>`;
    } else {
      html += `<div class="sim-part sim-result-only sim-step">${agentResults(part.lines, nextId)}</div>`;
    }
  }
  if (ex.bot) {
    const [first, ...more] = ex.bot.paragraphs;
    html += `<div class="sim-agent-answer sim-step"><span class="sim-bullet">●</span>${escapeHtml(first)}${more.map((p) => `<span class="sim-para-more">${escapeHtml(p)}</span>`).join("")}</div>`;
  }
  return `${html}</section>`;
}

function agentResults(lines, nextId) {
  if (!lines.length) return "";
  const [first, ...rest] = lines;
  const head = `<div class="sim-sub"><span class="sim-elbow">⎿</span>${escapeHtml(first)}</div>`;
  if (!rest.length) return `<div class="sim-results">${head}</div>`;
  const id = nextId();
  const more = rest.map((l) => `<div class="sim-sub sim-sub-more">${escapeHtml(l)}</div>`).join("");
  return `<div class="sim-results">${head}<div class="sim-body" id="${id}">${more}</div><button class="sim-toggle sim-more" type="button" aria-expanded="true" aria-controls="${id}"><span class="sim-when-closed">… +${rest.length} line${rest.length === 1 ? "" : "s"} (click to expand)</span><span class="sim-when-open">(click to collapse)</span></button></div>`;
}

function renderAgent(sim) {
  const { options } = sim;
  const nextId = makeIds(sim);
  const body = sim.exchanges.map((ex, i) => agentExchange(ex, i, sim, nextId)).join("");
  const promptBox = sim.exchanges.length ? "" : `<section class="sim-exchange sim-agent-exchange"><div class="sim-promptbox"><span class="sim-gt">&gt;</span></div></section>`;
  return `<div class="${rootClasses(sim, "sim-terminal sim-terminal-agent")}" data-open="${options.open}"><div class="sim-scroll"><div class="sim-term-body"><div class="sim-agent-head">◆ ${escapeHtml(options.windowTitle)}</div>${body}${promptBox}</div></div><div class="sim-status" aria-hidden="true"><span>⏵⏵ tools auto-approved</span><span>${escapeHtml(options.model)} · 12% context used</span></div></div>`;
}

// ---- terminal ----

function renderShell(sim) {
  const { options } = sim;
  const cursorLine = `<div class="sim-line"><span class="sim-prompt">${escapeHtml(sim.cursor.prompt)}</span> <span class="sim-cursor" aria-hidden="true"></span></div>`;
  const cmds = sim.cmds.map((cmd, i) => {
    const last = i === sim.cmds.length - 1;
    const typed = cmd.command === null ? "" : cmd.command
      ? `<div class="sim-line"><span class="sim-prompt">${escapeHtml(cmd.prompt)}</span> <kbd class="sim-typed">${escapeHtml(cmd.command)}</kbd></div>`
      : `<div class="sim-line"><span class="sim-prompt">${escapeHtml(cmd.prompt)}</span></div>`;
    const out = cmd.out.map((l) => `<div class="sim-line sim-out">${l ? escapeHtml(l) : "&nbsp;"}</div>`).join("");
    return `<div class="sim-cmd${stepClass(i > 0)}">${typed}${out}${last ? cursorLine : ""}</div>`;
  });
  // The closing cursor line rides the last command, so it is revealed with it; alone, it is the anchor.
  if (!sim.cmds.length) cmds.push(`<div class="sim-cmd">${cursorLine}</div>`);
  return `<div class="${rootClasses(sim, "sim-terminal sim-terminal-plain")}"><div class="sim-term-window"><div class="sim-term-bar" aria-hidden="true"><i class="sim-term-dot"></i><i class="sim-term-dot"></i><i class="sim-term-dot"></i><span class="sim-term-title">${escapeHtml(options.windowTitle)}</span></div><div class="sim-scroll"><div class="sim-term-body">${cmds.join("")}</div></div></div></div>`;
}

function rootClasses(sim, base) {
  return `sim ${base}${sim.options.size === "large" ? " sim-large" : ""}`;
}

/** Render a fence block annotated by annotateSimulationLayout. */
export function renderSimulation(block) {
  const sim = block?.sim;
  if (!sim) return "";
  if (sim.design === "terminal") return renderShell(sim);
  if (sim.design === "terminal-agent") return renderAgent(sim);
  return renderChat(sim);
}

/**
 * The handout / share rendering of a slide's simulation (spec section 8): the root gains
 * `sim-static` (every part open, no controls, every step shown) and the controls leave the tab
 * order. Slide HTML without a simulation is returned unchanged. Author text cannot match these
 * patterns: it is HTML-escaped, so it never contains a literal `<div class="sim ` or `<button`.
 */
export function simulationStatic(html) {
  const text = String(html ?? "");
  if (!text.includes('<div class="sim ')) return text;
  return text
    .replace(/<div class="sim (?!sim-static)/g, '<div class="sim sim-static ')
    .replace(/<button class="sim-toggle/g, '<button tabindex="-1" class="sim-toggle');
}
