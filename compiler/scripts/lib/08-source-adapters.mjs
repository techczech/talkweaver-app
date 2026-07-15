import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { args, slugify, parseGridDims, escapeHtml } from "./01-cli-utils.mjs";
import { parseHeadingAttrs, parseTriggerLine, resolveAuthoredMode, parseCountdownDuration, SPINE_STOPS_PER_SLIDE, renderInline, accentForSectionName, backgroundTintForName } from "./02-triggers-layout.mjs";
import { lexMarkdownBlocks } from "./03-markdown-lexer.mjs";
import { extractTitle, updateDeckTitle } from "./04-html-extraction.mjs";
import { collectIconGapTerms, collectSemanticIconNeeds, collectIconSuggestions, collectIconlistNoIcons } from "./05-icons.mjs";
import { mapBlocksToLayout } from "./06-block-renderers.mjs";
import { buildDeckHtmlFromModel, adaptCanonicalPptJson, adaptLearnWeaverExport } from "./07-assembly.mjs";
import { resolveSlideFrame, FRAME_BUILTINS } from "./11-frame.mjs";
import { parseOutlineTree } from "./14-outline-tree.mjs";
import { sequence } from "./15-sequencer.mjs";

// =============================================================================
// 8. Source adapters — outline v2/v1, JSON, static HTML -> model; prepareSource dispatches
// =============================================================================

function markdownLinesToHtml(lines) {
  const html = [];
  let paragraph = [];
  let list = [];
  // Notes are Markdown too: render inline emphasis / code / links (renderInline escapes first,
  // so these are safe and not double-escaped).
  function flushParagraph() {
    if (paragraph.length) {
      html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  }
  function flushList() {
    if (list.length) {
      html.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
      list = [];
    }
  }
  let fenceLines = null; // non-null while inside a code fence — lines collected verbatim
  let fenceMark = "";    // the opening backtick run; a closing fence must be ≥ this length
  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,})(.*)$/);
    // Fenced code (```/```lang, length-aware so a 4-backtick wrapper survives inner ``` fences):
    // collect raw lines and emit a <pre><code> verbatim. Lets notes show literal Markdown (e.g.
    // the slide's own source) instead of re-rendering it.
    if (fenceLines === null && fenceMatch) {
      flushParagraph(); flushList(); fenceLines = []; fenceMark = fenceMatch[1]; continue;
    }
    if (fenceLines !== null) {
      if (fenceMatch && fenceMatch[2].trim() === "" && fenceMatch[1].length >= fenceMark.length) {
        html.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`); fenceLines = null; fenceMark = "";
      } else {
        fenceLines.push(line);
      }
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      html.push(`<h${level}>${escapeHtml(headingMatch[2])}</h${level}>`);
      continue;
    }
    const listMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (listMatch) {
      flushParagraph();
      list.push(listMatch[1]);
    } else {
      flushList();
      paragraph.push(trimmed);
    }
  }
  if (fenceLines !== null) html.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return html.join("\n") || "<p></p>";
}

function parseYamlScalar(value) {
  const trimmed = String(value).trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed === "[]") return [];
  if (/^["'].*["']$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseInlineMap(s) {
  const body = s.trim().replace(/^\{/, "").replace(/\}$/, "");
  const obj = {};
  for (const pair of body.split(",")) {
    const i = pair.indexOf(":"); if (i < 0) continue;
    obj[pair.slice(0, i).trim()] = parseYamlScalar(pair.slice(i + 1).trim());
  }
  return obj;
}

function parseSimpleYaml(value) {
  const data = {};
  let parentKey = null;
  for (const rawLine of value.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const childMatch = rawLine.match(/^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (childMatch && parentKey && typeof data[parentKey] === "object" && !Array.isArray(data[parentKey])) {
      const childScalar = childMatch[2];
      data[parentKey][childMatch[1]] = (childScalar.startsWith("{") && childScalar.trimEnd().endsWith("}"))
        ? parseInlineMap(childScalar)
        : parseYamlScalar(childScalar);
      continue;
    }
    const match = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const scalar = match[2];
    if (scalar.startsWith("{") && scalar.trimEnd().endsWith("}")) {
      data[key] = parseInlineMap(scalar);
      parentKey = null;
    } else if (scalar === "") {
      data[key] = {};
      parentKey = key;
    } else {
      data[key] = parseYamlScalar(scalar);
      parentKey = null;
    }
  }
  return data;
}

function parseMarkdownSource(markdown) {
  let frontmatter = {};
  let body = markdown;
  if (markdown.startsWith("---")) {
    const end = markdown.indexOf("\n---", 3);
    if (end >= 0) {
      frontmatter = parseSimpleYaml(markdown.slice(3, end).trim());
      body = markdown.slice(end + 4).replace(/^\r?\n/, "");
    }
  }
  const bodyLines = [];
  const notesLines = [];
  let inNotes = false;
  for (const line of body.split(/\r?\n/)) {
    if (line.trim().toLowerCase() === ":::notes") {
      inNotes = true;
      continue;
    }
    if (line.trim() === ":::" && inNotes) {
      inNotes = false;
      continue;
    }
    if (inNotes) notesLines.push(line);
    else bodyLines.push(line);
  }
  const heading = bodyLines.find((line) => line.match(/^#\s+/))?.replace(/^#\s+/, "").trim() || "";
  return {
    frontmatter,
    title: frontmatter.title || heading,
    html: markdownLinesToHtml(bodyLines),
    notes: markdownLinesToHtml(notesLines)
  };
}

const slideRoles = new Set(["opening", "ending", "section-title", "subsection-title", "content", "linking"]);

function defaultReuseForRole(role) {
  if (role === "content") return { importance: "core", reusable: true };
  if (role === "linking") return { importance: "contextual", reusable: false };
  return { importance: "structural", reusable: false };
}

function normalizeRole(role, warnings, slideId) {
  const normalized = role || "content";
  if (slideRoles.has(normalized)) return normalized;
  warnings.push(`invalid-slide-role:${slideId}:${normalized}`);
  return "content";
}

async function adaptSourceProject(projectDir, explicitTitle) {
  const structurePath = join(projectDir, "presentation.structure.json");
  const structureText = await readFile(structurePath, "utf8");
  const structure = JSON.parse(structureText);
  const warnings = [];
  const slides = [];
  for (const [index, entry] of (structure.slides || []).entries()) {
    const rawId = entry.id || `slide-${index + 1}`;
    const sourceRef = entry.source || "";
    let parsed = { frontmatter: {}, title: "", html: "", notes: "" };
    if (sourceRef) {
      parsed = parseMarkdownSource(await readFile(resolve(projectDir, sourceRef), "utf8"));
    }
    const frontmatter = parsed.frontmatter || {};
    const role = normalizeRole(entry.role || frontmatter.role, warnings, rawId);
    if (!sourceRef && role !== "linking") warnings.push(`missing-source-ref:${rawId}`);
    const id = entry.id || frontmatter.id || rawId;
    const message = entry.message || frontmatter.message || "";
    const preparesFor = entry.prepares_for || entry.preparesFor || frontmatter.prepares_for || frontmatter.preparesFor || "";
    if (role === "linking" && !preparesFor) warnings.push(`linking-slide-missing-target:${id}`);
    const reuse = entry.reuse || frontmatter.reuse || defaultReuseForRole(role);
    slides.push({
      id,
      section: entry.section || frontmatter.section || "",
      subsection: entry.subsection || frontmatter.subsection || "",
      role,
      navTitle: entry.navTitle || entry.nav_title || frontmatter.navTitle || frontmatter.nav_title || parsed.title || message || id,
      title: entry.title || frontmatter.title || parsed.title || message || id,
      layout: entry.layout || frontmatter.layout || role,
      html: parsed.html || (message ? `<p>${escapeHtml(message)}</p>` : ""),
      message,
      prepares_for: preparesFor,
      reuse,
      notes: entry.notes || frontmatter.notes || parsed.notes || ""
    });
  }
  return {
    title: explicitTitle || structure.title || basename(projectDir),
    sourceType: "source-project",
    adapter: "source-project-v1",
    contentSchemaVersion: structure.schema_version ? `source-project-${structure.schema_version}` : "source-project-v1",
    sourceRef: "source/presentation.structure.json",
    sourceLabel: "presentation.structure.json",
    sourceHashInput: structureText,
    sourceCopyFrom: projectDir,
    sourceModel: {
      structure_ref: "source/presentation.structure.json",
      section_count: Array.isArray(structure.sections) ? structure.sections.length : 0,
      subsection_count: Array.isArray(structure.sections) ? structure.sections.reduce((count, section) => count + (Array.isArray(section.subsections) ? section.subsections.length : 0), 0) : 0,
      slide_count: slides.length,
      roles: Object.fromEntries([...slideRoles].map((roleName) => [roleName, slides.filter((slide) => slide.role === roleName).length])),
      reuse: slides.reduce((summary, slide) => {
        const importance = slide.reuse?.importance || defaultReuseForRole(slide.role).importance;
        summary[importance] = (summary[importance] || 0) + 1;
        return summary;
      }, {})
    },
    warnings,
    slides
  };
}

function adaptMarkdownOutline(markdown, fallbackTitle) {
  const lines = markdown.split(/\r?\n/);
  let title = fallbackTitle;
  let section = "";
  let current = null;
  let inNotes = false;
  const slides = [];
  function flush() {
    if (!current) return;
    slides.push({
      id: current.id,
      section: current.section,
      title: current.title,
      navTitle: current.title,
      html: markdownLinesToHtml(current.body),
      notes: markdownLinesToHtml(current.notes)
    });
  }
  for (const line of lines) {
    const titleMatch = line.match(/^#\s+(.+)/);
    const sectionMatch = line.match(/^##\s+(.+)/);
    const slideMatch = line.match(/^###\s+(.+)/);
    if (titleMatch && !line.startsWith("##")) {
      title = titleMatch[1].trim();
      continue;
    }
    if (sectionMatch && !line.startsWith("###")) {
      flush();
      current = null;
      section = sectionMatch[1].trim();
      inNotes = false;
      continue;
    }
    if (slideMatch) {
      flush();
      const slideTitle = slideMatch[1].trim();
      current = { id: slugify(slideTitle) || `slide-${slides.length + 1}`, section, title: slideTitle, body: [], notes: [] };
      inNotes = false;
      continue;
    }
    if (!current) continue;
    if (line.trim().toLowerCase() === ":::notes") {
      inNotes = true;
      continue;
    }
    if (line.trim() === ":::" && inNotes) {
      inNotes = false;
      continue;
    }
    if (inNotes) current.notes.push(line);
    else current.body.push(line);
  }
  flush();
  return {
    title,
    sourceType: "markdown-outline",
    adapter: "markdown-outline-v1",
    contentSchemaVersion: null,
    warnings: [],
    slides
  };
}

// === Deck license (2026-06-13) ===
// Frontmatter → a license object for the footer popup, or null. Common Creative Commons codes
// expand to a friendly name + canonical URL; anything else is kept verbatim (with an optional
// explicit `license-url`). `credits` / `attribution` (string or list) carry icon/asset notices;
// `license-note` is free text. No dedicated slide — this rides the deck chrome.
const CC_VARIANTS = {
  "by": "BY", "by-sa": "BY-SA", "by-nc": "BY-NC", "by-nd": "BY-ND",
  "by-nc-sa": "BY-NC-SA", "by-nc-nd": "BY-NC-ND",
};
export function parseLicense(meta) {
  if (!meta || typeof meta !== "object") return null;
  const raw = meta.license != null ? String(meta.license).trim() : "";
  const explicitUrl = meta["license-url"] || meta.licenseUrl || "";
  const note = meta["license-note"] || meta.licenseNote || "";
  // Credits accept several shapes (the minimal frontmatter parser yields a MAP for a nested
  // block, since it has no block-sequence support): a string, an array of strings, or a
  // {label: detail} map → each becomes a "label: detail" line.
  const entryToLine = (k, v) => (v == null || v === "" ? String(k) : `${k}: ${v}`);
  const coerceCredits = (c) => {
    if (c == null) return [];
    if (typeof c === "string") return c.trim() ? [c.trim()] : [];
    if (Array.isArray(c)) return c.map((it) => (it && typeof it === "object" && !Array.isArray(it)
      ? Object.entries(it).map(([k, v]) => entryToLine(k, v)).join(", ")
      : String(it).trim())).filter(Boolean);
    if (typeof c === "object") return Object.entries(c).map(([k, v]) => entryToLine(k, v)).filter(Boolean);
    return [];
  };
  let credits = coerceCredits(meta.credits ?? meta.attribution ?? meta["icon-credits"] ?? null);
  credits = credits.length ? credits : null;
  if (!raw && !credits && !note) return null;

  let name = raw, url = explicitUrl;
  if (raw) {
    // Normalise "CC-BY-4.0", "CC BY 4.0", "cc by sa", "by-nc" → variant + version.
    const cleaned = raw.toLowerCase().replace(/^cc[\s-]*/, "").replace(/\s+/g, "-");
    const versionMatch = cleaned.match(/-?(\d(?:\.\d)?)$/);
    const version = versionMatch ? versionMatch[1] : "4.0";
    const variantKey = cleaned.replace(/-?\d(?:\.\d)?$/, "");
    if (variantKey === "0" || /^(cc0|zero|publicdomain)$/.test(variantKey) || /^cc0/.test(raw.toLowerCase())) {
      name = "CC0 1.0"; url = url || "https://creativecommons.org/publicdomain/zero/1.0/";
    } else if (CC_VARIANTS[variantKey]) {
      name = `CC ${CC_VARIANTS[variantKey]} ${version}`;
      url = url || `https://creativecommons.org/licenses/${variantKey}/${version}/`;
    } // else: unknown — keep `raw` as the name, use explicitUrl if any.
  }
  return { name: name || null, url: url || "", credits, note: note ? String(note).trim() : "" };
}

