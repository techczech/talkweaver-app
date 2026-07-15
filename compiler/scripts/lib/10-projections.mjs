import { createHash } from "node:crypto";
import { parseTagsValue } from "./12-outline-edit.mjs";

// ----------------------------------------------------------------------------
// PER-SLIDE PROJECTIONS (P1 integration bridge — the safe, non-destructive half).
//
// After a deck is modelled, emit one JSON record per slide into
// `app/per-slide-projections.jsonl`. This is an inert build ARTEFACT consumed by
// P3 (the Slide Library + Element Library); the source Outline is NEVER modified
// here (no `{#id}` write-back — that is a separate, held step). Field names are
// aligned with the canonical PPT schema / ppt-archive registry (role values,
// `content_hash`, per-element `hash`) so html-built decks index alongside the 703
// extracted decks without a translation layer.
//
// `id_source` records whether the `slide_id` was stamped into the Outline
// (`"stamped"`) or DERIVED for the projection only (`"auto"`); the future
// write-back step upgrades derived ids to stamped without changing the schema.
// ----------------------------------------------------------------------------

// Strip the small subset of inline markdown the renderer understands so projected
// text reads like the rendered slide (links → their label, **/*/`/~~ dropped).
// =============================================================================
// 10. Per-slide projections — stable per-slide records for the Slide Library
// =============================================================================