// Render the license popup body (shared by the full deck — 07-assembly — and the share export —
// 09-output-builders). Escapes all text; the licence name links to its URL when known.
export function renderLicenseBody(license) {
  if (!license) return "";
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const parts = ["<h3>License</h3>"];
  if (license.name) {
    parts.push(license.url
      ? `<p class="license-name"><a href="${esc(license.url)}" target="_blank" rel="noopener noreferrer">${esc(license.name)}</a></p>`
      : `<p class="license-name">${esc(license.name)}</p>`);
  }
  if (license.note) parts.push(`<p class="license-note">${esc(license.note)}</p>`);
  if (Array.isArray(license.credits) && license.credits.length) {
    parts.push(`<h4>Credits</h4><ul class="license-credits">${license.credits.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`);
  }
  return parts.join("");
}

export function adaptMarkdownOutlineV2(markdown, fallbackTitle, defaults) {
  let body = markdown;
  let meta = {};
  if (markdown.startsWith("---")) {
    const end = markdown.indexOf("\n---", 3);
    if (end >= 0) {
      meta = parseSimpleYaml(markdown.slice(3, end).trim());
      // Blank the frontmatter IN PLACE (keep its newlines) instead of removing it, so a body line
      // index equals the real source line number — the per-slide sourceLine must point at the true
      // outline line for the editor↔strip sync (no drift).
      const fmEnd = end + 4;
      body = markdown.slice(0, fmEnd).replace(/[^\n]/g, "") + markdown.slice(fmEnd);
    }
  }
  // Strip HTML comment blocks (`<!-- … -->`) so authors can leave notes/provenance/TODOs without
  // them rendering. Blank the content but PRESERVE newlines (so line numbers stay source-accurate).
  // A commented-out `## …`/`### …` heading is still ignored (its text is blanked).
  body = body.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));
  const rawSourceLines = String(markdown ?? "").split(/\r?\n/);
  const tree = parseOutlineTree(body);
  const warnings = [...(tree.warnings || [])];
  const root = tree.root;
  const sections = [];
  const slides = [];
  // hide_email (2026-06-22): strip the contact email out of the author byline so the title and
  // thank-you slides show just the name — no obfuscation, no "hidden"/placeholder text. The email
  // commonly lives inside the author string, e.g. `Dominik Lukeš (name@host)`; remove it and any
  // surrounding ()/<> and tidy the whitespace. Frontmatter `hide_email: true` (or `hide-email`).
  const hideEmail = (() => {
    const v = meta.hide_email ?? meta["hide-email"];
    return v === true || (typeof v === "string" && /^(true|yes|on|1)$/i.test(v.trim()));
  })();
  if (hideEmail && typeof meta.author === "string") {
    meta.author = meta.author
      .replace(/\s*[(<]?\s*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*[)>]?/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  let title = meta.title || tree.meta?.title || fallbackTitle;
  // Deck-level palette ({palette:green}, 2026-06-09). Frontmatter `palette:` wins; otherwise a
  // `{palette=green}` trigger seen on ANY slide heading sets it deck-wide (it is a deck setting,
  // not a per-slide one). Only the known alternate ("green") is honoured; anything else stays
  // on the default Oxford-blue/crimson cycle. flushSlide() records the first seen value below.
  let deckPalette = typeof meta.palette === "string" ? meta.palette.trim().toLowerCase() : "";
  // Frame defaults (Wave 1, task 2): frontmatter `defaults:` sets deck-level frame attrs;
  // `sections:` maps section titles to per-section frame overrides. Attached to every slide.
  const deckDefaults = (meta.defaults && typeof meta.defaults === "object") ? meta.defaults : {};
  const sectionDefaultsMap = (meta.sections && typeof meta.sections === "object") ? meta.sections : {};
  const frameFor = (s) =>
    resolveSlideFrame(s.attrs || {}, sectionDefaultsMap[s.sectionTitle] || {}, deckDefaults);
  // SD-14: true when the slide (or its section/deck defaults) explicitly sets image= so the
  // split layout activates. Without this flag, frame.image always resolves to the builtin "left",
  // which would force a split on any slide that happens to have an image + other blocks.
  const frameImageExplicitFor = (s) => {
    const rawAttrs = s.attrs || {};
    const sectionDef = sectionDefaultsMap[s.sectionTitle] || {};
    return (rawAttrs.image != null || rawAttrs.media != null)
      || (sectionDef.image != null || sectionDef.media != null)
      || (deckDefaults.image != null || deckDefaults.media != null);
  };
  // 2026-07-08: true when title=/sidebar was explicitly authored on the slide, its section
  // defaults, or the deck defaults. Needed because frame.title resolves to the builtin "top"
  // when unset, so "author wrote {title=top}" is indistinguishable from "nothing set" — and an
  // explicit top must override quote/statement/notitle hide defaults (same as title=side does).
  const frameTitleExplicitFor = (s) => {
    const rawAttrs = s.attrs || {};
    const sectionDef = sectionDefaultsMap[s.sectionTitle] || {};
    // title=show/compact are titleMode values, not frame placement — they must not count
    // as an explicit frame title (they'd wrongly force top placement on left-rail layouts).
    const frameTitleValue = (v) => v != null && v !== "show" && v !== "compact";
    return (frameTitleValue(rawAttrs.title) || rawAttrs.sidebar != null)
      || (frameTitleValue(sectionDef.title) || sectionDef.sidebar != null)
      || (frameTitleValue(deckDefaults.title) || deckDefaults.sidebar != null);
  };

  // section_labels: default OFF (2026-06-24); opt in with `section_labels: on`. An explicit
  // {kicker=…} still shows.
  const sectionLabelRaw = meta.section_labels ?? meta["section-labels"];
  const sectionLabels = sectionLabelRaw === true || /^(on|true|yes|show)$/i.test(String(sectionLabelRaw ?? ""));
  const autoKicker = (s) => s.attrs.kicker || (sectionLabels ? s.sectionTitle || "" : "");
  // Presenter talk clock (2026-06-12): frontmatter `duration: 60min` (any countdown duration
  // form) puts a remaining-time readout next to the presenter's elapsed clock.
  let durationSeconds = 0;
  if (meta.duration != null) {
    const parsed = parseCountdownDuration(meta.duration);
    if (parsed && parsed > 0) durationSeconds = parsed;
    else warnings.push(`duration-unparsed:${meta.duration}`);
  }
  // Presenter clock amber/dark-amber thresholds (Task 3): frontmatter `warn-at:` / `urgent-at:`
  // (whole minutes before the deadline) override the Settings global default (threaded in via
  // `defaults`), which itself falls back to 5/1. urgentAt is clamped so it never exceeds warnAt.
  const warnAtRaw = meta["warn-at"] ?? meta.warn_at ?? defaults?.warnAtMinutes ?? 5;
  const urgentAtRaw = meta["urgent-at"] ?? meta.urgent_at ?? defaults?.urgentAtMinutes ?? 1;
  const warnAtMinutes = Number(warnAtRaw);
  const urgentAtMinutes = Math.min(Number(urgentAtRaw), warnAtMinutes);
  // Deck font (ADR-0005, locked 2026-07-11): Trebuchet MS is the face; frontmatter
  // `font: gill-sans` / `font: verdana` are the sanctioned user options. Anything else warns
  // and falls back to the default stack.
  const fontRaw = String(meta.font ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  const deckFont = ["gill-sans", "verdana"].includes(fontRaw) ? fontRaw : "";
  if (fontRaw && !deckFont && fontRaw !== "trebuchet" && fontRaw !== "trebuchet-ms") warnings.push(`font-unknown:${meta.font}`);
  // Deck license (2026-06-13): frontmatter `license:` (+ credits/note/url) → a footer popup,
  // never a dedicated slide. parseLicense expands common CC codes to a friendly name + URL.
  const license = parseLicense(meta);
  const subsections = []; // Flat record of section-like nodes below `##` {id, section, title}
  let slide = null;

  // ADR-0015 — frontmatter `triggers:` is the deck-wide DEFAULTS level: the same vocabulary
  // (bare words / key=value, space-separated, no braces needed), applied to every `###` slide
  // and overridden by anything the slide sets itself (precedence: trigger line > heading >
  // frontmatter). Per-slide-only keys make no sense deck-wide and are barred with a warning:
  // layout (and its bare-word shorthands) and id.
  const deckTriggerDefaults = {};
  if (typeof meta.triggers === "string" && meta.triggers.trim()) {
    const parsed = parseHeadingAttrs(`{${meta.triggers.replace(/[{}]/g, " ").trim()}}`);
    for (const w of parsed.warnings || []) warnings.push(w);
    for (const [key, value] of Object.entries(parsed.attrs)) {
      if (key === "layout" || key === "id") {
        warnings.push(`frontmatter-trigger-ignored:${key}=${value}`);
        continue;
      }
      deckTriggerDefaults[key] = value;
    }
  }

  function inferLayout(s) {
    if (s.attrs.layout) return s.attrs.layout;
    // Value-form statement triggers imply their layout just as {contrast=tint} implies contrast.
    if (s.attrs.statement != null) return "statement";
    // {2col}/{3col} resolve to a bare `cols` attr with no explicit layout — pin the columns
    // layout when a column count is present (a `cols=N` always means "lay these out in columns").
    if (s.attrs.cols != null && s.attrs.cols !== true) return "columns";
    // {timeline=dynamic|rail|…} without a bare {timeline}: the mode attr alone means timeline
    // (the cols→columns / chart-shape pattern).
    if (s.attrs.timeline != null && s.attrs.timeline !== true) return "timeline";
    // {barchart}/{piechart}/{linechart}/{curve} resolve to a bare `chart` attr with no explicit
    // layout — any chart shape means "draw this as a chart" (the cols→columns pattern).
    if (s.attrs.chart != null && s.attrs.chart !== true) return "chart";
    // {curve=sigmoid}: `curve` as a VALUE attr means the conceptual S-curve layout. (Bare {curve}
    // resolves to chart=line via the dictionary and never sets a `curve` attr, so no clash.)
    if (s.attrs.curve === "sigmoid") return "sigmoid";
    // {contrast=cards} (the legacy pair-card device) is a `contrast` VALUE attr with no explicit
    // layout — asking for a contrast variant means the contrast layout.
    if (s.attrs.contrast != null && s.attrs.contrast !== true) return "contrast";
    if (s.attrs.equation != null && s.attrs.equation !== true) return "equation";
    // {blocks:RxC} pins a grid's dimensions, so it also IMPLIES the grid layout when no explicit
    // layout is set (an author writing `{blocks:3x3}` wants a grid).
    if (parseGridDims(s.attrs.blocks)) return "grid";
    // {cards=stepped} sets a `cards` VALUE attr (no explicit layout); asking for a cards variant
    // means the cards layout (the cols→columns pattern). Bare {cards} sets layout=cards above.
    if (s.attrs.cards != null && s.attrs.cards !== true) return "cards";
    if (s.cards.length) return "cards";
    const blocks = lexMarkdownBlocks(s.lines);
    const hasMedia = blocks.some((b) => ["image", "embed", "video"].includes(b.type));
    const hasList = blocks.some((b) => b.type === "list");
    const hasParagraph = blocks.some((b) => b.type === "paragraph");
    const hasQuote = blocks.some((b) => b.type === "quote");
    const hasText = hasList || hasParagraph || hasQuote;
    // A slide carrying a fenced code/trace block (and no media) is a code slide: a `trace` block
    // gets the trace layout, any other code gets the generic code layout. The big title rides
    // above the panel. Media + code still falls through to copy-visual/media below.
    const codeBlock = blocks.find((b) => b.type === "code");
    if (codeBlock && !hasMedia) return codeBlock.lang === "trace" ? "trace" : "code";
    // A timeline is a graphical element (like media). When it is paired with a COMMENT — a
    // standalone paragraph or quote, no other media — lay the two side by side (timeline one
    // column, comment beside, centred as a unit) instead of stacking the comment under the
    // rail. This reuses the copy-/list-visual column grammar (Fix 1). A timeline with a list
    // (not a comment), or a bare timeline, keeps the single-column `timeline` layout.
    if (blocks.some((b) => b.type === "timeline")) {
      const hasComment = (hasParagraph || hasQuote) && !hasMedia && !hasList;
      return hasComment ? "timeline-visual" : "timeline";
    }
    // F1: media + list only (no paragraphs, no quotes) → list-visual two-column layout.
    // The big title is kept; the feature-list fills one column, the media the other.
    if (hasMedia && hasList && !hasParagraph && !hasQuote) return "list-visual";
    // A table counts as text-like content here (2026-06-09): table + screenshot slides were
    // falling through to the stacked full-width media layout; they read far better as the
    // copy-visual pair (image left, table right).
    if (hasMedia && (hasText || blocks.some((b) => b.type === "table"))) return "copy-visual";
    if (hasMedia) return "media";
    // Quote-only slide: the slide's whole content is one (or more) `>` quote block(s) and
    // nothing else structural — no list, no media, no paragraph, no timeline/table/code. The
    // quote IS the slide, full-bleed; the heading is NAV-ONLY by default (not drawn — see the
    // titleMode default for `quote`). Re-show the heading with `{title=show}`.
    if (hasQuote && !hasList && !hasParagraph
        && !blocks.some((b) => ["timeline", "table", "code"].includes(b.type))) {
      return "quote";
    }
    // Prose-only slide: at least one paragraph and nothing else structural (no list,
    // media, timeline, table, quote). The paragraph IS the point — render it as a
    // statement (large, beside the title), not as an empty list.
    const hasStructural = blocks.some((b) =>
      ["list", "timeline", "table", "quote"].includes(b.type));
    if (hasParagraph && !hasStructural) return "statement";
    return "list";
  }

  // ADR-0022: the automatic stepped MEDIA gallery (buildMediaGalleryCards) is REMOVED. A slide
  // with 2+ images and no ####/{carousel} is a GALLERY now — a grid on ONE slide (the normal media
  // / copy-visual layout groups consecutive images into a side-by-side .figure-row), all visible,
  // with the existing lightbox to enlarge and step through. Stepping is opt-in via #### or
  // {carousel} (the carousel path), never inferred from image count.

  // Inside a #### card, authors sometimes write a quotation as plain prose paragraphs
  // (no `>`) followed by a short attribution line — italic source + year, or a line
  // starting with an em dash. Promote that shape to a real quote block (blockquote + cite)
  // so it gets serif quote styling instead of looking like body copy. Conservative: only
  // when the card body is ENTIRELY prose paragraphs (no media/list/embed/existing quote)
  // AND the final paragraph looks like an attribution. Cards with media keep their blocks.
  const ATTRIBUTION_RE = /^[—–-]\s+\S/; // leading em/en dash + content
  function looksLikeAttribution(text) {
    if (!text) return false;
    if (ATTRIBUTION_RE.test(text)) return true;
    // Short-ish line carrying a *italic source* and a 4-digit year (e.g. "*The New York Times*, 1958").
    return text.length <= 140 && /\*[^*]+\*/.test(text) && /\b(1[89]\d\d|20\d\d)\b/.test(text);
  }
  // Type-floor rule: lists inside #### cards get the same feature-list treatment as
  // slide-level lists (style decided per list — icons/numbers/plain) instead of a tiny
  // generic <ul>. `static: true` suppresses per-item data-fragment: the CARDS are the
  // reveal steps; nested fragments would corrupt gallery stepping.
  function featurizeCardBlocks(blocks) {
    if (!Array.isArray(blocks)) return blocks;
    return blocks.map((b) => (b && b.type === "list" && Array.isArray(b.items)
      ? { ...b, type: "feature-list", static: true }
      : b));
  }

  // ADR-0021 adaptive layouts: {cards} over a FLAT top-level list (no #### cards, no media
  // gallery) becomes one card per top-level bullet — title = the item text, the item's
  // sub-bullets = that card's body. Unambiguous shape → adapt silently (the explicit path is
  // #### cards, which the picker's ⌘-Enter template inserts). Returns the card list, or null
  // when there is no usable list (let the normal flow render whatever is there).
  function cardsFromList(rawBlocks) {
    const list = rawBlocks.find((b) => b && b.type === "list" && Array.isArray(b.items) && b.items.length);
    if (!list) return null;
    const childTrees = Array.isArray(list.children) ? list.children : [];
    return list.items.map((text, i) => {
      const kids = Array.isArray(childTrees[i]) ? childTrees[i] : [];
      const blocks = kids.length
        ? featurizeCardBlocks([{
            type: "list", ordered: false,
            items: kids.map((k) => k.text),
            children: kids.map((k) => (Array.isArray(k.children) ? k.children : []))
          }])
        : [];
      return { title: text, blocks };
    });
  }

  function quotifyCardBlocks(blocks) {
    if (!Array.isArray(blocks) || blocks.length < 2) return blocks;
    if (!blocks.every((b) => b && b.type === "paragraph")) return blocks;
    const last = blocks[blocks.length - 1];
    if (!looksLikeAttribution(last.text)) return blocks;
    const bodyParas = blocks.slice(0, -1).map((b) => b.text).filter(Boolean);
    if (!bodyParas.length) return blocks;
    const cite = last.text.replace(/^[—–-]\s*/, "").trim();
    return [{
      type: "quote",
      text: bodyParas.join(" ").trim(),
      paragraphs: bodyParas,
      cite
    }];
  }

  // E3: a #### card whose body carries MULTIPLE quote blocks (e.g. two `>` groups from the
  // same source) becomes MULTIPLE gallery cards — one quote per card — so each quote reads
  // on its own focused card instead of stacking unevenly. Each split card keeps the original
  // card's h4 title (the cite differentiates them; no "(cont.)" suffix). Any non-quote blocks
  // that PRECEDE the first quote (a leading source/reference paragraph) ride with the first
  // quote's card; trailing non-quote blocks ride with the last. A card with 0 or 1 quotes is
  // returned unchanged as a single card. Operates after quotify so promoted prose quotes split
  // too. Returns an array of { title, blocks }.
  function splitQuoteCards(title, blocks) {
    if (!Array.isArray(blocks)) return [{ title, blocks }];
    const quoteCount = blocks.filter((b) => b && b.type === "quote").length;
    if (quoteCount < 2) return [{ title, blocks }];
    const cards = [];
    let lead = []; // non-quote blocks seen before the first quote of the current card
    let started = false;
    for (const b of blocks) {
      if (b && b.type === "quote") {
        cards.push({ title, blocks: [...lead, b] });
        lead = [];
        started = true;
      } else if (!started) {
        lead.push(b); // leading source/reference paragraph → first card
      } else {
        cards[cards.length - 1].blocks.push(b); // trailing block → last card
      }
    }
    // Defensive: a card that somehow ended with only lead blocks keeps them.
    if (lead.length && cards.length) cards[cards.length - 1].blocks.push(...lead);
    return cards;
  }

  // ADR-0022 CAROUSEL. Build one sub-slide object from a title + its raw blocks. Each sub-slide
  // runs through the SAME layout pipeline as a top-level slide (inferLayout over its own blocks,
  // then mapBlocksToLayout) so it renders FULL-BLEED via the normal renderers — NOT card-chrome.
  // The returned object is shaped for renderSlideContent in 07-assembly (title/kicker/layout/blocks
  // + the title attrs it reads). `kicker` is the parent slide's shared context (section eyebrow).
  function buildCarouselSubSlide(title, rawSubBlocks, kicker) {
    const probe = { attrs: {}, lines: [], cards: [] };
    // inferLayout reads s.lines (it re-lexes) and s.cards — give it pre-lexed blocks via a shim:
    // we lex once here and let inferLayout see the same blocks by stashing them on `lines` is not
    // possible, so instead derive the layout from the blocks directly using the same rules.
    const subLayout = inferLayoutFromBlocks(rawSubBlocks);
    const mapped = mapBlocksToLayout(subLayout, rawSubBlocks);
    return {
      title: title || "",
      kicker: kicker || "",
      layout: subLayout,
      blocks: mapped,
      // A sub-slide draws its own visible title by default (full slide behaviour). Quote/statement
      // layouts keep their own title defaults via renderSlideContent (quote = nav-only).
      titleMode: "",
      noTitle: false,
      colsCount: "",
      split: "",
      titleTop: false,
      timelineHorizontal: false,
      titleStyle: "",
      notes: ""
    };
  }

  // Layout inference over an already-lexed block list (the carousel sub-slide path). Mirrors the
  // media/text branch of inferLayout WITHOUT the trigger-attr shortcuts (a sub-slide has no heading
  // attrs of its own) and without the cards branch (no nested carousels).
  function inferLayoutFromBlocks(blocks) {
    const hasMedia = blocks.some((b) => ["image", "embed", "video"].includes(b.type));
    const hasList = blocks.some((b) => b.type === "list" || b.type === "feature-list");
    const hasParagraph = blocks.some((b) => b.type === "paragraph");
    const hasQuote = blocks.some((b) => b.type === "quote");
    const hasText = hasList || hasParagraph || hasQuote;
    const codeBlock = blocks.find((b) => b.type === "code");
    if (codeBlock && !hasMedia) return codeBlock.lang === "trace" ? "trace" : "code";
    if (blocks.some((b) => b.type === "timeline")) {
      const hasComment = (hasParagraph || hasQuote) && !hasMedia && !hasList;
      return hasComment ? "timeline-visual" : "timeline";
    }
    if (hasMedia && hasList && !hasParagraph && !hasQuote) return "list-visual";
    if (hasMedia && (hasText || blocks.some((b) => b.type === "table"))) return "copy-visual";
    if (hasMedia) return "media";
    if (hasQuote && !hasList && !hasParagraph
        && !blocks.some((b) => ["timeline", "table", "code"].includes(b.type))) {
      return "quote";
    }
    const hasStructural = blocks.some((b) => ["list", "feature-list", "timeline", "table", "quote"].includes(b.type));
    if (hasParagraph && !hasStructural) return "statement";
    return "list";
  }

  // ADR-0022 {carousel}: split a slide's TOP-LEVEL blocks into one sub-slide per block (each
  // top-level image/paragraph/quote/list/embed/video becomes its own full-bleed sub-slide). Nested
  // bullets stay as children of their list block (no sub-sub-slides). A leading prose paragraph
  // that precedes a media block rides WITH that media block's sub-slide (spoken context arrives
  // with the figure), mirroring the old media-gallery grouping. Returns sub-slide objects.
  function carouselSubSlidesFromBlocks(rawBlocks, kicker) {
    const subs = [];
    let pending = [];
    const MEDIA = new Set(["image", "embed", "video"]);
    for (const b of rawBlocks) {
      if (MEDIA.has(b.type)) {
        subs.push(buildCarouselSubSlide("", featurizeCardBlocks([...pending, b]), kicker));
        pending = [];
      } else {
        // Flush any pending non-media block as its own sub-slide, then start collecting again.
        // We only buffer a SINGLE leading text block ahead of a media block; standalone text
        // blocks each become their own sub-slide.
        if (pending.length) {
          for (const p of pending) subs.push(buildCarouselSubSlide("", featurizeCardBlocks([p]), kicker));
          pending = [];
        }
        pending.push(b);
      }
    }
    for (const p of pending) subs.push(buildCarouselSubSlide("", featurizeCardBlocks([p]), kicker));
    return subs;
  }

  function flushSlide() {
    if (!slide) return;
    const titleOnlySection = slide.isSection
      && !slide.lines.some((line) => String(line).trim())
      && slide.cards.length === 0;
    let layout = titleOnlySection ? "section-title" : inferLayout(slide);
    const rawBlocks = lexMarkdownBlocks(slide.lines);
    // Wire timeline presentation attr from the slide heading onto every timeline block:
    //   {timeline=rail|columns|compact|horizontal|spine|pills}  → presentation mode (else auto)
    for (const b of rawBlocks) {
      if (b && b.type === "timeline") {
        if (slide.attrs.timeline) b.mode = slide.attrs.timeline;
      }
    }
    let blocks = mapBlocksToLayout(layout, rawBlocks);
    let iconlistVariant = "";
    let statementVariant = "";
    let backgroundTint = "";

    // Round B value vocabularies. Bare {iconlist}/{statement} remain their unchanged defaults;
    // explicit unknown values warn and deliberately fall back to those defaults.
    if (slide.attrs.iconlist != null) {
      const variant = slide.attrs.iconlist === true ? "boxes" : String(slide.attrs.iconlist).trim().toLowerCase();
      if (variant === "list") iconlistVariant = "list";
      else if (variant !== "boxes") warnings.push(`iconlist-unknown:${variant}`);
      // The value form is still an icon list even though it bypasses the bare-word dictionary.
      slide.attrs.liststyle = "icons";
    }
    if (slide.attrs.statement != null) {
      const variant = slide.attrs.statement === true ? "default" : String(slide.attrs.statement).trim().toLowerCase();
      if (variant === "tint" || variant === "poster") statementVariant = variant;
      else if (variant !== "default") warnings.push(`statement-unknown:${variant}`);
    }
    if (slide.attrs.bg != null && slide.attrs.bg !== true) {
      const name = String(slide.attrs.bg).trim().toLowerCase();
      const tint = backgroundTintForName(name);
      if (tint) backgroundTint = tint;
      else warnings.push(`bg-unknown:${name}`);
    }
    // mapBlocksToLayout may REBUILD the timeline block from a nested list — re-apply the
    // authored presentation mode so {timeline=dynamic|…} survives the mapping.
    if (slide.attrs.timeline) {
      for (const b of blocks) {
        if (b && b.type === "timeline") b.mode = slide.attrs.timeline;
      }
    }
    // Wire the flow diagram direction from the slide heading onto every flow block:
    //   {flow=horizontal|vertical|loop|branch}  (default horizontal). An unknown value falls
    //   back to horizontal at render time.
    if (slide.attrs.flow) {
      for (const b of blocks) {
        if (b && b.type === "flow") b.direction = slide.attrs.flow;
      }
    }
    // Layout batch 2 (2026-06-12). Chart shape: {chart=bar|pie|line} (or the {barchart} etc.
    // bare words) rides onto every chart block; default bar at render time.
    if (slide.attrs.chart != null && slide.attrs.chart !== true) {
      for (const b of blocks) {
        if (b && b.type === "chart") b.shape = slide.attrs.chart;
      }
    }
    if (layout === "equation") {
      const shape = String(slide.attrs.equation || "pills").toLowerCase();
      for (const b of blocks) {
        if (b && b.type === "equation") b.shape = shape;
      }
    }
    // Contrast variant vocabulary locked in the 2026-07-13 design round. Only these authored
    // values ride onto the block; an unknown value warns and deliberately falls back to the
    // default device. {contrast=cards} remains retired and silent.
    // {contrast=cards} retired 2026-07-11 (legacy broken design) — falls back to the ledger.
    if (slide.attrs.contrast === "cards") delete slide.attrs.contrast;
    if (slide.attrs.contrast != null && slide.attrs.contrast !== true) {
      const variant = String(slide.attrs.contrast);
      if (new Set(["ledger", "rows", "tint", "flip"]).has(variant)) {
        for (const b of blocks) {
          if (b && b.type === "contrast") b.variant = variant;
        }
      } else {
        warnings.push(`contrast-variant-unknown:${variant}`);
      }
    }
    // {blocks:RxC} — an explicit rows×cols grid the author set on a grid/tiles heading. Attach the
    // parsed dims to every tiles block so the render uses the authored column count (otherwise the
    // tiles auto-balance via chooseBalancedColumns). Invalid values are ignored (warn).
    if (slide.attrs.blocks != null && slide.attrs.blocks !== true) {
      const dims = parseGridDims(slide.attrs.blocks);
      if (dims) {
        for (const b of blocks) {
          // image-grid honours the same explicit RxC pin as tiles (column count only).
          if (b && (b.type === "tiles" || b.type === "image-grid")) b.dims = dims;
        }
      } else {
        warnings.push(`blocks-unparsed:${slide.attrs.blocks}`);
      }
    }
    // Fix 4: a system-map centre label can be authored via {centre=…} (alias {center=…}) on
    // the slide heading. Default stays "result" (applied at render time when centre is unset).
    const centreLabel = slide.attrs.centre ?? slide.attrs.center;
    if (centreLabel != null && centreLabel !== true) {
      for (const b of blocks) {
        if (b && b.type === "system-map") b.centre = centreLabel;
      }
    }
    // Deck-level palette: a {palette=green} on any heading sets the deck cycle (first seen wins,
    // unless frontmatter already set it). Not a per-slide attr — it tints the whole deck.
    if (!deckPalette && slide.attrs.palette != null && slide.attrs.palette !== true) {
      deckPalette = String(slide.attrs.palette).trim().toLowerCase();
    }
    // Design-fixes batch: {multicolour} colours the system-map satellites from a varied palette
    // (default stays the single accent). The flag rides on the slide attrs; mark the block so
    // renderBlock emits the multicolour class.
    if (slide.attrs.multicolour) {
      for (const b of blocks) {
        if (b && b.type === "system-map") b.multicolour = true;
      }
    }
    // Concept map: surface any relation line that did not match `A -label- B` (never a silent drop).
    for (const b of blocks) {
      if (b && b.type === "conceptmap") {
        for (const line of b.unparsed || []) warnings.push(`conceptmap-unparsed:${line}`);
      }
      // Chart (layout batch 2): surface items with no parseable number the same way.
      if (b && b.type === "chart") {
        for (const line of b.unparsed || []) warnings.push(`chart-unparsed:${line}`);
      }
      // image-grid (ADR-0021): bullets that couldn't be paired to an image are not silently
      // dropped into a stray list — warn so the author pins them as labels or uses #### cards.
      if (b && b.type === "image-grid" && b.strayLabels) {
        warnings.push(`image-grid-stray-labels:${slide.title || ""}:${b.strayLabels}`);
      }
    }
    // OPT-IN list styling. `{numbered}` / `{iconlist}` / `{logolist}` / `{plainlist}` resolve via
    // the Trigger Dictionary to {liststyle=numbers|icons|logos|plain}; stamp that onto every
    // feature-list block on the slide so decideFeatureListStyle applies it (icons are otherwise
    // OFF — see decideFeatureListStyle). An unrecognised value is dropped + warned.
    // {annotated}: children render as a right-hand annotation column inside each card.
    if (slide.attrs.sublist === "aside") {
      for (const b of blocks) {
        if (b && b.type === "feature-list") b.sublist = "aside";
      }
    }
    const LIST_STYLES = new Set(["numbers", "icons", "logos", "plain"]);
    if (slide.attrs.liststyle != null && slide.attrs.liststyle !== true) {
      if (LIST_STYLES.has(slide.attrs.liststyle)) {
        for (const b of blocks) {
          if (b && b.type === "feature-list") b.liststyle = slide.attrs.liststyle;
          if (b && b.type === "feature-list" && iconlistVariant) b.iconlistVariant = iconlistVariant;
        }
      } else {
        warnings.push(`unknown-liststyle:${slide.attrs.liststyle}`);
      }
    }
    // {group} (2026-06-13): mark the slide's feature-list(s) so the whole list reveals as one
    // beat (data-reveal-group in the render; MODE_SELECTOR treats it as a single unit).
    if (slide.attrs.revealgroup === true) {
      for (const b of blocks) {
        if (b && b.type === "feature-list") b.revealGroup = true;
      }
    }
    const fromHashCards = slide.cards.length > 0;
    // ADR-0022 CAROUSEL. `#### ` cards (each #### = one sub-slide) and the `{carousel}` trigger
    // (each top-level block = one sub-slide) produce a CAROUSEL of FULL-BLEED sub-slides, reusing
    // the existing data-exclusive stepping. STATIC #### exceptions keep their ADR-0021 treatment:
    //   • {image-grid} + #### → static image-grid cells (all visible),
    //   • {contrast} + 2-3 #### groups → static side-by-side comparison,
    //   • {cards=grid} → the static cards grid.
    // The auto stepped MEDIA gallery is removed (ADR-0022): 2+ images with no ####/{carousel} now
    // fall through to the normal media/copy-visual layout (a grid on one slide + the lightbox).
    const wantCarouselTrigger = slide.attrs.carousel === true;
    // {compare} (ADR-0005 "50/50 comparison"): the slide's first two #### groups become two
    // halves side by side — half A on the section tint, half B on paper. Needs exactly two
    // groups; a compare slide with <2 groups warns and renders nothing meaningful.
    const isCompare = layout === "compare" && fromHashCards && slide.cards.length >= 2;
    const isImageGridHash = fromHashCards && layout === "image-grid";
    const isStaticCompare = fromHashCards && layout === "contrast"
      && slide.cards.length >= 2 && slide.cards.length <= 3;
    const isCardsGridForced = slide.attrs.cards === "grid" || slide.attrs.cards === "rows";
    const isCardsRows = slide.attrs.cards === "rows";
    // A #### carousel only when the slide's layout is the cards DEFAULT (bare #### or {cards}). An
    // explicit non-cards layout ({columns}, {smartart}, …) uses #### for ITS OWN structure, not a
    // carousel. ({image-grid}/{contrast} are the named static #### exceptions above.)
    const hashCarousel = fromHashCards && layout === "cards" && !isCardsGridForced;
    // {cards=stepped} over a FLAT list is the legacy "step these cards" intent → a carousel too.
    const flatStepped = !fromHashCards && layout === "cards" && slide.attrs.cards === "stepped";
    // STATIC cards GRID (ADR-0021, unchanged): an adaptive flat-list {cards} (no ####, not stepped)
    // OR {cards=grid} on #### cards → all cards visible at once. NOT a carousel.
    const flatStaticCards = !fromHashCards && layout === "cards" && slide.attrs.cards !== "stepped";
    const hashStaticCards = fromHashCards && isCardsGridForced;

    if (isCompare) {
      // {compare} (ADR-0005): the first two #### groups become the two halves. Each half's
      // heading is its small-caps mono label; its lines become the half's content (statements
      // or lists). The slide's own title is nav-only (assembly hides it, like {quote}); half B
      // reveals as one beat (MODE_SELECTOR carries `.layout-compare .compare-half.half-b`).
      const halves = slide.cards.slice(0, 2).map((c) => ({
        label: c.title || "",
        blocks: featurizeCardBlocks(quotifyCardBlocks(lexMarkdownBlocks(c.lines))),
      }));
      layout = "compare";
      blocks = [{ type: "compare", halves }];
    } else if (isImageGridHash) {
      // {image-grid} + #### cards: the cards become the GRID CELLS (image on top, the card's
      // title + text as the note beneath) — a static all-visible grid, NOT a carousel.
      const galleryCards = slide.cards.flatMap((c) => splitQuoteCards(c.title, featurizeCardBlocks(quotifyCardBlocks(lexMarkdownBlocks(c.lines)))));
      blocks = [...blocks.filter((b) => !(b && b.type === "image-grid")), { type: "image-grid", cells: galleryCards }];
      const igDims = slide.attrs.blocks != null && slide.attrs.blocks !== true ? parseGridDims(slide.attrs.blocks) : null;
      if (igDims) blocks[blocks.length - 1].dims = igDims;
    } else if (isStaticCompare) {
      // {contrast} + 2-3 #### groups = a STATIC side-by-side comparison (both columns visible).
      const galleryCards = slide.cards.flatMap((c) => splitQuoteCards(c.title, featurizeCardBlocks(quotifyCardBlocks(lexMarkdownBlocks(c.lines)))));
      layout = "contrast";
      blocks = [{ type: "cards", title: slide.title, kicker: autoKicker(slide), cards: galleryCards, stepped: false, staticCompare: true }];
    } else if (hashCarousel || wantCarouselTrigger || flatStepped) {
      // CAROUSEL. Build one full-bleed sub-slide per #### card (each card's content run through the
      // sub-slide layout pipeline), or — for {carousel}/{cards=stepped} with no #### — one sub-slide
      // per top-level block. Stash on the record as `carousel`; renderSlideContent wraps each in the
      // existing data-exclusive stepping container as a full-bleed `.card.carousel-subslide`.
      layout = "carousel";
      // The parent carousel head owns the shared context (section eyebrow · parent title), so a
      // sub-slide draws ITS OWN title only — no repeated section kicker (ADR-0022).
      const subKicker = "";
      if (fromHashCards) {
        // Leading top-level blocks BEFORE the first #### are shared context for the carousel. Split
        // them: a leading MEDIA block (image/embed/video) becomes a leading FULL-BLEED sub-slide
        // (the shared figure gets its own frame); a leading PROSE paragraph (a citation/source) is
        // kept as the slide body so the assembly re-emits it as a quiet .slide-source line below the
        // frames — never dropped (the old gallery behaviour, preserved for carousels).
        const MEDIA = new Set(["image", "embed", "video"]);
        const leadMedia = rawBlocks.filter((b) => MEDIA.has(b.type));
        const leadProse = rawBlocks.filter((b) => !MEDIA.has(b.type));
        const leadSubs = leadMedia.map((b) => buildCarouselSubSlide("", featurizeCardBlocks([b]), subKicker));
        // Each #### card → one sub-slide. (Quote-splitting is a card-chrome nicety; a sub-slide is a
        // full slide, so a card with multiple quotes simply renders both — no per-quote split.)
        const cardSubs = slide.cards.map((c) => {
          const subBlocks = featurizeCardBlocks(quotifyCardBlocks(lexMarkdownBlocks(c.lines)));
          return buildCarouselSubSlide(c.title, subBlocks, subKicker);
        });
        slide.carousel = [...leadSubs, ...cardSubs];
        blocks = mapBlocksToLayout("cards", leadProse);
      } else {
        // {carousel}/{cards=stepped}: every top-level block becomes a sub-slide — nothing is left
        // over for a shared body.
        slide.carousel = carouselSubSlidesFromBlocks(rawBlocks, subKicker);
        blocks = [];
      }
    } else if (hashStaticCards || flatStaticCards) {
      // STATIC cards GRID — all cards visible at once (ADR-0021), NOT a carousel. #### cards forced
      // static via {cards=grid}, or an adaptive flat-list {cards}. Source-paragraph extraction
      // happens in the assembly (cards layout).
      const galleryCards = fromHashCards
        ? slide.cards.flatMap((c) => splitQuoteCards(c.title, featurizeCardBlocks(quotifyCardBlocks(lexMarkdownBlocks(c.lines)))))
        : cardsFromList(rawBlocks);
      if (galleryCards) {
        layout = "cards";
        blocks = fromHashCards ? blocks : [];
        blocks = [...blocks, {
          type: "cards",
          title: slide.title,
          kicker: autoKicker(slide),
          cards: galleryCards,
          stepped: false
        }];
      }
    }
    // Opening heuristic: the first non-section-title slide becomes the opening UNLESS an
    // explicit {role=…} is set. E7 records whether this opening came from the heuristic (vs
    // an explicit attr) so the auto title-slide pass can demote it — the auto deck-title
    // slide takes the opening role and the first authored slide becomes plain content.
    const derivedSectionRole = slide.isSection
      ? (slide.nodeLevel <= 2 ? "section-title" : "subsection-title")
      : "";
    const parsedRole = slide.attrs.role === "section-title" || slide.attrs.role === "subsection-title"
      ? ""
      : slide.attrs.role;
    const heuristicOpening = !parsedRole && !slide.isSection
      && slides.filter((s) => s.role !== "section-title" && s.role !== "subsection-title").length === 0;
    const role = normalizeRole(derivedSectionRole || parsedRole || (heuristicOpening ? "opening" : "content"), warnings, slide.id);
    const baseId = slide.attrs.id || slide.id;

    // Push one slide record, de-duplicating its id against slides already emitted.
    const emit = (record) => {
      let finalId = record.id;
      let suffix = 2;
      while (slides.some((s) => s.id === finalId)) {
        warnings.push(`duplicate-slide-id:${finalId}`);
        finalId = `${record.id}-${suffix}`;
        suffix += 1;
      }
      slides.push({ ...record, id: finalId });
    };

    const timelineHorizontal = slide.attrs.timeline === "horizontal"
      || slide.attrs.timeline === "spine"
      || slide.attrs.timeline === "pills"
      || slide.attrs.timeline === "dynamic"
      || blocks.some((b) => b && b.type === "timeline" && ["horizontal", "spine", "pills", "dynamic"].includes(b.mode));

    const record = {
      id: baseId,
      section: slide.section,
      sectionAccent: slide.sectionAccent || "",
      subsection: slide.subsection || "",
      nodeLevel: slide.nodeLevel,
      isSection: slide.isSection,
      role,
      layout,
      // Whether the layout was set by an EXPLICIT trigger (e.g. {statement}) vs inferred from
      // content. An explicit layout renders DETERMINISTICALLY — the adaptive "sparse" title-density
      // enlargement (which collapses a left rail to a stacked big-title) is suppressed, so e.g.
      // {statement} is always side-by-side regardless of how short the content is. Inferred layouts
      // still adapt (a near-empty untriggered slide is "basically a title" and may enlarge).
      explicitLayout: slide.attrs.layout != null || slide.attrs.statement != null,
      iconlistVariant,
      statementVariant,
      backgroundTint,
      sourceLine: slide.sourceLine, // 1-based line of this slide's heading (cursor↔strip sync)
      sourceMarkdown: Array.isArray(slide.sourceLines) ? slide.sourceLines.join("\n").trimEnd() : "",
      kicker: titleOnlySection && slide.nodeLevel > 2 ? slide.sectionTitle : autoKicker(slide),
      navTitle: slide.title,
      title: slide.title,
      // Authored stepping mode: {mode=reveal|focus} activates that mode on arrival. The legacy
      // {reveal=steps} attr is kept as an alias for {mode=reveal} (documented; migrate lazily).
      mode: resolveAuthoredMode(slide.attrs),
      titleMode: slide.attrs.title === "show" || slide.attrs.title === "compact" ? slide.attrs.title : "",
      // {notitle}: drop the on-slide heading (nav-only sr-only h1 stays). Title-less statement etc.
      noTitle: slide.attrs.notitle === true,
      // {columns} column count: explicit {cols=N} (also set by {2col}/{3col}); empty = auto.
      colsCount: slide.attrs.cols != null && slide.attrs.cols !== true ? String(slide.attrs.cols) : "",
      // Title placement (2026-06-09 title spec). {titletop} forces top; {split=35|50|30} tunes the
      // left rail (and implies it). Horizontal timeline → top (the track needs full width).
      titleTop: slide.attrs.titletop === true,
      // {nostep}: this slide never steps — shown all at once even under a sticky presenter mode.
      noStep: slide.attrs.nostep === true,
      // {novalues}: chart value labels hidden (shape-only comparison).
      noValues: slide.attrs.novalues === true,
      // {font-body=xs|s|m|l|xl} / {font-title=…}: per-slide type-ramp override (m = ramp default).
      fontBody: ["xs","s","m","l","xl"].includes(String(slide.attrs["font-body"] ?? "")) ? slide.attrs["font-body"] : "",
      fontTitle: ["xs","s","m","l","xl"].includes(String(slide.attrs["font-title"] ?? "")) ? slide.attrs["font-title"] : "",
      // Container-mode section (ADR-0007, Task 6): the mode + ORDERED direct-child ids, stamped
      // onto the section <section> (07-assembly) so the runtime can paint the Card Table / rail /
      // strip. The beat stream is the runtime's preferred source, but grid-linear emits no
      // grid-returns — this build-time list is its authoritative fallback. Continuation
      // (spine-split) children are kept: they emit real beats.
      ...(() => {
        const a = slide.attrs;
        const mode = a["grid-linear"] === true ? "grid-linear"
          : a["grid-zoom"] === true ? "grid-zoom"
            : (a.contents === true || a.contents === "strip") ? "contents" : "";
        if (!mode) return {};
        const childIds = slide.treeNode && Array.isArray(slide.treeNode.children)
          ? slide.treeNode.children.filter((c) => c && c.id).map((c) => c.id)
          : [];
        return {
          containerMode: mode,
          containerVariant: a.contents === "strip" ? "strip" : "",
          containerChildIds: childIds
        };
      })(),
      // Countdown ELEMENT (layout batch 2): {countdown=30s} (+ optional countdown-style=bar) or
      // the {countdown-digits-30s} sugar. Parsed to whole seconds here so the markup never
      // carries an unvalidated duration; unparseable → warning + element dropped (never silent).
      // Chrome, not content: ignored by stepping and projections.
      // Section timer rides on every slide of the section (runtime re-arms on section change).
      ...(slide.sectionTimerSeconds ? { sectionTimerSeconds: slide.sectionTimerSeconds, sectionTimerShow: slide.sectionTimerShow } : {}),
      // Presenter reminder (2026-06-12): {remind="text"} + {remind-at=hh:mm} (wall clock) or
      // {remind-in=45min} (from presentation start). Presenter window only; flashes until
      // dismissed. Validated here so the markup never carries an unparseable time.
      ...(() => {
        const text = slide.attrs.remind;
        if (text == null || text === true || !String(text).trim()) return {};
        const at = slide.attrs["remind-at"];
        const after = slide.attrs["remind-in"];
        if (at != null && at !== true) {
          const m = String(at).trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
          if (m) return { remindText: String(text), remindAtMinutes: Number(m[1]) * 60 + Number(m[2]) };
          warnings.push(`remind-unparsed:${at}`);
          return {};
        }
        if (after != null && after !== true) {
          const seconds = parseCountdownDuration(after);
          if (seconds && seconds > 0) return { remindText: String(text), remindInSeconds: seconds };
          warnings.push(`remind-unparsed:${after}`);
          return {};
        }
        warnings.push(`remind-missing-time:${String(text).slice(0, 40)}`);
        return {};
      })(),
      ...(() => {
        const raw = slide.attrs.countdown;
        if (raw == null || raw === true) return {};
        const seconds = parseCountdownDuration(raw);
        if (seconds == null || seconds <= 0) {
          warnings.push(`countdown-unparsed:${raw}`);
          return {};
        }
        const style = slide.attrs["countdown-style"] === "bar" ? "bar" : "digits";
        return { countdownSeconds: seconds, countdownStyle: style };
      })(),
      // {sidebar}: the left title rail renders as a solid dark panel (PPT "Sidebar title" look).
      titleStyle: slide.attrs.titlestyle === "sidebar" ? "sidebar" : "",
      split: slide.attrs.split != null && slide.attrs.split !== true ? String(slide.attrs.split).trim() : "",
      // Wide timelines (horizontal track + the spine) take the full slide width → top-title.
      timelineHorizontal,
      blocks: (slide.attrs.cards === "rows"
        ? blocks.map((b) => (b && b.type === "cards" ? { ...b, rows: true } : b))
        : blocks),
      // ADR-0022: carousel sub-slides (when this slide is a carousel). renderSlideContent steps
      // these as full-bleed frames in the existing data-exclusive container.
      ...(Array.isArray(slide.carousel) && slide.carousel.length ? { carousel: slide.carousel } : {}),
      reuse: defaultReuseForRole(role),
      openingFromHeuristic: heuristicOpening,
      notes: slide.notes.length ? { html: markdownLinesToHtml(slide.notes) } : "",
      // Wave 1, task 2: resolved frame descriptor — title rail, image, icons, align, section label.
      frame: frameFor(slide),
      // SD-14: whether image= was explicitly authored (vs the builtin default "left"); the split
      // layout only activates when image was explicitly set so existing mixed slides are unchanged.
      frameImageExplicit: frameImageExplicitFor(slide),
      // 2026-07-08: whether title=/sidebar was explicitly authored (vs the builtin "top").
      // An explicit {title=top} must SHOW the title on layouts that hide it by default
      // (quote, statement); without this flag the resolved frame always reads "top".
      frameTitleExplicit: frameTitleExplicitFor(slide)
    };

    // OVERFLOW = AUTO-SPLIT (the chosen default for spine/pills timelines). A spine or pills
    // timeline with more than SPINE_STOPS_PER_SLIDE date stops becomes several continuation
    // slides — each a proper, generously-spaced spine of ≤cap stops, same title plus a "(n/N)"
    // marker, distinct ids. One timeline block thus emits N slides; nav/overview/projections all
    // derive from the `slides` array, so they count the continuations correctly. Only applies
    // when the spine/pills timeline is the slide's single block (a mixed slide is left intact and
    // simply renders its stops — the cap is a legibility default, not a hard constraint).
    const spineBlock = blocks.length === 1 && blocks[0] && blocks[0].type === "timeline"
      && (blocks[0].mode === "spine" || blocks[0].mode === "pills") ? blocks[0] : null;
    const spineGroups = spineBlock && Array.isArray(spineBlock.groups) ? spineBlock.groups : null;
    if (spineGroups && spineGroups.length > SPINE_STOPS_PER_SLIDE) {
      const chunks = [];
      for (let i = 0; i < spineGroups.length; i += SPINE_STOPS_PER_SLIDE) {
        chunks.push(spineGroups.slice(i, i + SPINE_STOPS_PER_SLIDE));
      }
      const continuationIds = Array.isArray(slide.spineContinuationIds) ? slide.spineContinuationIds : [];
      chunks.forEach((chunk, idx) => {
        const marker = `(${idx + 1}/${chunks.length})`;
        emit({
          ...record,
          id: idx === 0 ? baseId : (continuationIds[idx - 1] || `${baseId}-${idx + 1}`),
          // Each continuation is a full spine over its slice of stops; preserve all other block fields.
          blocks: [{ ...spineBlock, groups: chunk }],
          title: record.title ? `${record.title} ${marker}` : marker,
          navTitle: record.navTitle ? `${record.navTitle} ${marker}` : marker,
          // Only the first continuation inherits the opening-heuristic flag (others are content).
          role: idx === 0 ? record.role : normalizeRole("content", warnings, baseId),
          openingFromHeuristic: idx === 0 ? record.openingFromHeuristic : false
        });
      });
      return;
    }

    emit(record);
  }

  function visitNodes(nodes, visitor) {
    for (const node of nodes || []) {
      visitor(node);
      visitNodes(node.children || [], visitor);
    }
  }

  let needsLegacyWarning = false;
  const outlineVersion = Number(meta.outline_version ?? meta["outline-version"]);
  if (Number.isFinite(outlineVersion) && outlineVersion < 2) needsLegacyWarning = true;
  visitNodes(root.children, (node) => {
    if (node.attrs?.sub) needsLegacyWarning = true;
  });
  if (needsLegacyWarning && !warnings.includes("legacy-outline")) warnings.push("legacy-outline");

  function allTreeNodes() {
    const out = [];
    visitNodes(root.children, (node) => out.push(node));
    return out.sort((a, b) => (a.sourceLine || 0) - (b.sourceLine || 0));
  }

  const nodeSourceEndLines = new Map();
  {
    const nodesByLine = allTreeNodes();
    for (let i = 0; i < nodesByLine.length; i += 1) {
      const node = nodesByLine[i];
      const next = nodesByLine[i + 1];
      nodeSourceEndLines.set(node, next?.sourceLine ? next.sourceLine - 1 : rawSourceLines.length);
    }
  }

  function contentLinesAndAttrs(node, attrs, { emitWarnings = true } = {}) {
    const linesOut = [];
    let inFence = false;
    let fenceMark = "";
    for (const line of node.contentLines || []) {
      const t = String(line).trim();
      if (inFence) {
        linesOut.push(line);
        const close = t.match(/^(`{3,})\s*$/);
        if (close && close[1].length >= fenceMark.length) { inFence = false; fenceMark = ""; }
        continue;
      }
      const open = t.match(/^(`{3,})/);
      if (open) {
        linesOut.push(line);
        inFence = true;
        fenceMark = open[1];
        continue;
      }
      const stray = parseTriggerLine(line);
      if (stray) {
        if (emitWarnings) {
          for (const w of stray.warnings || []) warnings.push(w);
        }
        Object.assign(attrs, stray.attrs);
      } else {
        linesOut.push(line);
      }
    }
    return linesOut;
  }

  function spineSplitCountForNode(node) {
    if (!node || node._sequenceOnly) return 1;
    const attrs = { ...deckTriggerDefaults, ...(node.attrs || {}) };
    const lines = contentLinesAndAttrs(node, attrs, { emitWarnings: false });
    const titleOnlySection = (node.children || []).length > 0
      && !lines.some((line) => String(line).trim());
    const probe = { attrs, lines, cards: [], isSection: (node.children || []).length > 0 };
    const layout = titleOnlySection ? "section-title" : inferLayout(probe);
    const rawBlocks = lexMarkdownBlocks(lines);
    for (const b of rawBlocks) {
      if (b && b.type === "timeline" && attrs.timeline) b.mode = attrs.timeline;
    }
    const blocks = mapBlocksToLayout(layout, rawBlocks);
    const spineBlock = blocks.length === 1 && blocks[0] && blocks[0].type === "timeline"
      && (blocks[0].mode === "spine" || blocks[0].mode === "pills") ? blocks[0] : null;
    const spineGroups = spineBlock && Array.isArray(spineBlock.groups) ? spineBlock.groups : null;
    return spineGroups && spineGroups.length > SPINE_STOPS_PER_SLIDE
      ? Math.ceil(spineGroups.length / SPINE_STOPS_PER_SLIDE)
      : 1;
  }

  function dedupeTreeIdsAndInsertSequenceSplits() {
    const seen = new Set();
    let generated = 1;
    const reserve = (base) => {
      let finalId = base;
      let suffix = 2;
      while (seen.has(finalId)) {
        warnings.push(`duplicate-slide-id:${finalId}`);
        finalId = `${base}-${suffix}`;
        suffix += 1;
      }
      seen.add(finalId);
      return finalId;
    };
    const sequenceOnlyNode = (id, nodeTitle, level) => ({
      level,
      title: nodeTitle,
      attrs: { id },
      id,
      contentLines: [],
      notesLines: [],
      children: [],
      sourceLine: null,
      headingLine: "",
      triggerLine: "",
      _sequenceOnly: true
    });
    const rewrite = (nodes) => {
      const nextNodes = [];
      for (const node of nodes || []) {
        const base = (typeof node.id === "string" && node.id.trim())
          || (typeof node.attrs?.id === "string" && node.attrs.id.trim())
          || slugify(node.title)
          || `slide-${generated}`;
        generated += 1;
        const finalId = reserve(base);
        node.id = finalId;
        node.attrs = { ...(node.attrs || {}), id: finalId };
        node.children = rewrite(node.children || []);
        // Folded carousel children do not emit DOM slide records, but they remain real authored
        // sequence nodes. Reserve/dedupe their ids in the same namespace as rendered slides.
        if (Array.isArray(node._sequenceCarouselChildren)) {
          node._sequenceCarouselChildren = rewrite(node._sequenceCarouselChildren);
        }
        const splitCount = spineSplitCountForNode(node);
        if (splitCount > 1) {
          node._sequenceContinuationIds = [];
          for (let idx = 2; idx <= splitCount; idx += 1) {
            const continuationId = reserve(`${finalId}-${idx}`);
            node._sequenceContinuationIds.push(continuationId);
          }
        }
        nextNodes.push(node);
        for (const continuationId of node._sequenceContinuationIds || []) {
          nextNodes.push(sequenceOnlyNode(continuationId, node.title, node.level));
        }
      }
      return nextNodes;
    };
    root.children = rewrite(root.children || []);
  }

  function buildSourceLines(node) {
    if (!node.sourceLine) return [];
    const endLine = nodeSourceEndLines.get(node) || node.sourceLine;
    return rawSourceLines.slice(node.sourceLine - 1, endLine);
  }

  function sectionTimerFrom(nodeAttrs) {
    if (nodeAttrs.timer == null || nodeAttrs.timer === true) return null;
    const timerSeconds = parseCountdownDuration(nodeAttrs.timer);
    if (timerSeconds && timerSeconds > 0) {
      return {
        sectionTimerSeconds: timerSeconds,
        sectionTimerShow: nodeAttrs["timer-show"] === "audience" ? "audience" : "presenter"
      };
    }
    warnings.push(`section-timer-unparsed:${nodeAttrs.timer}`);
    return null;
  }

  function emitNodeSlides(nodes, context = {}) {
    for (const node of nodes || []) {
      if (node._sequenceOnly) continue;
      const isSection = (node.children || []).length > 0;
      const attrs = { ...deckTriggerDefaults, ...(node.attrs || {}) };
      const current = { ...context };

      if (node.level === 2) {
        current.section = { id: node.id, title: node.title };
        const requestedAccent = attrs.accent == null || attrs.accent === true ? "" : String(attrs.accent).trim().toLowerCase();
        if (requestedAccent && !accentForSectionName(requestedAccent, deckPalette)) {
          warnings.push(`accent-unknown:${requestedAccent}`);
          current.sectionAccent = "";
        } else {
          current.sectionAccent = requestedAccent;
        }
        const timer = sectionTimerFrom(attrs);
        current.sectionTimer = timer || null;
        current.subsection = null;
        sections.push(current.section);
      } else if (isSection && node.level > 2 && current.section) {
        current.subsection = { id: node.id, section: current.section.id, title: node.title };
        subsections.push(current.subsection);
      }

      const lines = contentLinesAndAttrs(node, attrs);
      slide = {
        id: node.id,
        title: node.title,
        attrs,
        section: current.section ? current.section.id : "",
        sectionTitle: current.section ? current.section.title : "",
        sectionAccent: current.sectionAccent || "",
        subsection: current.subsection ? current.subsection.id : "",
        sourceLine: node.sourceLine || null,
        lines,
        cards: Array.isArray(node._foldedCards)
          ? node._foldedCards
          : Array.isArray(node._compareHalves) ? node._compareHalves : [],
        notes: Array.isArray(node.notesLines) ? [...node.notesLines] : [],
        sourceLines: buildSourceLines(node),
        nodeLevel: node.level,
        isSection,
        treeNode: node,
        spineContinuationIds: Array.isArray(node._sequenceContinuationIds) ? node._sequenceContinuationIds : [],
        ...(current.sectionTimer || {})
      };
      flushSlide();
      slide = null;

      emitNodeSlides(node.children || [], current);
    }
  }

  // {compare} (ADR-0005 "50/50 comparison"): unlike an ordinary heading-is-slide parent (whose
  // `####` children each become their own slide), a compare heading ABSORBS its first two `####`
  // children as the two halves of ONE slide. Fold them onto the node as `_compareHalves` and empty
  // node.children BEFORE dedupe + sequencing, so the compare node reads as a leaf everywhere: the
  // sequencer emits a single beat and emitNodeSlides emits a single slide (cards = the two halves).
  // Deliberately scans raw contentLines, including trigger-shaped text in code fences: this is the
  // established container-fold contract, distinct from the fence-aware content lexer below.
  const resolvedNodeAttrs = (node) => {
    const attrs = { ...deckTriggerDefaults, ...(node.attrs || {}) };
    for (const line of node.contentLines || []) {
      const stray = parseTriggerLine(line);
      if (stray) Object.assign(attrs, stray.attrs);
    }
    return attrs;
  };
  const nodeResolvesToCompare = (node) => resolvedNodeAttrs(node).layout === "compare";
  // {columns}/{2col}/{3col} likewise ABSORB their `####` children — each child folds back into
  // the parent's content as a subheading + its lines, so the columns layout deals them into
  // side-by-side columns of ONE slide (a column is never a slide of its own; 2026-07-11).
  const nodeResolvesToColumns = (node) => {
    const attrs = resolvedNodeAttrs(node);
    return attrs.layout === "columns" || (attrs.cols != null && attrs.cols !== true);
  };
  const nodeResolvesToCarousel = (node) => resolvedNodeAttrs(node).carousel === true;
  const foldChildrenToCards = (node, children) => {
    node._foldedCards = children.map((child) => {
      const childAttrs = { ...deckTriggerDefaults, ...(child.attrs || {}) };
      const childLines = contentLinesAndAttrs(child, childAttrs, { emitWarnings: false });
      return { title: child.title, lines: childLines };
    });
    node.children = [];
  };
  const foldChildLayoutNodes = (nodes) => {
    for (const node of nodes || []) {
      foldChildLayoutNodes(node.children || []);
      const children = node.children || [];
      if (nodeResolvesToCarousel(node) && children.length) {
        // Preserve the leaf identities for sequencing before folding their content into the
        // parent's single DOM slide. The sequencer attaches carousel index/count context.
        node._sequenceCarouselChildren = children.map((child) => ({
          id: child.id,
          title: child.title,
          attrs: { ...(child.attrs || {}) },
          children: []
        }));
        foldChildrenToCards(node, children);
        continue;
      }
      // ADR-0021 static containers absorb #### groups into one all-visible slide. Carousel stays
      // first so a node carrying both {carousel} and {cards=grid} keeps its established behaviour.
      const attrs = resolvedNodeAttrs(node);
      const staticCards = (attrs.cards === "grid" || attrs.cards === "rows") && children.length >= 1;
      const imageGrid = attrs.layout === "image-grid" && children.length >= 1;
      const contrast = attrs.layout === "contrast";
      if (staticCards || imageGrid || (contrast && children.length >= 2 && children.length <= 3)) {
        foldChildrenToCards(node, children);
        continue;
      }
      // The static compare renderer accepts only 2–3 groups; folding any other non-empty count
      // would consume child slides without a renderable representation.
      if (contrast && children.length && (children.length === 1 || children.length >= 4)) {
        warnings.push(`contrast-groups-count:${node.id}`);
      }
      if (nodeResolvesToColumns(node) && children.length >= 2) {
        for (const child of children) {
          const childAttrs = { ...deckTriggerDefaults, ...(child.attrs || {}) };
          const childLines = contentLinesAndAttrs(child, childAttrs, { emitWarnings: false });
          node.contentLines = [...(node.contentLines || []), "", `#### ${child.title}`, "", ...childLines];
        }
        node.children = [];
        continue;
      }
      if (nodeResolvesToCompare(node) && children.length >= 2) {
        node._compareHalves = children.slice(0, 2).map((child) => {
          const childAttrs = { ...deckTriggerDefaults, ...(child.attrs || {}) };
          const childLines = contentLinesAndAttrs(child, childAttrs, { emitWarnings: false });
          return { title: child.title, lines: childLines };
        });
        if (children.length > 2) warnings.push(`compare-extra-groups:${node.title}`);
        node.children = [];
      }
    }
  };
  foldChildLayoutNodes(root.children);

  dedupeTreeIdsAndInsertSequenceSplits();
  emitNodeSlides(root.children);

  const syntheticNode = (id, nodeTitle, attrs = {}) => ({
    level: 2,
    title: nodeTitle,
    attrs: { id, ...attrs },
    id,
    contentLines: [],
    notesLines: [],
    children: [],
    sourceLine: null,
    headingLine: "",
    triggerLine: ""
  });

  // OPENING-FIRST ORDERING. An authored {role=opening} slide that lives inside a section is
  // preceded in markup by that section's auto section-title slide, so the deck would otherwise
  // OPEN on a section divider with the real opening as slide 2 (the bug KCL surfaced). The
  // opening must come first. Move the divider for the section CONTAINING the opening to AFTER
  // the opening slide; if the opening is that section's ONLY content slide, the divider existed
  // only to hold the opening — drop it entirely. (Auto deck-title bookends are unshifted to the
  // very front below, so they are already first; this pass is for authored in-section openings.)
  let openingBeatPatch = null;
  {
    const openingIdx = slides.findIndex((s) => s.role === "opening" && !s.openingFromHeuristic);
    if (openingIdx >= 0) {
      const opening = slides[openingIdx];
      const sectionId = opening.section;
      if (sectionId) {
        const dividerIdx = slides.findIndex(
          (s) => s.role === "section-title" && s.section === sectionId && s.layout === "section-title"
        );
        // Only act when the divider precedes the opening (the broken order). A divider already
        // after the opening means the deck author placed it deliberately — leave it alone.
        if (dividerIdx >= 0 && dividerIdx < openingIdx) {
          const contentInSection = slides.filter(
            (s) => s.section === sectionId && s.role !== "section-title" && s.role !== "subsection-title"
          );
          const [divider] = slides.splice(dividerIdx, 1);
          // Indices after the splice shifted left by one; recompute the opening's position.
          const newOpeningIdx = slides.findIndex((s) => s === opening);
          if (contentInSection.length > 1) {
            // Section also holds real content beyond the opening: keep the divider, but after it.
            slides.splice(newOpeningIdx + 1, 0, divider);
            openingBeatPatch = { dividerId: divider.id, openingId: opening.id, dropDivider: false };
          } else {
            openingBeatPatch = { dividerId: divider.id, openingId: opening.id, dropDivider: true };
          }
          // else: the opening was the section's only slide — divider dropped (suppressed).
        }
      }
    }
  }

  // E7 — AUTO BOOKENDS. Every deck gets an opening title slide and a closing thanks slide
  // unless the outline already supplies one or frontmatter opts out.
  //
  // Opening: a `deck-title` slide (role opening, layout title) built from frontmatter —
  // deck title + author + event/subtitle. Suppressed when the outline already declares an
  // explicit {role=opening} slide, or frontmatter sets `auto_title_slide: false`. When the
  // auto title slide is added, any opening role that came from the first-content heuristic
  // (not an explicit attr) is demoted to content so the auto slide owns the opening.
  const hasExplicitOpening = slides.some((s) => s.role === "opening" && !s.openingFromHeuristic);
  const wantTitleSlide = meta.auto_title_slide !== false && !hasExplicitOpening;
  if (wantTitleSlide) {
    for (const s of slides) {
      if (s.role === "opening" && s.openingFromHeuristic) {
        s.role = "content";
        s.reuse = defaultReuseForRole("content");
      }
    }
    const eventLine = meta.event || meta.subtitle || "";
    // ADR-0005 title designs (title-variations.html): the auto title slide is a structured
    // POSTER (default) — series/event/date top line, title+subtitle mid, speaker/web bottom.
    // frontmatter `title_style: split|banner` picks the other locked variants.
    const titleVariant = ["poster", "split", "banner"].includes(String(meta.title_style || "").toLowerCase())
      ? String(meta.title_style).toLowerCase() : "poster";
    const titleBlocks = [{
      type: "title-poster",
      variant: titleVariant,
      data: {
        title,
        subtitle: meta.subtitle || "",
        series: meta.series || "",
        event: meta.event || "",
        date: meta.date || "",
        author: meta.author || "",
        affiliation: meta.affiliation || "",
        web: meta.web || ""
      }
    }];
    slides.unshift({
      id: "deck-title", section: "", role: "opening", layout: "title",
      kicker: eventLine, navTitle: title, title,
      titleMode: "show", blocks: titleBlocks,
      reuse: defaultReuseForRole("opening"), notes: "",
      frame: { ...FRAME_BUILTINS }
    });
    root.children.unshift(syntheticNode("deck-title", title, { role: "opening" }));
  }
  // Closing: a `deck-thanks` slide (role ending, layout closing). Suppressed when an
  // authored slide already declares {role=ending} or frontmatter sets
  // `auto_thanks_slide: false`. `thanks` (default "Thank you") is the statement; `cta` (a
  // call-to-action string) renders below in the accent; with no cta we still show the
  // author/event line so the slide is never bare.
  const hasEnding = slides.some((s) => s.role === "ending");
  const wantThanksSlide = meta.auto_thanks_slide !== false && !hasEnding;
  if (wantThanksSlide) {
    const thanks = typeof meta.thanks === "string" && meta.thanks.trim() ? meta.thanks.trim() : "Thank you";
    const cta = typeof meta.cta === "string" ? meta.cta.trim() : "";
    // The closing MIRRORS the title poster (ADR-0005): thanks at display scale, cta in the
    // accent, identity bottom line — one structured block, not loose paragraphs.
    const closingBlocks = [{
      type: "title-poster",
      variant: "closing",
      data: {
        title: thanks,
        subtitle: cta,
        series: meta.series || "",
        event: meta.event || "",
        date: meta.date || "",
        author: meta.author || "",
        affiliation: meta.affiliation || "",
        web: meta.web || ""
      }
    }];
    slides.push({
      id: "deck-thanks", section: "", role: "ending", layout: "closing",
      kicker: "", navTitle: thanks, title: thanks,
      titleMode: "show", blocks: closingBlocks,
      reuse: defaultReuseForRole("ending"), notes: "",
      frame: { ...FRAME_BUILTINS }
    });
    root.children.push(syntheticNode("deck-thanks", thanks, { role: "ending" }));
  }

  // `handout_url:` frontmatter (2026-06-10 handouts): a corner QR + short link to the published
  // handout, stamped on the OPENING and THANK-YOU slides (auto bookends and authored ones alike)
  // so the audience can grab the slides at the start and the end. The publish-handout script
  // writes the URL into the frontmatter once; rebuilds keep it.
  const handoutUrl = typeof meta.handout_url === "string" && meta.handout_url.trim() ? meta.handout_url.trim() : "";
  if (handoutUrl) {
    for (const s of slides) {
      if (s.role === "opening" || s.role === "ending") {
        (s.blocks = s.blocks || []).push({ type: "qr", url: handoutUrl, label: "Handout" });
      }
    }
  }

  // SD-17: collect deck-level links from raw source lines (after all slide-push passes).
  const deckLinks = collectDeckLinks(slides);
  // Auto-append a links slide when frontmatter opts in and no explicit {links} slide exists.
  const hasLinksSlide = slides.some((s) => s.layout === "links");
  const wantLinksIndex = (meta.links_index === true || meta["links-index"] === true) && !hasLinksSlide;
  if (wantLinksIndex && deckLinks.length > 0) {
    slides.push({
      id: "deck-links", section: "", role: "content", layout: "links",
      kicker: "", navTitle: "Links", title: "Links",
      titleMode: "show", blocks: [], reuse: defaultReuseForRole("content"), notes: "",
      frame: { ...FRAME_BUILTINS }
    });
    root.children.push(syntheticNode("deck-links", "Links"));
  }

  // H2 — attach the subsection list to each section record so consumers can group section →
  // subsection without re-scanning slides. (Backward compatible: sections kept their existing
  // shape; `subsections` is an added field.)
  for (const sec of sections) {
    sec.subsections = subsections.filter((sub) => sub.section === sec.id);
  }
  const beatRenderId = (beat) => beat?.context?.container === "carousel"
    ? beat.context.sectionId
    : beat?.slideId;
  const applyOpeningFirstBeatPatch = (rawBeats) => {
    if (!openingBeatPatch) return rawBeats;
    const beatsOut = rawBeats.slice();
    const dividerIdx = beatsOut.findIndex((beat) => beat.slideId === openingBeatPatch.dividerId);
    if (dividerIdx < 0) return beatsOut;
    const [dividerBeat] = beatsOut.splice(dividerIdx, 1);
    if (openingBeatPatch.dropDivider) return beatsOut;
    let openingLastIdx = -1;
    beatsOut.forEach((beat, index) => {
      if (beatRenderId(beat) === openingBeatPatch.openingId) openingLastIdx = index;
    });
    if (openingLastIdx < 0) {
      beatsOut.splice(dividerIdx, 0, dividerBeat);
    } else {
      beatsOut.splice(openingLastIdx + 1, 0, dividerBeat);
    }
    return beatsOut;
  };
  const assertBeatRecordAgreement = (rawBeats) => {
    const slideIds = new Set(slides.map((s) => s.id));
    const represented = new Set();
    for (const beat of rawBeats) {
      const foldedCarouselParent = beat.context?.container === "carousel" ? beat.context.sectionId : "";
      if (slideIds.has(beat.slideId)) represented.add(beat.slideId);
      else if (foldedCarouselParent && slideIds.has(foldedCarouselParent)) represented.add(foldedCarouselParent);
      else warnings.push(`beats-records-mismatch:${beat.slideId}`);
    }
    for (const s of slides) {
      if (!represented.has(s.id)) {
        warnings.push(`beats-records-mismatch:${s.id}`);
      }
    }
    return rawBeats;
  };
  const beats = assertBeatRecordAgreement(
    applyOpeningFirstBeatPatch(sequence(root, { warn: (warning) => warnings.push(warning) }))
  );
  return {
    title, sourceType: "markdown-outline", adapter: "markdown-outline-v2",
    contentSchemaVersion: "markdown-outline-v2", warnings, sections, subsections, slides, beats,
    ...(deckLinks.length ? { deckLinks } : {}),
    ...(durationSeconds ? { durationSeconds } : {}),
    ...(deckFont ? { deckFont } : {}),
    warnAtMinutes, urgentAtMinutes,
    ...(license ? { license } : {}),
    palette: deckPalette === "green" ? "green" : "",
    // LAYER 2 (drop-in): a frontmatter `icons:` block (concept phrase → icon name) becomes the
    // deck-level override map. Built once and threaded into the icon vocabulary.
    icons: (meta && typeof meta.icons === "object" && !Array.isArray(meta.icons)) ? meta.icons : null,
    meta,
    sourceModel: {
      section_count: sections.length,
      subsection_count: subsections.length,
      slide_count: slides.length,
      roles: Object.fromEntries([...slideRoles].map((roleName) => [roleName, slides.filter((s) => s.role === roleName).length])),
      reuse: slides.reduce((summary, s) => {
        const importance = s.reuse?.importance || defaultReuseForRole(s.role).importance;
        summary[importance] = (summary[importance] || 0) + 1;
        return summary;
      }, {})
    }
  };
}

const MIME_TYPES = new Map([
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

const VIDEO_MIME_TYPES = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/x-m4v"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
]);
// Local-video inline budget: a video at or under this size is base64-inlined into the rendered
// HTML, so every single-file export stays genuinely portable. A LARGER video stays a file
// reference — playable in the app bundle and in the full HTML beside dist/assets/ — and the share
// exports swap it for its poster/placeholder. Override: --video-inline-limit <MB>.
// Default 20 MB (2026-06-19, ADR-0028): TalkWeaver's intended use is SHORT clips (a converted GIF,
// a few-second screen capture), which it compiles in-process with no CLI flag, so the default must
// cover them — otherwise a 15 MB clip becomes a broken asset-reference in a self-contained
// present/backup HTML. Bigger clips are out of scope (an optional ffmpeg compression step is the
// future path for them); they still degrade gracefully to a file reference + poster.
const VIDEO_INLINE_LIMIT_BYTES = (() => {
  const i = args.indexOf("--video-inline-limit");
  const mb = i !== -1 ? Number(args[i + 1]) : NaN;
  return (Number.isFinite(mb) && mb >= 0 ? mb : 20) * 1024 * 1024;
})();

// Read intrinsic pixel dimensions from a raster image buffer WITHOUT decoding/re-encoding it
// (no sips/magick — the bytes are never touched; we only parse the header). Returns
// {width,height} or null for SVG / unknown formats. These dimensions let the renderer cap the
// displayed size at 1x so a small screenshot is never upscaled into blur (the perceived
// "recompression"). PNG: IHDR at byte 16. GIF: little-endian at byte 6. JPEG: scan SOF markers.
// WebP: VP8/VP8L/VP8X header variants.
function imageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG: \x89PNG\r\n\x1a\n then IHDR (width/height as big-endian uint32 at offsets 16,20)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: "GIF87a"/"GIF89a" then logical screen width/height (little-endian uint16 at 6,8)
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG: starts FFD8; walk segments to the first SOF marker (C0..CF except C4/C8/CC)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off += 1; continue; }
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
    return null;
  }
  // WebP: "RIFF"...."WEBP" then a VP8 / VP8L / VP8X chunk
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    const fmt = buf.toString("ascii", 12, 16);
    if (fmt === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (fmt === "VP8X") {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h };
    }
  }
  return null;
}