function stripInlineMarkdown(value) {
  return String(value == null ? "" : value)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")            // images → nothing
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")          // links → label
    .replace(/[*_~`]+/g, "")                          // bold / italic / code / strike marks
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProjectionText(value) {
  return stripInlineMarkdown(value).toLowerCase();
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Flatten a (possibly nested) list to its item strings. v2 lists carry `items`
// (top-level strings) + parallel `children` arrays; feature-lists carry `items`
// which may be strings or `{text}` objects.
function flattenListItems(block) {
  const out = [];
  const walk = (items, children) => {
    (items || []).forEach((item, index) => {
      const text = typeof item === "string" ? item : (item?.text || "");
      if (text) out.push(text);
      const kids = Array.isArray(children) ? children[index] : item?.children;
      if (Array.isArray(kids) && kids.length) {
        walk(kids.map((k) => (typeof k === "string" ? k : k?.text || "")), kids.map((k) => k?.children));
      }
    });
  };
  walk(block.items, block.children);
  return out;
}

// Plain-text extraction for one content block. Returns "" for blocks that carry
// no readable text (a bare image with no alt/caption). Used for both the slide
// text excerpt/word count and per-element excerpts/hashes.
function blockText(block) {
  if (!block || typeof block !== "object") return "";
  switch (block.type) {
    case "paragraph":
    case "subheading":
    case "heading":
    case "title":
      return stripInlineMarkdown(block.text);
    case "quote": {
      const body = Array.isArray(block.paragraphs) && block.paragraphs.length
        ? block.paragraphs.join(" ")
        : block.text || "";
      return stripInlineMarkdown([body, block.cite].filter(Boolean).join(" — "));
    }
    case "list":
    case "feature-list":
      return flattenListItems(block).map(stripInlineMarkdown).join(" ");
    case "image":
      return stripInlineMarkdown([block.alt, block.caption].filter(Boolean).join(" "));
    case "image-row":
      return (block.images || []).map((img) => blockText(img)).filter(Boolean).join(" ");
    case "table": {
      const cells = [];
      for (const row of [block.header, ...(block.rows || [])]) {
        for (const cell of (row || [])) cells.push(typeof cell === "string" ? cell : cell?.text || "");
      }
      return stripInlineMarkdown(cells.filter(Boolean).join(" "));
    }
    case "code":
      return String(block.text || "");
    case "smartart":
    case "flow":
    case "pyramid":
    case "orgchart":
    case "mindmap":
    case "system-map":
      return (block.nodes || []).map((n) => stripInlineMarkdown(typeof n === "string" ? n : n?.text || "")).filter(Boolean).join(" ");
    case "conceptmap":
      return (block.edges || []).map((e) => [e?.from, e?.label, e?.to].filter(Boolean).join(" ")).join(" ");
    case "timeline":
      return (block.items || []).map(stripInlineMarkdown).filter(Boolean).join(" ");
    case "tiles":
    case "contrast":
      return (block.items || block.pairs || []).map((x) => stripInlineMarkdown(typeof x === "string" ? x : x?.text || JSON.stringify(x))).join(" ");
    case "cards":
      return (block.cards || []).map((c) => [stripInlineMarkdown(c.title), ...(c.blocks || []).map(blockText)].filter(Boolean).join(" ")).join(" ");
    case "embed":
    case "video":
    case "qr":
    case "action":
    case "actions":
      return "";
    default:
      return stripInlineMarkdown(block.text || "");
  }
}

// Map a content block to a reusable Element-Library type (ADR-0013 typed units).
// Returns null for blocks that are not catalogued at v0 (embeds, bare media rows,
// actions, QR). `box`/`slide` are coarser subtrees handled at the slide level.
const VISUALISATION_BLOCK_TYPES = new Set([
  "smartart", "flow", "pyramid", "orgchart", "mindmap",
  "conceptmap", "system-map", "timeline", "tiles", "contrast"
]);
function elementTypeForBlock(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "image") return "image";
  if (block.type === "quote") return "quote";
  if (block.type === "list" || block.type === "feature-list") return "bullet-list";
  if (VISUALISATION_BLOCK_TYPES.has(block.type)) return "visualisation";
  if (block.type === "cards") return "box";
  return null;
}

function shortExcerpt(text, max = 120) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

// Build the `elements: [...]` array for one slide (Element Library seed, v0). Each
// catalogued block becomes `{type, hash, excerpt}` where hash is sha256 of the
// element's own normalised text — content-addressed so the same quote/list/image
// across decks collides, exactly like the slide-level content_hash.
function buildSlideElements(slide) {
  const elements = [];
  for (const block of (slide.blocks || [])) {
    const type = elementTypeForBlock(block);
    if (!type) continue;
    const text = blockText(block);
    // An image with no alt/caption still has reuse identity via its src.
    const hashInput = type === "image" && !text ? `image:${block.src || ""}` : normalizeProjectionText(text);
    if (!hashInput) continue;
    elements.push({
      type,
      hash: `sha256-${sha256Hex(hashInput)}`,
      excerpt: shortExcerpt(text || block.src || "")
    });
  }
  return elements;
}

function countBlocks(slide, predicate) {
  return (slide.blocks || []).filter(predicate).length;
}

// Build one projection record per slide. `model.slides` is the rich modelled deck
// (markdown-outline / source-project / canonical-ppt / learnweaver adapters). The
// static-html adapter has no model, so this returns null and no file is emitted.
export function buildPerSlideProjections(model, deckSlug) {
  const slides = model?.slides;
  if (!Array.isArray(slides) || slides.length === 0) return null;
  const stampedIds = model.stampedSlideIds instanceof Set ? model.stampedSlideIds : null;
  // Per-slide compiler warnings. Most engine warnings encode the slide they belong to as the
  // SECOND colon-segment (`iconlist-no-icons:<slide-id>`, `icon-semantic-needed:<slide-id>:<item>`,
  // `missing-source-ref:<slide-id>`). Index them by that id so each row carries only its own.
  const warningsBySlide = new Map();
  for (const w of (Array.isArray(model.warnings) ? model.warnings : [])) {
    const slideId = String(w).split(":")[1];
    if (!slideId) continue;
    if (!warningsBySlide.has(slideId)) warningsBySlide.set(slideId, []);
    warningsBySlide.get(slideId).push(w);
  }
  return slides.map((slide, index) => {
    const blocks = Array.isArray(slide.blocks) ? slide.blocks : [];
    // Slides modelled with rich blocks use blockText; html-only slides (source-project
    // adapter) fall back to their rendered html stripped to text.
    const slideText = blocks.length
      ? blocks.map(blockText).filter(Boolean).join("\n")
      : stripInlineMarkdown(String(slide.html || slide.message || "").replace(/<[^>]+>/g, " "));
    const normalized = normalizeProjectionText([slide.title, slideText].filter(Boolean).join("\n"));
    const contentHash = `sha256-${sha256Hex(normalized)}`;
    // render_hash: a hash of the whole rendered slide MODEL (layout + transformed blocks +
    // attrs), not just its text. content_hash is slide IDENTITY for the Library and must stay
    // stable across a layout change; render_hash is the PICTURE identity. TalkWeaver keys its
    // thumbnail cache on this -- keying on content_hash made a layout/trigger edit a cache hit,
    // so the preview kept the stale render. We hash the MODEL (its blocks already carry layout
    // transforms and consumed triggers like liststyle=numbers, which no longer appear in
    // slide.attrs). id, sourceMarkdown and notes are excluded: they change source/identity, not
    // the picture.
    // `tags` is excluded alongside id/source/notes: a tag is curated METADATA on the Trigger
    // line (ADR-0037), never part of the rendered picture — hashing it would invalidate the
    // thumbnail cache on every tagging gesture.
    const renderKey = JSON.stringify(slide, (k, v) =>
      k === "id" || k === "sourceMarkdown" || k === "notes" || k === "tags" ? undefined : v
    );
    const renderHash = `sha256-${sha256Hex(renderKey)}`;
    // slide_id: the modelled id is what a future {#id} write-back will stamp. Until the
    // outline carries an explicit {#id} (slide.attrs.id / a stamped registry), the id is
    // DERIVED — flagged id_source:"auto". We keep the human-readable derived id (the auto
    // slug) AND a stable content-addressed fallback so two slides that ever collide on slug
    // still differ. P3 indexes by slide_id; the write-back step flips id_source to "stamped".
    const idStamped = Boolean(stampedIds?.has(slide.id) || slide.idStamped);
    const slideId = slide.id || `${deckSlug}-slide-${index + 1}`;
    const triggers = slide.attrs && typeof slide.attrs === "object" ? { ...slide.attrs } : {};
    const wordCount = normalizeProjectionText(slideText).split(/\s+/).filter(Boolean).length;
    return {
      slide_id: slideId,
      id_source: idStamped ? "stamped" : "auto",
      // When derived, P3 should index by this content-addressed key (stable across renames);
      // the write-back step replaces slide_id with the stamped value and drops this hint.
      derived_id_basis: idStamped ? null : `${deckSlug}:${contentHash}`,
      deck_slug: deckSlug,
      order: index,
      section: slide.section || "",
      subsection: slide.subsection || "",
      role: slide.role || "content",
      layout: slide.layout || "",
      nav_title: slide.navTitle || slide.title || "",
      title: slide.title || "",
      text_excerpt: shortExcerpt(slideText, 240),
      word_count: wordCount,
      bullet_count: (slide.blocks || []).reduce((sum, b) => sum + ((b?.type === "list" || b?.type === "feature-list") ? flattenListItems(b).length : 0), 0),
      image_count: countBlocks(slide, (b) => b?.type === "image") + (slide.blocks || []).reduce((sum, b) => sum + (b?.type === "image-row" ? (b.images || []).length : 0), 0),
      embed_count: countBlocks(slide, (b) => b?.type === "embed" || b?.type === "video"),
      has_quote: blocks.some((b) => b?.type === "quote"),
      has_table: blocks.some((b) => b?.type === "table"),
      has_code: blocks.some((b) => b?.type === "code"),
      // The slide's VERBATIM outline markdown — the unit of reuse (Copy slide source, [use:]
      // materialisation). Empty for auto-generated slides (deck title, section dividers).
      source_markdown: slide.sourceMarkdown || "",
      // 1-based source line of this slide's heading (null for synthesized cover/closing slides) —
      // lets the app map the editor cursor ↔ strip directly, with no heading-walk drift.
      source_line: typeof slide.sourceLine === "number" ? slide.sourceLine : null,
      triggers,
      // Curated slide tags (ADR-0037): the Trigger line's `tags=` token, lowercase-kebab
      // normalised, deduped; [] when absent. Search/vocabulary aggregation reads THIS field.
      tags: parseTagsValue(typeof triggers.tags === "string" ? triggers.tags : ""),
      content_hash: contentHash,
      render_hash: renderHash,
      elements: buildSlideElements(slide),
      warnings: warningsBySlide.get(slideId) || []
    };
  });
}