// Data-URI memo: an edit-pause recompile re-read and re-base64-encoded EVERY asset in the deck
// even though none of them changed — for an image-heavy talk that was the bulk of each compile.
// Key by absolute path, validated by mtime+size on every hit (a stat is ~free; readFile + base64
// of a large image is not), so an asset edited on disk is always picked up. LRU-capped by total
// encoded bytes so a long session across many talks can't pin unbounded memory.
const DATA_URI_CACHE_LIMIT_BYTES = 256 * 1024 * 1024;
const dataUriCache = new Map(); // absolute -> { mtimeMs, size, uri, dims }
let dataUriCacheBytes = 0;

async function inlineDataUri(absolute, mime) {
  const info = await stat(absolute);
  const hit = dataUriCache.get(absolute);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
    dataUriCache.delete(absolute); // LRU touch: re-insert as most recent
    dataUriCache.set(absolute, hit);
    return hit;
  }
  const data = await readFile(absolute);
  const entry = {
    mtimeMs: info.mtimeMs,
    size: info.size,
    uri: `data:${mime};base64,${data.toString("base64")}`,
    dims: imageDimensions(data)
  };
  if (hit) dataUriCacheBytes -= hit.uri.length;
  dataUriCache.set(absolute, entry);
  dataUriCacheBytes += entry.uri.length;
  for (const [key, value] of dataUriCache) {
    if (dataUriCacheBytes <= DATA_URI_CACHE_LIMIT_BYTES) break;
    dataUriCache.delete(key);
    dataUriCacheBytes -= value.uri.length;
  }
  return entry;
}

async function inlineAndCollectAssets(model, sourceDir) {
  const collected = []; // { absolute, name }
  if (!sourceDir) return collected;
  // Obsidian (and other editors) write URL-encoded links — `assets/Pasted%20image.png` for a
  // file with real spaces. Resolve the raw form first, then the decoded form (2026-06-10).
  // (Asset bytes themselves are memoized across compiles — see inlineDataUri above.)
  const resolveAsset = async (src) => {
    const raw = resolve(sourceDir, src);
    try { await stat(raw); return raw; } catch { /* try decoded */ }
    try {
      const decoded = resolve(sourceDir, decodeURIComponent(src));
      await stat(decoded);
      return decoded;
    } catch { return null; }
  };
  const used = new Set();
  function uniqueName(src) {
    let name = basename(src);
    let n = 1;
    while (used.has(name)) name = `${basename(src, extname(src))}-${n++}${extname(src)}`;
    used.add(name);
    return name;
  }
  async function visitBlock(block, slideId) {
    if (!block || typeof block !== "object") return block;
    if (block.type === "image" && !/^(data:|https?:)/.test(block.src)) {
      const absolute = (await resolveAsset(block.src)) || resolve(sourceDir, block.src);
      const mime = MIME_TYPES.get(extname(absolute).toLowerCase());
      if (mime) {
        try {
          // The bytes are inlined VERBATIM — base64 of the exact file, never re-encoded. The
          // dimensions are read from the same buffer purely to cap display size at 1x.
          const { uri, dims } = await inlineDataUri(absolute, mime);
          return { ...block, src: uri, ...(dims || {}) };
        } catch {
          model.warnings.push(`missing-image:${slideId}:${block.src}`);
          return block;
        }
      }
      model.warnings.push(`unknown-image-type:${slideId}:${block.src}`);
      return block;
    }
    if (block.type === "video" && !/^(data:|https?:)/.test(block.src)) {
      const absolute = await resolveAsset(block.src);
      if (!absolute) {
        model.warnings.push(`missing-asset:${slideId}:${block.src}`);
        return block;
      }
      const info = await stat(absolute);
      const out = { ...block, videoName: basename(block.src) };
      // Poster: a sibling image with the same stem (talk.mp4 → talk.png/.jpg/.jpeg/.webp),
      // inlined as a data URI — shown before play, and standing in for the video in share
      // exports when the file itself is too big to inline.
      for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
        const posterPath = absolute.slice(0, -extname(absolute).length) + ext;
        try {
          out.poster = (await inlineDataUri(posterPath, MIME_TYPES.get(ext))).uri;
          break;
        } catch { /* no poster with this ext */ }
      }
      const mime = VIDEO_MIME_TYPES.get(extname(absolute).toLowerCase()) || "video/mp4";
      if (info.size <= VIDEO_INLINE_LIMIT_BYTES) {
        return { ...out, src: (await inlineDataUri(absolute, mime)).uri };
      }
      const name = uniqueName(block.src);
      collected.push({ absolute, name });
      model.warnings.push(`video-asset-only:${slideId}:${out.videoName} (${Math.round(info.size / 1024 / 1024)}MB > inline limit; share exports show the poster)`);
      return { ...out, src: `assets/${name}`, assetOnly: true };
    }
    if (block.type === "embed" && !/^https?:/.test(block.src)) {
      const absolute = await resolveAsset(block.src);
      if (!absolute) {
        model.warnings.push(`missing-asset:${slideId}:${block.src}`);
        return { ...block, missing: true };
      }
      // Self-contained: inline the HTML document into the slide via srcdoc. No external file, no
      // copy step — survives Present (even from tmpdir), build, and a shared standalone file.
      // srcdoc inherits the page origin (keeps the future audience-mirroring spec feasible).
      const srcdoc = await readFile(absolute, "utf8");
      return { ...block, srcdoc };
    }
    if (block.type === "embed" && /^https?:/.test(block.src)) {
      model.warnings.push(`remote-embed:${slideId}`);
      return block;
    }
    if (block.type === "video" && /^https?:/.test(block.src)) {
      model.warnings.push(`remote-video:${slideId}`);
      return block;
    }
    if (block.type === "image-claim") return { ...block, image: await visitBlock(block.image, slideId) };
    if (block.type === "cta-screenshots") {
      return { ...block, images: await Promise.all((block.images || []).map((img) => visitBlock(img, slideId))) };
    }
    if (block.type === "cards") {
      return { ...block, cards: await Promise.all(block.cards.map(async (card) => ({ ...card, blocks: await Promise.all(card.blocks.map((b) => visitBlock(b, slideId))) }))) };
    }
    // PPT-replication batch (2026-06-11): composed blocks that carry media must surface it to
    // this visitor or their images are never copied/inlined (the smoke-test 404 bug).
    if (block.type === "image-quote" && block.image) {
      return { ...block, image: await visitBlock(block.image, slideId) };
    }
    if (block.type === "image-grid") {
      return { ...block, cells: await Promise.all((block.cells || []).map(async (cell) => ({ ...cell, blocks: await Promise.all((cell.blocks || []).map((b) => visitBlock(b, slideId))) }))) };
    }
    return block;
  }
  for (const slide of model.slides) {
    if (Array.isArray(slide.blocks)) {
      slide.blocks = await Promise.all(slide.blocks.map((b) => visitBlock(b, slide.id)));
    }
    // ADR-0022 CAROUSEL: a carousel's media (image/video/embed) lives on its SUB-SLIDES
    // (`slide.carousel[].blocks`), never on `slide.blocks`. Missing them here left carousel
    // media as a raw relative `assets/…` src in the self-contained fullHtml, so it 404'd from
    // any non-source directory. Thumbnails load fullHtml from a tmpdir temp file: the image
    // never decoded → settle's "don't cache incomplete" guard skipped the MAIN capture → the
    // card 404'd to the title-only schematic (and the version filmstrip went blank the same way).
    // Walk every sub-slide's blocks through the SAME visitor so their media inlines/collects too.
    if (Array.isArray(slide.carousel)) {
      for (const sub of slide.carousel) {
        if (sub && Array.isArray(sub.blocks)) {
          sub.blocks = await Promise.all(sub.blocks.map((b) => visitBlock(b, slide.id)));
        }
      }
    }
  }
  return collected;
}

// Inject each slide's own Markdown into its speaker notes (demo/showcase only, via
// --notes-from-source). Splits the body at level-2/3 headings (#### stays within its slide) and
// appends a `:::notes` block to each slide carrying that slide's verbatim Markdown in a fenced
// block — so opening the notes shows exactly the source that produced the slide. Merges into an
// existing :::notes block (the adapter allows one fence per slide). A 4-backtick wrapper keeps
// any inner ``` code fences in the slide intact.
export function injectPerSlideNotes(markdown) {
  const fm = (markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/) || [""])[0];
  const body = markdown.slice(fm.length);
  const isBoundary = (l) => /^(##|###)\s/.test(l);
  const chunks = [];
  let cur = null;
  for (const l of body.split("\n")) {
    if (isBoundary(l)) { if (cur) chunks.push(cur); cur = [l]; }
    else if (cur) cur.push(l);
    else chunks.push([l]); // preamble before the first heading — kept verbatim
  }
  if (cur) chunks.push(cur);
  const noteRe = /\n?:::notes\r?\n([\s\S]*?)\r?\n:::[ \t]*\n?/;
  const out = chunks.map((chunk) => {
    if (!isBoundary(chunk[0])) return chunk.join("\n");
    const text = chunk.join("\n");
    const m = text.match(noteRe);
    const existing = m ? m[1].replace(/\s+$/, "") : "";
    const slideSource = (m ? text.replace(noteRe, "\n") : text).replace(/\s+$/, "");
    const noteBody = [existing, existing ? "" : null, "**Markdown for this slide:**", "````md", slideSource, "````"]
      .filter((x) => x !== null).join("\n");
    return `${slideSource}\n\n:::notes\n${noteBody}\n:::\n`;
  });
  return fm + out.join("\n");
}

// `defaults` (optional 5th arg, Task 3): { warnAtMinutes, urgentAtMinutes } — the Settings global
// default for the presenter clock's amber/dark-amber thresholds. Main threads in the resolved
// config value; a frontmatter `warn-at:`/`urgent-at:` on the deck still wins over it. Every existing
// call site omits this arg and gets the compiler's own 5/1 fallback, so this is purely additive.
export async function prepareSource(sourcePath, sourceText, explicitTitle, sourceStat, defaults) {
  const fallbackTitle = explicitTitle || basename(sourcePath, extname(sourcePath));
  if (sourceStat?.isDirectory()) {
    const model = await adaptSourceProject(sourcePath, explicitTitle);
    return { ...model, fullHtml: await buildDeckHtmlFromModel(model) };
  }
  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".html" || extension === ".htm") {
    const title = explicitTitle || extractTitle(sourceText, fallbackTitle);
    return {
      title,
      fullHtml: explicitTitle ? updateDeckTitle(sourceText, title) : sourceText,
      sourceType: "static-html",
      adapter: "static-html-v1",
      contentSchemaVersion: null,
      warnings: []
    };
  }
  if (extension === ".md" || extension === ".markdown") {
    // v2 markers: frontmatter, `####` cards, an explicit `{key=value}` trailer, a bare-word
    // `{trigger}` trailer (ADR-0004 shorthand — a heading ending in `{word}` / `{word word}` /
    // `{word,word}` with no `=`), or an `[Embed:]`/`[Simulation:]`/`[Video:]` directive.
    const isV2 = /^---\r?\n[\s\S]*?\r?\n---/.test(sourceText)
      || /^####\s/m.test(sourceText)
      || /\{[a-z]+=[^}]*\}\s*$/m.test(sourceText)
      || /^#{1,4}\s.*\{[A-Za-z][\w-]*(?:[ ,][\w-]+)*\}\s*$/m.test(sourceText)
      || /^\[(Embed|Simulation|Video):/mi.test(sourceText);
    const model = isV2 ? adaptMarkdownOutlineV2(sourceText, fallbackTitle, defaults) : adaptMarkdownOutline(sourceText, fallbackTitle);
    if (explicitTitle) model.title = explicitTitle;
    // v1 (legacy, no frontmatter support) never sets warnAtMinutes/urgentAtMinutes itself — but the
    // Settings global default should still apply to it, so apply defaults here rather than leaving
    // v1 decks stuck on the hardcoded 5/1 fallback in buildDeckHtmlFromModel.
    if (!isV2) {
      const warnAtMinutes = Number(defaults?.warnAtMinutes ?? 5);
      model.warnAtMinutes = warnAtMinutes;
      model.urgentAtMinutes = Math.min(Number(defaults?.urgentAtMinutes ?? 1), warnAtMinutes);
    }
    // Icon-gap detection: scan feature lists for brand-like unmatched tokens.
    // Only runs for v2 (v1 does not use feature lists with brand detection).
    if (isV2) {
      // ICONS ARE OPT-IN. The auto-detect heuristic no longer DRIVES any render; it survives as
      // a non-applied SUGGESTION. `icon-suggested:<slide-id>` flags a plain list the compiler
      // thinks could carry icons (add `{iconlist}`/`{logolist}` to opt in). Lists the author
      // already styled (`{numbered}`/`{iconlist}`/…) are skipped.
      for (const hint of collectIconSuggestions(model.slides)) {
        model.warnings.push(hint);
      }
      // icon-gap / icon-semantic-needed remain as resolution hints for the OPT-IN icon path: if
      // an author turns on `{iconlist}`, these say which items still need a curated icon. They no
      // longer imply a list silently renders plain (every non-forced list renders plain now).
      const gapTerms = collectIconGapTerms(model.slides);
      for (const term of gapTerms) {
        model.warnings.push(`icon-gap:${term}`);
      }
      for (const warn of collectSemanticIconNeeds(model.slides)) {
        model.warnings.push(warn);
      }
      // ALL-FAIL: an author forced {iconlist}/{iconrow} but not one item resolved to a glyph —
      // the list silently rendered plain. High-signal, per-slide; TalkWeaver surfaces it as a badge.
      for (const warn of collectIconlistNoIcons(model.slides)) {
        model.warnings.push(warn);
      }
    }
    const assets = await inlineAndCollectAssets(model, dirname(resolve(sourcePath)));
    return { ...model, assets, fullHtml: await buildDeckHtmlFromModel(model), sourceDir: dirname(resolve(sourcePath)) };
  }
  if (extension === ".json") {
    const json = JSON.parse(sourceText);
    const isLearnWeaver = json.learnweaver_export_version || json.type === "learnweaver-export" || json.source_type === "learnweaver";
    const model = isLearnWeaver ? adaptLearnWeaverExport(json, fallbackTitle) : adaptCanonicalPptJson(json, fallbackTitle);
    if (explicitTitle) model.title = explicitTitle;
    return { ...model, fullHtml: await buildDeckHtmlFromModel(model) };
  }
  throw new Error(`Unsupported source type: ${extension || "unknown"}`);
}

// SD-17: collect all http/https links from raw slide source lines. Takes the slide array
// (after flushSlide), reads each slide's `sourceLines`, dedupes by URL (first-seen order),
// returns [{text, url}]. ftp:// and other schemes are NOT collected. When anchor text equals
// the URL string, the URL itself is used as the display text.
export function collectDeckLinks(slides) {
  const RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const seen = new Set();
  const result = [];
  for (const slide of slides) {
    const lines = Array.isArray(slide.sourceLines) ? slide.sourceLines : [];
    for (const line of lines) {
      let m;
      RE.lastIndex = 0;
      while ((m = RE.exec(line)) !== null) {
        const text = m[1];
        const url = m[2];
        if (seen.has(url)) continue;
        seen.add(url);
        result.push({ text: text === url ? url : text, url });
      }
    }
  }
  return result;
}

export function assertNoPrivateStrings(label, value) {
  const patterns = [
    /\/Users\/[A-Za-z0-9._-]+/i,
    /Nexus365/i,
    // OneDrive only as a leaked PATH — a path segment (/OneDrive, \OneDrive) or the business
    // cloud-folder form (OneDrive-Tenant / "OneDrive - Tenant"). The bare word is legitimate
    // slide content (e.g. a talk teaching SharePoint/OneDrive) and must not block publishing.
    /[\\/]OneDrive|OneDrive\s*-\s*\w/i,
    /CF_API/i,
    /api[_-]?token/i,
    /account[_-]?id/i,
  ];
  const hit = patterns.find((pattern) => pattern.test(value));
  if (hit) {
    throw new Error(`${label} contains a private-looking string matching ${hit}`);
  }
}
