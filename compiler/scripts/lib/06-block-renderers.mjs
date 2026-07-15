import { basename } from "node:path";
import { highlightCode } from "../highlight.mjs";
import { slugify, chooseBalancedColumns, escapeHtml, makeQrSvg, cleanQrUrl } from "./01-cli-utils.mjs";
import { parseConceptRelations, spineFontScale, timelineDateOf, groupTimelineRows, autoTimelineMode, renderInline, TRACE_ROLES, autoSpeakerClass } from "./02-triggers-layout.mjs";
import { withoutScripts } from "./04-html-extraction.mjs";
import { resolveIconOverrides, decideFeatureListStyle, iconSvg } from "./05-icons.mjs";

// Snake-flow row distribution (2026-06-12): max 4 nodes per row, rows as EVEN as possible so
// a wrap never strands a dangling single terminal (5 -> 3+2, 7 -> 4+3, 9 -> 3+3+3, 10 -> 4+3+3).
// Larger rows come first.
export function computeFlowRows(count, maxPerRow = 4) {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];
  const rows = Math.ceil(n / maxPerRow);
  const base = Math.floor(n / rows);
  const extras = n % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extras ? 1 : 0));
}

// deckUsed (optional Set): deck-level icon registry for uniqueness tracking.
// Pass it from renderModelSlides → renderBlocks → renderBlock so all feature-lists in a
// deck share the same tracker. When null (e.g. in tests), a fresh set is created per call.
// Intrinsic-size attributes for an inlined raster image. width/height give the browser the
// real aspect ratio up front (no layout shift) AND, paired with the template's never-upscale
// CSS, let a small screenshot render at most 1:1 — it is letterboxed inside its box rather than
// stretched up into blur (the "looks repeatedly recompressed" artefact). SVG / dimensionless
// images get no attributes and keep the default fill behaviour.
// =============================================================================
// 6. Block renderers — typed blocks -> slide HTML; renderBlock, mapBlocksToLayout
// =============================================================================

function imageSizeAttrs(block) {
  if (!block || !block.width || !block.height) return "";
  return ` width="${block.width}" height="${block.height}"`;
}

function renderImageFigure(block) {
  // SD-4: figure.fig gives the centred-caption flex column; slide-figure is kept for the
  // lightbox selector (figure.slide-figure img) and all existing CSS that targets it.
  return `<figure class="slide-figure fig"><img src="${escapeHtml(block.src)}"${imageSizeAttrs(block)} alt="${escapeHtml(block.alt)}">${block.caption ? `<figcaption>${renderInline(block.caption)}</figcaption>` : ""}</figure>`;
}

// G5: collapse each run of 2+ consecutive image blocks into one synthetic `image-row` block so
// they render side-by-side. Non-image blocks (and lone images) pass through unchanged, order
// preserved. Applied at every block-list render site (card body, media column, slide body).
export function groupImageRows(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) out.push({ type: "image-row", images: run });
    else if (run.length === 1) out.push(run[0]);
    run = [];
  };
  for (const b of blocks) {
    if (b && typeof b === "object" && b.type === "image") run.push(b);
    else { flush(); out.push(b); }
  }
  flush();
  return out;
}

// Group a run of 2+ consecutive `qr` blocks into one `qr-row` so multiple QR codes lay out
// side-by-side (same .figure-row grammar images use). A lone QR stays a bare figure.
export function groupQrRows(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) out.push({ type: "qr-row", codes: run });
    else if (run.length === 1) out.push(run[0]);
    run = [];
  };
  for (const b of blocks) {
    if (b && typeof b === "object" && b.type === "qr") run.push(b);
    else { flush(); out.push(b); }
  }
  flush();
  return out;
}

// Render a run of action buttons as a .slide-actions row. Each button is an accent button
// (.slide-action). The URL uses the same scheme allowlist as inline markdown links; an
// external (http/mailto) link opens in a new tab with rel="noopener". Relative/anchor links
// (a sibling HTML file, `#id`, `./path`) stay in-tab and carry no target.
function renderActionRow(actions) {
  const buttons = (actions || []).filter((a) => a && a.label).map((a) => {
    const raw = String(a.url ?? "");
    const external = /^(https?|mailto):/i.test(raw);
    // Allow http/https/mailto, anchors, explicit relative paths, AND a bare relative path
    // (a sibling file like `further-reading-narrative.html`). Reject anything carrying a
    // foreign scheme (a `scheme:` before the first `/`) — e.g. `javascript:` — for safety.
    const hasForeignScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !external;
    const safe = !raw || hasForeignScheme ? "#" : raw;
    const rel = external ? ' target="_blank" rel="noopener"' : "";
    return `<a class="slide-action" href="${escapeHtml(safe)}"${rel}>${renderInline(a.label)}</a>`;
  }).join("");
  return buttons ? `<div class="slide-actions">${buttons}</div>` : "";
}

// Collapse consecutive `action` blocks into a single `actions` block so a run of action
// directives renders as one .slide-actions row. Non-action blocks pass through unchanged.
export function groupActionBlocks(blocks) {
  const out = [];
  let run = null;
  for (const b of blocks) {
    if (b && b.type === "action") {
      if (!run) { run = { type: "actions", actions: [] }; out.push(run); }
      run.actions.push(b);
    } else {
      run = null;
      out.push(b);
    }
  }
  return out;
}

export function renderBlock(block, deckUsed = null, frameIcons = "off") {
  if (typeof block === "string") return `<p>${escapeHtml(block)}</p>`;
  if (!block || typeof block !== "object") return "";
  if (block.html) return withoutScripts(block.html);
  const text = block.text ?? block.content ?? block.body ?? "";
  if (block.type === "heading" || block.type === "title") return `<h2>${escapeHtml(text)}</h2>`;
  if (block.type === "subheading") return `<h3>${renderInline(text)}</h3>`;
  if (block.type === "quote") {
    let paras = Array.isArray(block.paragraphs) && block.paragraphs.length
      ? block.paragraphs
      : [block.text ?? ""];
    // G1: the decorative quote-mark device SUPPLIES the quotation marks, so strip a single
    // wrapping pair of literal double quotes off the quote body — covers `> "…"` quotes
    // (author wrote the marks) and any quote whose first/last paragraph is wrapped. Curly and
    // straight pairs both handled. Marks INSIDE the quote (e.g. a nested "human being") stay.
    if (paras.length) {
      const first = paras[0];
      const last = paras[paras.length - 1];
      const opensQuote = /^\s*["“]/.test(first);
      const closesQuote = /["”]\s*$/.test(last);
      if (opensQuote && closesQuote) {
        paras = paras.slice();
        paras[0] = paras[0].replace(/^\s*["“]\s*/, "");
        paras[paras.length - 1] = paras[paras.length - 1].replace(/\s*["”]\s*$/, "");
      }
    }
    const fullText = paras.join(" ");
    // Length bucket scales quote typography in CSS — long multi-paragraph quotes would
    // otherwise overflow the card at full clamp() size. Tuned by eye: short reads big.
    const len = fullText.length;
    const bucket = len <= 220 ? "short" : len <= 600 ? "medium" : "long";
    const body = paras.map((p) => `<p>${renderInline(p)}</p>`).join("");
    return `<blockquote data-quote-length="${bucket}">${body}${block.cite ? `<cite>${renderInline(block.cite)}</cite>` : ""}</blockquote>`;
  }
  if (block.type === "image") {
    return renderImageFigure(block);
  }
  // G5 / ADR-0022 GALLERY: a run of 2+ consecutive images.
  // SD-5: 2-3 images render as .img-row (flex row, equal flex, centred captions below each).
  // 4+ wrap into a responsive multi-row grid (.figure-row-gallery) as before.
  // The lightbox still works because renderImageFigure emits figure.slide-figure.
  if (block.type === "image-row") {
    const images = (block.images || []).filter(Boolean);
    if (images.length === 0) return "";
    if (images.length === 1) return renderImageFigure(images[0]);
    if (images.length >= 4) {
      return `<div class="figure-row figure-row-gallery count-${images.length}">${images.map(renderImageFigure).join("")}</div>`;
    }
    return `<div class="img-row count-${images.length}">${images.map(renderImageFigure).join("")}</div>`;
  }
  if (block.type === "video") {
    // Playback attributes from the media-line tokens (ADR-0028). Default (no tokens) = a manual,
    // control-barred clip; a converted GIF carries {autoplay}{loop}{muted} → ambient, no chrome.
    const f = block.flags || {};
    const attrs = [];
    if (f.autoplay) attrs.push("autoplay", "muted", "playsinline"); // browsers require muted to autoplay
    if (f.loop) attrs.push("loop");
    if (f.muted && !attrs.includes("muted")) attrs.push("muted");
    if (f.controls || !f.autoplay) attrs.push("controls"); // autoplay clips are chrome-less unless asked
    if (!f.autoplay) attrs.push('preload="metadata"');
    const attrStr = attrs.length ? " " + attrs.join(" ") : "";
    const poster = block.poster ? ` poster="${escapeHtml(block.poster)}"` : "";
    const assetOnly = block.assetOnly ? ` data-video-asset-only data-video-name="${escapeHtml(block.videoName || basename(block.src))}"` : "";
    const caption = block.caption ? `<figcaption>${renderInline(block.caption)}</figcaption>` : "";
    return `<figure class="slide-figure slide-video"${assetOnly}><video${attrStr}${poster} src="${escapeHtml(block.src)}"></video>${caption}</figure>`;
  }
  if (block.type === "qr") {
    // [QR: url | label] → a build-time QR SVG (no dependency, no runtime fetch) with the
    // caption beneath. The figure is a steppable mode unit (figure.slide-figure is in
    // MODE_SELECTOR). When the URL exceeds the encoder's Version-4 capacity, fall back to a
    // plain link so the slide still carries the destination. Multiple [QR:] blocks group
    // side-by-side via the same .figure-row path images use (see groupImageRows analogue).
    // QR overhaul (refinement 6, 2026-06-09). The QR sits in the BOTTOM-LEFT corner of the slide
    // (positioned by CSS), with NO white card / no padding ring around the code (its own quiet zone
    // is kept — scanners need it). The whole thing is a button: clicking/focus+Enter opens the code
    // FULL-SCREEN (runtime openQrFullscreen). The linked URL is shown CLEANED beneath the code
    // (scheme + www. stripped, ellipsis if long); the full URL stays in data-qr-url + the aria-label.
    // The caption under the code shows the LINKED URL, cleaned (refinement 6) — NOT the author's
    // label. (The label, if any, still feeds the QR's accessible name via the aria-label.)
    const url = String(block.url || "");
    const cleaned = cleanQrUrl(url);
    const svg = makeQrSvg(url);
    if (!svg) {
      const safe = /^(https?|mailto):/i.test(url) ? url : "#";
      return `<figure class="slide-figure slide-qr slide-qr-corner qr-too-long"><a href="${escapeHtml(safe)}" target="_blank" rel="noopener">${escapeHtml(cleaned)}</a></figure>`;
    }
    // The cleaned URL beneath the code is also a click-through link (so you can reach the
    // destination quickly when viewing on screen), but only when the URL is a real http(s)/
    // mailto target — otherwise it stays plain text (a "#" link would just jump to top).
    const safe = /^(https?|mailto):/i.test(url) ? url : null;
    const caption = safe
      ? `<figcaption class="qr-caption"><a href="${escapeHtml(safe)}" target="_blank" rel="noopener">${escapeHtml(cleaned)}</a></figcaption>`
      : `<figcaption class="qr-caption">${escapeHtml(cleaned)}</figcaption>`;
    return `<figure class="slide-figure slide-qr slide-qr-corner">`
      + `<button type="button" class="qr-code" data-qr-url="${escapeHtml(url)}" aria-label="Show QR code for ${escapeHtml(url)} full screen">${svg}</button>`
      + caption + `</figure>`;
  }
  if (block.type === "qr-row") {
    const codes = (block.codes || []).filter(Boolean);
    if (codes.length === 0) return "";
    if (codes.length === 1) return renderBlock(codes[0], deckUsed);
    return `<div class="figure-row qr-row">${codes.map((c) => renderBlock(c, deckUsed)).join("")}</div>`;
  }
  if (block.type === "embed") {
    // Interact chip (B3): covered embeds render as pointer-events:none previews so they can never
    // steal keyboard focus and freeze navigation. This chip (and the `e` key) opts INTO interaction
    // at the runtime. Video players are excluded — a click on them is "play", and they keep their
    // normal interactive behaviour — so the chip is omitted for them below.
    const interactChip = `<button class="embed-interact-chip" type="button" title="Interact with this embed (press e)" aria-label="Interact with this embed">Interact <kbd>e</kbd></button>`;
    // Self-contained local HTML embed: inline the document via srcdoc (same-origin → mirror-ready,
    // no external file, no 404). Set by inlineAndCollectAssets in 08-source-adapters.
    if (block.srcdoc != null) {
      // For self-contained embeds the local file path must not appear in the output (no external ref).
      return `<figure class="slide-embed${block.variant === "simulation" ? " slide-simulation" : ""}"><iframe srcdoc="${escapeHtml(block.srcdoc)}" scrolling="no" title="${escapeHtml(block.title || "")}" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>${interactChip}</figure>`;
    }
    // A local embed whose source file was missing: show a visible placeholder, never a broken iframe.
    if (block.missing) {
      return `<figure class="slide-embed slide-embed-missing"><p class="embed-missing">Missing embed: ${escapeHtml(block.src || "")}</p></figure>`;
    }
    const rawSrc = block.src ?? "";
    const src = escapeHtml(rawSrc);
    const remote = /^https?:/i.test(rawSrc);
    // A YouTube/Vimeo player iframe PLAYS from file:// — mark it so the runtime promotes it to a
    // live src (never the offline fallback card) regardless of protocol. Detect against the
    // normalized embed endpoint (youtube-nocookie.com / player.vimeo.com) the generator emitted.
    const isVideo = /(?:youtube-nocookie\.com\/embed\/|player\.vimeo\.com\/video\/)/i.test(rawSrc);
    // Remote (non-video) embeds also get a persistent "Open <host> ↗" caption: in a shared file a
    // site that refuses framing still gives the viewer a working link, and we never guess-and-card.
    let openLink = "";
    if (remote && !isVideo) {
      let host = rawSrc;
      try { host = new URL(rawSrc).hostname.replace(/^www\./, ""); } catch { /* keep raw */ }
      openLink = `<a class="embed-open-link" href="${src}" target="_blank" rel="noopener">Open ${escapeHtml(host)} ↗</a>`;
    }
    return `<figure class="slide-embed${block.variant === "simulation" ? " slide-simulation" : ""}${isVideo ? " slide-embed-video" : ""}"><iframe data-src="${src}"${remote ? ` data-embed-url="${src}"` : ` scrolling="no"`}${isVideo ? ` data-embed-video="1"` : ""} title="${escapeHtml(block.title || block.src || "")}" loading="lazy" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>${openLink}${isVideo ? "" : interactChip}</figure>`;
  }
  if (block.type === "timeline") {
    // Normalise to groups. Older blocks carry only flat `items` (strings); wrap them as a
    // single ungrouped group so the structured renderer always has a uniform shape.
    let groups = Array.isArray(block.groups) && block.groups.length
      ? block.groups
      : [{ label: "", items: (block.items || []).map((it) => timelineDateOf(it)) }];
    // Timeline presentation mode: explicit {timeline=rail|columns|compact|horizontal} wins; else
    // auto. ORIENTATION VARIANTS (new-layouts batch): {timelinevertical} → `vertical`, an alias
    // for the conventional `rail` (the vertical dated rail); {timelinehorizontal} → `horizontal`,
    // a left-to-right track of dated stops. Timeline entries no longer emit data-fragment — they
    // are full by default and step only when reveal/focus mode is on (the runtime walks
    // .timeline .tl-entries > li as units).
    const rawMode = block.mode === "vertical" ? "rail" : block.mode; // vertical is an alias of rail
    const explicit = rawMode && ["rail", "columns", "compact", "horizontal", "spine", "pills", "dynamic"].includes(rawMode) ? rawMode : "";
    const mode = explicit || autoTimelineMode(groups);
    // SPINE ({timelinespine}, treatment A) and PILLS ({timeline-pills}, treatment D) — the classic
    // illustrated horizontal timeline. A central Oxford-blue spine bar runs across the slide with
    // ONE dot per DATE marker (group). Both share the spine machinery; they differ only in how the
    // date reads and where the card sits:
    //   • SPINE (A): a dot on the line, the date LABEL on the spine by its dot, and the event CARD
    //     ALTERNATING above/below the spine by index parity, joined to the dot by a dotted leader.
    //   • PILLS (D): the date renders as a solid accent PILL sitting on the spine, and a single
    //     event CARD hangs BELOW every stop (uniform, all the same side), joined by a dotted leader.
    // Each is built for ~6 legible stops across the slide width; >SPINE_STOPS_PER_SLIDE stops
    // auto-split into continuation slides upstream (flushSlide), so a render here is always ≤cap.
    // The card lists that date's events (one line each); stops are absolutely positioned over an
    // even N-column track, so spacing stays generous and nothing overlaps. Stop <li> are steppable.
    if (mode === "dynamic") {
      // Mockup .tl-dyn (locked slide 3b): 38% event list on a hairline rail, the CURRENT event's
      // detail on a tint card right. Entry 1 = list headline; entry 2 = detail headline; the rest
      // = detail prose. CSS pairs list group N to detail N and tracks the last revealed beat.
      const list = groups.map((g) => {
        const date = g.label ? `<span class="tl-dyn-date">${renderInline(g.label)}</span>` : "";
        const first = g.items[0];
        const headline = first ? `<span class="tl-dyn-w">${renderInline(first.body || first.date || "")}</span>` : "";
        return `<div class="tl-group"><ol class="tl-dyn-entries"><li>${date}${headline}</li></ol></div>`;
      }).join("");
      const details = groups.map((g) => {
        const big = g.items[1] ? renderInline(g.items[1].body || "") : (g.items[0] ? renderInline(g.items[0].body || "") : "");
        const more = g.items.slice(2).map((it) => `<p>${renderInline(it.body || "")}</p>`).join("");
        return `<div class="tl-detail"><div class="tl-detail-big">${big}</div>${more ? `<div class="tl-detail-more">${more}</div>` : ""}</div>`;
      }).join("");
      return `<div class="timeline timeline-dynamic" data-timeline-mode="dynamic"><div class="tl-dyn-list">${list}</div><div class="tl-dyn-pane">${details}</div></div>`;
    }
    if (mode === "spine" || mode === "pills") {
      // Each GROUP is a dated stop. The stop's date = the group label (the canonical date header)
      // or, when the group is unlabelled, the first item's leading date. The card lists the
      // group's event bodies (each item's body; its own date prefix, if any, leads the line).
      const stops = groups.map((g) => {
        const headDate = g.label && timelineDateOf(g.label).date ? timelineDateOf(g.label).date : g.label;
        const firstDate = g.items.find((it) => it.date);
        const date = headDate || (firstDate ? firstDate.date : "");
        const events = g.items.map((it) =>
          it.date && it.date !== date
            ? `<li><span class="tl-event-date">${renderInline(it.date)}</span> ${renderInline(it.body)}</li>`
            : `<li>${renderInline(it.body || it.date || "")}</li>`
        ).join("");
        return { date, events };
      }).filter((s) => s.date || s.events);
      const dot = `<span class="tl-spine-dot" aria-hidden="true"></span>`;
      const lead = `<span class="tl-spine-leader" aria-hidden="true"></span>`;
      if (mode === "pills") {
        // PILLS (D): the date PILL sits on the spine and IS the stop marker (no separate dot —
        // the pill covers it, exactly as in the sampler). One card hangs below each stop, joined
        // by a dotted leader. Uniform — no alternation.
        const renderStop = (s) => {
          const card = `<div class="tl-spine-card"><ol class="tl-spine-events">${s.events}</ol></div>`;
          const pill = s.date ? `<span class="tl-spine-pill">${renderInline(s.date)}</span>` : "";
          return `<li class="tl-spine-stop" data-side="below">${pill}${lead}${card}</li>`;
        };
        const inner = stops.map(renderStop).join("");
        const cols = Math.max(1, stops.length);
        const scale = spineFontScale(cols);
        return `<div class="timeline timeline-pills" data-timeline-mode="pills" style="--tl-spine-cols:${cols};--tl-spine-scale:${scale}"><ol class="tl-spine-track">${inner}</ol></div>`;
      }
      // SPINE (A): card alternates above/below by parity; date label sits on the spine.
      const renderStop = (s, idx) => {
        const side = idx % 2 === 0 ? "above" : "below"; // even index → card above the spine
        const card = `<div class="tl-spine-card"><ol class="tl-spine-events">${s.events}</ol></div>`;
        const label = s.date ? `<p class="tl-spine-date">${renderInline(s.date)}</p>` : "";
        return `<li class="tl-spine-stop" data-side="${side}">${card}${label}${dot}${lead}</li>`;
      };
      const inner = stops.map(renderStop).join("");
      const cols = Math.max(1, stops.length);
      const scale = spineFontScale(cols);
      return `<div class="timeline timeline-spine" data-timeline-mode="spine" style="--tl-spine-cols:${cols};--tl-spine-scale:${scale}"><ol class="tl-spine-track">${inner}</ol></div>`;
    }
    // A single dotted entry. Dated entries split the date into an accent column.
    const renderEntry = (it) => {
      if (it.date) {
        return `<li><span class="tl-date">${renderInline(it.date)}</span><span class="tl-body">${renderInline(it.body)}</span></li>`;
      }
      return `<li><span class="tl-body">${renderInline(it.body || "")}</span></li>`;
    };
    const renderGroup = (g) => {
      const head = g.label ? `<p class="tl-group-head">${renderInline(g.label)}</p>` : "";
      return `<div class="tl-group">${head}<ol class="tl-entries">${g.items.map(renderEntry).join("")}</ol></div>`;
    };
    const grouped = groups.some((g) => g.label) ? " timeline-grouped" : "";
    return `<div class="timeline timeline-${mode}${grouped}" data-timeline-mode="${mode}">${groups.map(renderGroup).join("")}</div>`;
  }
  if (block.type === "flow") {
    // A connected sequence of NODE cards joined by accent connectors (CSS-drawn chevrons). Each
    // top-level item is a node (.flow-node — bold label, accent key phrase via inline); its
    // nested children render as smaller detail lines (.flow-detail) inside the card. Direction:
    //   horizontal (default) — left→right, wraps; vertical — stacked, downward arrows;
    //   loop — a cycle whose last node returns to the first (a return arrow at the full state);
    //   branch — a node with children fans out to its children as a sub-row beneath it.
    // Nodes are the steppable units (.flow-node is in MODE_SELECTOR); connectors are decorative
    // (aria-hidden) and reflow responsively, shrinking with the slide via clamp() typography.
    const DIRS = new Set(["horizontal", "vertical", "loop", "branch"]);
    const direction = DIRS.has(block.direction) ? block.direction : "horizontal";
    const nodes = (block.nodes || []).filter((n) => n && (n.text || (n.children || []).length));
    if (!nodes.length) return "";
    const connector = `<div class="flow-connector" aria-hidden="true"><span class="flow-arrow"></span></div>`;
    // branch: a node renders its label then, if it has children, a fanned sub-row of child nodes
    // beneath it (joined to the parent by a downward stem). Other directions render children as
    // quiet detail lines inside the card.
    const renderDetail = (kids) => {
      if (!Array.isArray(kids) || !kids.length) return "";
      const lines = kids.map((k) => `<span class="flow-detail-line">${renderInline(k.text)}</span>`).join("");
      return `<div class="flow-detail">${lines}</div>`;
    };
    const renderBranchChildren = (kids) => {
      if (!Array.isArray(kids) || !kids.length) return "";
      const children = kids.map((k) =>
        `<div class="flow-node flow-child"><span class="flow-label">${renderInline(k.text)}</span>${renderDetail(k.children)}</div>`
      ).join("");
      return `<div class="flow-fan" aria-hidden="false"><span class="flow-stem" aria-hidden="true"></span><div class="flow-children">${children}</div></div>`;
    };
    const renderNode = (n) => {
      const label = `<span class="flow-label">${renderInline(n.text)}</span>`;
      if (direction === "branch") {
        return `<div class="flow-item"><div class="flow-node">${label}</div>${renderBranchChildren(n.children)}</div>`;
      }
      return `<div class="flow-node">${label}${renderDetail(n.children)}</div>`;
    };
    // For branch we do not interleave inter-node connectors (the fan stems carry the direction);
    // for the linear/loop directions a connector sits between every pair of nodes.
    let inner;
    if (direction === "horizontal" && nodes.length > 4) {
      // SNAKE (2026-06-12): more than four steps never squash onto one wrapping row. Rows are
      // balanced (computeFlowRows), read boustrophedon — left->right, then right->left — and an
      // OBVIOUS elbow turn drops into each next row. DOM stays in logical order (row-reverse is
      // purely visual), so stepping and reading order are untouched. A flow never loops back —
      // {cycle} is the circular shape; this one runs start to terminal.
      const rowSizes = computeFlowRows(nodes.length);
      const parts = [];
      let cursor = 0;
      rowSizes.forEach((size, rowIndex) => {
        const rtl = rowIndex % 2 === 1;
        const row = nodes.slice(cursor, cursor + size).map(renderNode).join(connector);
        cursor += size;
        if (rowIndex > 0) parts.push(`<div class="flow-turn ${rtl ? "flow-turn-right" : "flow-turn-left"}" aria-hidden="true"></div>`);
        parts.push(`<div class="flow-snake-row${rtl ? " flow-row-rtl" : ""}">${row}</div>`);
      });
      return `<div class="flow flow-snake" data-flow="snake">${parts.join("")}</div>`;
    }
    if (direction === "branch") {
      inner = nodes.map(renderNode).join("");
    } else if (direction === "loop") {
      // loop: nodes + inter-node connectors live on ONE row (`.flow-cycle-row`, an even flex row),
      // and a loop-back connector closes the cycle (last → first) on its own line BELOW the row.
      // Keeping the return out of the node row is what lets the nodes share the width evenly (the
      // old flat layout put the `flex-basis:100%` return in the same row and starved the nodes).
      // The return is part of the FULL state — when stepping it appears once every node is revealed.
      const row = nodes.map(renderNode).join(connector);
      const ret = `<div class="flow-connector flow-return" aria-hidden="true"><span class="flow-arrow"></span></div>`;
      return `<div class="flow flow-loop" data-flow="loop"><div class="flow-cycle-row">${row}</div>${ret}</div>`;
    } else {
      inner = nodes.map(renderNode).join(connector);
    }
    return `<div class="flow flow-${direction}" data-flow="${direction}">${inner}</div>`;
  }
  if (block.type === "table") {
    // numericCols (layout batch 2): an all-numeric column right-aligns. Set only by the
    // {table} outline consumer; markdown pipe tables have no numericCols and render as before.
    const numClass = (i) => (Array.isArray(block.numericCols) && block.numericCols[i] ? ` class="num"` : "");
    return `<table class="slide-table"><thead><tr>${block.header.map((h, i) => `<th${numClass(i)}>${renderInline(h)}</th>`).join("")}</tr></thead><tbody>${block.rows.map((r) => `<tr>${r.map((c, i) => `<td${numClass(i)}>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  if (block.type === "code") {
    // A `trace` code block renders as a transcript of role-tagged turns: each turn is a labelled
    // row (the role colours the label and a left accent bar) with a monospace body. Trace turns
    // are the slide's content units, so reveal/focus stepping walks them (.trace .turn matches
    // MODE_SELECTOR). Any other lang renders as a single monospace code panel. Bodies escape HTML
    // and are never run through inline markup — code is shown literally.
    if (block.lang === "trace" && Array.isArray(block.turns) && block.turns.length) {
      const rows = block.turns.map((tn) => {
        // The parser already resolved the class: a well-known role's class, or an auto-assigned
        // `speaker-<bucket>` for an arbitrary speaker (stable per name). Trust it; fall back to a
        // bucket from the role string only if an old shape somehow lacks `cls`.
        const cls = tn.cls || (TRACE_ROLES[tn.role] ? TRACE_ROLES[tn.role].cls : autoSpeakerClass(tn.role || ""));
        const label = tn.label || (TRACE_ROLES[tn.role] ? TRACE_ROLES[tn.role].label : tn.role || "");
        return `<div class="turn"><div class="role ${escapeHtml(cls)}">${escapeHtml(label)}</div><div class="body">${escapeHtml(tn.body || "")}</div></div>`;
      }).join("");
      return `<div class="trace">${rows}</div>`;
    }
    // Build-time syntax highlighting (ADR-0014: deterministic + offline). highlightCode emits
    // self-contained token <span>s with escaped content; the embedded "Code syntax theme" in
    // the popup template colours them. Unknown langs degrade to plain escaped text (no spans),
    // matching the old monospace panel. No runtime highlighter, no CDN, no network — ever.
    const langClass = block.lang ? ` lang-${escapeHtml(slugify(block.lang))}` : "";
    const tag = block.lang ? `<span class="code-lang">${escapeHtml(block.lang)}</span>` : "";
    return `<pre class="slide-code${langClass}">${tag}<code>${highlightCode(block.text || "", block.lang)}</code></pre>`;
  }
  if (block.type === "contrast") {
    // Opt-in contrast vocabulary from the 2026-07-13 design round. Explicit variants win at
    // every pair count, and all preserve `.contrast-grid > .contrast-pair` plus first/last
    // span ordering for stepping and projection.
    if (["ledger", "rows", "tint", "flip"].includes(block.variant)) {
      const pair = ([l, r]) => block.variant === "rows"
        ? `<div class="contrast-pair"><span class="ct-old">${renderInline(l)}</span><span class="ct-arrow" aria-hidden="true">→</span><span class="ct-new">${renderInline(r)}</span></div>`
        : `<div class="contrast-pair"><span class="ct-old">${renderInline(l)}</span><span class="ct-new">${renderInline(r)}</span></div>`;
      return `<div class="contrast-grid contrast-${block.variant}">${block.pairs.map(pair).join("")}</div>`;
    }
    // Complex comparisons (2026-06-10): with 5+ pairs the pair-cards dissolve into noise — the
    // two SIDES lose their identity. Render as two opposing PANELS instead (light vs ink, the
    // old two-box diagram): the FIRST pair names the columns ("HARNESS · on your computer ·
    // does things / MODEL · in the cloud · thinks" — segments before the last "·" become the
    // eyebrow, the last segment the panel's big word), remaining pairs become row-aligned
    // capability lists. Few-pair contrasts keep the original pair-card grid.
    if (Array.isArray(block.pairs) && block.pairs.length >= 5) {
      const [head, ...rows] = block.pairs;
      const panelHead = (text) => {
        const segments = String(text).split("·").map((s) => s.trim()).filter(Boolean);
        const verb = segments.length > 1 ? segments[segments.length - 1] : String(text).trim();
        const eyebrow = segments.length > 1 ? segments.slice(0, -1).join(" · ") : "";
        return `${eyebrow ? `<p class="cpanel-eyebrow">${renderInline(eyebrow)}</p>` : ""}<p class="cpanel-verb">${renderInline(verb)}</p>`;
      };
      const list = (items) => `<ul class="cpanel-list">${items.map((t) => `<li>${renderInline(t)}</li>`).join("")}</ul>`;
      return `<div class="contrast-panels"><section class="cpanel cpanel-left">${panelHead(head[0])}${list(rows.map(([l]) => l))}</section><section class="cpanel cpanel-right">${panelHead(head[1])}${list(rows.map(([, r]) => r))}</section></div>`;
    }
    // Contrast redesign (layout batch 2, 2026-06-12): the DEFAULT few-pair device is now
    // OPPOSING ARROWS (the PPT relationship treatment) — left term in a right-pointing ink
    // arrow, right term in a left-pointing accent arrow, points meeting at centre. CSS
    // clip-path polygons, no images. The old serif-`/` pair-card grid stays as the opt-in
    // legacy device via {contrast=cards}. The `.contrast-grid > .contrast-pair` contract is
    // unchanged either way (MODE_SELECTOR stepping + tests survive).
    if (block.variant === "cards") {
      return `<div class="contrast-grid">${block.pairs.map(([l, r]) => `<div class="contrast-pair"><span>${renderInline(l)}</span><strong aria-hidden="true">/</strong><span>${renderInline(r)}</span></div>`).join("")}</div>`;
    }
    return `<div class="contrast-grid contrast-arrows">${block.pairs.map(([l, r]) => `<div class="contrast-pair"><span class="ct-arrow ct-left">${renderInline(l)}</span><span class="ct-arrow ct-right">${renderInline(r)}</span></div>`).join("")}</div>`;
  }
  if (block.type === "tiles") {
    // Grid / tiles. The column count is the author's explicit {blocks:RxC} cols if set, else the
    // BALANCED auto count (chooseBalancedColumns avoids a dangling orphan — 5→3, 6→3, 4→2, never the
    // old 4+1). justify-content:center (CSS) centres an incomplete final row, so 5 reads 3+2 centred
    // rather than 4+1 dangling. `--tile-cols` drives the per-tile flex basis.
    const items = (block.items || []).filter((t) => t != null && String(t).trim() !== "");
    const cols = block.dims ? block.dims.cols : chooseBalancedColumns(items.length);
    const tilesHtml = items.map((t) => `<div>${renderInline(t)}</div>`).join("");
    return `<div class="tile-grid tile-grid-${cols}" style="--tile-cols:${cols}">${tilesHtml}</div>`;
  }
  if (block.type === "system-map") {
    // A centre node with its satellites. The centre sits full-width on top; the satellites lay out
    // in a BALANCED grid below it (chooseBalancedColumns avoids a lonely orphan in the last row),
    // and the last row is CENTRED so the block reads symmetrically under the centre — the old
    // `repeat(3,1fr)` left a ragged, left-shifted final row. Satellite count drives the column
    // count via a `system-sats-<cols>` class the template keys off.
    const sats = (block.nodes || []).filter((n) => n != null && String(n).trim() !== "");
    const cols = chooseBalancedColumns(sats.length);
    // {multicolour} (opt-in) cycles each satellite + its connector rail through a varied palette
    // via a `--sat-i` index CSS picks the colour from; default leaves them on the single accent.
    const multi = block.multicolour ? " system-multicolour" : "";
    const satHtml = sats.map((n, i) =>
      `<div class="system-sat" style="--sat-i:${i}">${renderInline(n)}</div>`
    ).join("");
    // A centre node WIRED to every satellite (the old version drew no connectors). A `.system-links`
    // SVG overlay is sized + populated at layout time (runtime drawSystemLinks: a line from the
    // centre's bottom edge to each satellite's top edge), so the lines follow the real flex
    // positions for ANY row count and re-draw on resize/print. The overlay sits behind the boxes.
    return `<div class="system-map${multi}"><svg class="system-links" aria-hidden="true" preserveAspectRatio="none"></svg>`
      + `<div class="system-centre">${renderInline(block.centre || "result")}</div>`
      + `<div class="system-sats system-sats-${cols}" style="--sat-cols:${cols}">${satHtml}</div></div>`;
  }
  if (block.type === "conceptmap") {
    // A labelled node-edge graph from `A -label- B` relations. Nodes are placed on a circle
    // (deterministic radial layout — no physics, so the SVG is stable build-to-build); edges are
    // straight accent lines with the relation label set on the midpoint; nodes are rounded
    // rects sized to their text. Rendered as inline SVG so it scales with the slide and needs no
    // runtime. A single node (one concept, no parsed relation) still draws its box.
    const nodes = Array.isArray(block.nodes) ? block.nodes : [];
    const edges = Array.isArray(block.edges) ? block.edges : [];
    if (!nodes.length) return "";
    const W = 1000, H = 560;
    const cx = W / 2, cy = H / 2;
    const rx = W * 0.36, ry = H * 0.34;
    // Node box geometry from its text length (monospace-ish estimate); clamp so long labels wrap
    // visually via a max width. Positions: a single node centres; otherwise spread on the ellipse,
    // starting at the top and going clockwise.
    const pos = nodes.map((_, i) => {
      if (nodes.length === 1) return { x: cx, y: cy };
      const a = -Math.PI / 2 + (2 * Math.PI * i) / nodes.length;
      return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
    });
    const boxFor = (text) => {
      const w = Math.max(96, Math.min(240, 26 + text.length * 10.5));
      return { w, h: 46 };
    };
    const boxes = nodes.map((t) => boxFor(t));
    // Two edges between the SAME node pair share a midpoint — their labels overprinted
    // (ADR-0005 sweep finding). Offset each additional label on a shared segment
    // perpendicular to the edge so every relation stays legible.
    const midCounts = new Map();
    const edgeSvg = edges.map((e) => {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) return null;
      const pairKey = [Math.min(e.from, e.to), Math.max(e.from, e.to)].join("-");
      const nth = midCounts.get(pairKey) || 0;
      midCounts.set(pairKey, nth + 1);
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const off = nth === 0 ? 0 : (Math.ceil(nth / 2) * 30) * (nth % 2 ? 1 : -1);
      const mx = (a.x + b.x) / 2 + (-dy / len) * off, my = (a.y + b.y) / 2 + (dx / len) * off;
      const labelW = Math.max(40, e.label.length * 8 + 14);
      // Lines and labels render in SEPARATE passes so no later line ever strikes through an
      // earlier label (all lines underneath, all labels on top).
      return {
        line: `<line class="cm-edge" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" />`,
        label: `<g class="cm-edge"><rect class="cm-edge-label-bg" x="${(mx - labelW / 2).toFixed(1)}" y="${(my - 13).toFixed(1)}" width="${labelW.toFixed(1)}" height="22" rx="5" />`
          + `<text class="cm-edge-label" x="${mx.toFixed(1)}" y="${(my + 3).toFixed(1)}" text-anchor="middle">${escapeHtml(e.label)}</text></g>`
      };
    }).filter(Boolean);
    const edgeLines = edgeSvg.map((e) => e.line).join("");
    const edgeLabels = edgeSvg.map((e) => e.label).join("");
    const nodeSvg = nodes.map((t, i) => {
      const p = pos[i], box = boxes[i];
      return `<g class="cm-node"><rect x="${(p.x - box.w / 2).toFixed(1)}" y="${(p.y - box.h / 2).toFixed(1)}" width="${box.w}" height="${box.h}" rx="0" />`
        + `<text x="${p.x.toFixed(1)}" y="${(p.y + 5).toFixed(1)}" text-anchor="middle">${escapeHtml(t)}</text></g>`;
    }).join("");
    return `<div class="conceptmap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Concept map: ${escapeHtml(nodes.join(", "))}" preserveAspectRatio="xMidYMid meet">${edgeLines}${nodeSvg}${edgeLabels}</svg></div>`;
  }
  if (block.type === "smartart") {
    // PowerPoint-style hierarchical node grid (`.smartart-grid`/`.smartart-node` CSS in the
    // template). A node renders its label, then its children as ordered steps; a child that
    // itself has children nests a further `.smartart-node`. Depth-0 labels are `<h2>`; deeper
    // labels are `<p class="smartart-text">`. Empty nodes are dropped. The `count-N` class lets
    // CSS tune column behaviour for small node counts. Mirrors the v5 PPTX SmartArt renderer.
    const renderNode = (node, level = 0) => {
      const kids = (node.children || []).filter((c) => c && (c.text || (c.children || []).length));
      const label = node.text
        ? level === 0
          ? `<h2>${renderInline(node.text)}</h2>`
          : `<p class="smartart-text">${renderInline(node.text)}</p>`
        : "";
      const steps = kids.length
        ? `<ol>${kids.map((c) => `<li>${renderNode(c, level + 1)}</li>`).join("")}</ol>`
        : "";
      return `<div class="smartart-node">${label}${steps}</div>`;
    };
    const nodes = (block.nodes || []).filter((n) => n && (n.text || (n.children || []).length));
    if (!nodes.length) return "";
    return `<div class="smartart-grid count-${nodes.length}">${nodes.map((n) => renderNode(n)).join("")}</div>`;
  }
  if (block.type === "pyramid") {
    // Stacked tiers. CONVENTION: first list item = the APEX (narrowest, on top); the last item =
    // the BASE (widest, at the bottom) — the classic wide-base pyramid, read top-to-bottom in the
    // order written. Each tier widens linearly toward the base. A tier's nested children render as
    // a small caption beneath its label (kept terse — the tier band is the unit). Only depth-0
    // items form tiers; nesting beyond one level is flattened into the caption.
    const tiers = (block.nodes || []).filter((n) => n && n.text);
    if (!tiers.length) return "";
    const n = tiers.length;
    const rows = tiers.map((t, i) => {
      // Width grows from the apex (i=0) to the base (i=n-1). Floor keeps the apex readable.
      const pct = Math.round((40 + (60 * i) / Math.max(1, n - 1)));
      const cap = (t.children || []).filter((c) => c && c.text).map((c) => renderInline(c.text)).join(" · ");
      const capHtml = cap ? `<span class="pyr-cap">${cap}</span>` : "";
      return `<div class="pyr-tier" style="width:${pct}%"><span class="pyr-label">${renderInline(t.text)}</span>${capHtml}</div>`;
    }).join("");
    return `<div class="pyramid">${rows}</div>`;
  }
  if (block.type === "orgchart") {
    // A top node with a child tree. The first depth-0 item is the ROOT; its children are the next
    // tier, each of which may carry its own children (the nested list IS the hierarchy). If there
    // are several depth-0 items they are treated as co-equal roots under an implicit frame (each
    // its own little tree side by side). Rendered as nested .org-node boxes joined by CSS rails.
    const roots = (block.nodes || []).filter((n) => n && (n.text || (n.children || []).length));
    if (!roots.length) return "";
    const renderOrg = (node) => {
      const kids = (node.children || []).filter((c) => c && (c.text || (c.children || []).length));
      const label = `<div class="org-box">${renderInline(node.text || "")}</div>`;
      const children = kids.length
        ? `<div class="org-children">${kids.map((c) => `<div class="org-node">${renderOrg(c)}</div>`).join("")}</div>`
        : "";
      return `${label}${children}`;
    };
    const treeHtml = roots.length === 1
      ? `<div class="org-node org-root">${renderOrg(roots[0])}</div>`
      : `<div class="org-node org-root org-multi">${roots.map((r) => `<div class="org-node">${renderOrg(r)}</div>`).join("")}</div>`;
    return `<div class="orgchart">${treeHtml}</div>`;
  }
  if (block.type === "mindmap") {
    // ADR-0005: mindmaps are rendered by markmap (auto radial layout from the markdown sub-tree),
    // never hand-positioned. We emit ONLY a host div carrying the slide's nested list as markdown in
    // `data-mm-outline`; the presenter/share runtimes lazily build a markmap SVG into it on the
    // slide's first activation (see `initMarkmaps`). CONVENTION (unchanged from the old grid): the
    // first depth-0 item is the CENTRE (root idea); its children are the branches — unless the first
    // item has no children, in which case the remaining depth-0 items become its branches.
    const all = (block.nodes || []).filter((n) => n && (n.text || (n.children || []).length));
    if (!all.length) return "";
    const root = all[0];
    let branches = (root.children || []).filter((c) => c && (c.text || (c.children || []).length));
    if (!branches.length && all.length > 1) branches = all.slice(1);
    // Build markmap markdown from the node model: root = `#`, each branch = `##`, everything beneath
    // a branch = nested `-` bullets (markmap nests deeper lists cleanly, so we recurse rather than
    // flatten). Node text stays raw markdown (markmap renders inline **bold**/`code`); we only
    // collapse internal whitespace so each node is one line and the outline parses predictably.
    const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    const lines = [];
    lines.push(`# ${clean(root.text)}`);
    const emitLeaves = (nodes, depth) => {
      nodes.forEach((n) => {
        if (!n || !n.text) return;
        lines.push(`${"  ".repeat(depth)}- ${clean(n.text)}`);
        const kids = (n.children || []).filter((c) => c && (c.text || (c.children || []).length));
        if (kids.length) emitLeaves(kids, depth + 1);
      });
    };
    branches.forEach((br) => {
      lines.push(`## ${clean(br.text)}`);
      emitLeaves((br.children || []).filter((c) => c && (c.text || (c.children || []).length)), 0);
    });
    const outline = lines.join("\n");
    return `<div class="mindmap-mm" data-mm-outline="${escapeHtml(outline)}" role="img" aria-label="Mind map: ${escapeHtml(clean(root.text))}"></div>`;
  }
  // ── PPT-replication batch (2026-06-11) — stats / process / steps / iconrow / image-quote /
  // image-grid. All static build-time HTML+CSS: no runtime drawing, so no share-parity hooks. ──
  if (block.type === "title-poster") {
    // ADR-0005 locked title designs (docs/design/2026-07-07-slide-designs/title-variations.html).
    const d = block.data || {};
    const meta1 = [d.series, d.event].filter(Boolean).join(" \u00b7 ");
    const bottomRight = [d.web, d.date].filter(Boolean).join(" \u00b7 ");
    const speaker = [d.author && `<b>${renderInline(String(d.author))}</b>`, d.affiliation && renderInline(String(d.affiliation))].filter(Boolean).join(" \u00b7 ");
    const sub = d.subtitle ? `<p class="tp-sub">${renderInline(String(d.subtitle))}</p>` : "";
    if (block.variant === "closing") {
      return `<div class="tp tp-poster tp-closing">${meta1 ? `<div class="tp-top"><span class="tp-mono">${escapeHtml(meta1)}</span></div>` : ""}<div class="tp-mid"><h2 class="tp-title">${renderInline(String(d.title || ""))}</h2>${d.subtitle ? `<p class="tp-cta">${renderInline(String(d.subtitle))}</p>` : ""}</div><div class="tp-bottom"><span>${speaker}</span><span class="tp-soft">${escapeHtml(bottomRight)}</span></div></div>`;
    }
    if (block.variant === "banner") {
      return `<div class="tp tp-banner"><div class="tp-main"><div class="tp-inner">${meta1 ? `<div class="tp-series">${escapeHtml(meta1)}</div>` : ""}<h2 class="tp-title">${renderInline(String(d.title || ""))}</h2>${sub}</div></div><div class="tp-band"><span>${speaker}</span><span class="tp-mono">${escapeHtml(bottomRight)}</span></div></div>`;
    }
    if (block.variant === "split") {
      return `<div class="tp tp-split"><div class="tp-side">${d.series ? `<div class="tp-series">${escapeHtml(String(d.series))}</div>` : ""}<div class="tp-event">${[d.event, d.date].filter(Boolean).map((x) => escapeHtml(String(x))).join("<br>")}</div></div><div class="tp-main-col"><h2 class="tp-title">${renderInline(String(d.title || ""))}</h2>${sub}<p class="tp-author">${speaker}${d.web ? ` \u00b7 <span class="tp-web">${escapeHtml(String(d.web))}</span>` : ""}</p></div></div>`;
    }
    return `<div class="tp tp-poster">${meta1 ? `<div class="tp-top"><span class="tp-mono">${escapeHtml(meta1)}</span></div>` : ""}<div class="tp-mid"><h2 class="tp-title">${renderInline(String(d.title || ""))}</h2>${sub}</div><div class="tp-bottom"><span>${speaker}</span><span class="tp-soft">${escapeHtml(bottomRight)}</span></div></div>`;
  }
  if (block.type === "stats") {
    // Big-number row. Each cell: huge accent value, label beneath, optional small caption from
    // the item's first nested children. A value-less cell (no digit, no ` · `) renders label-only.
    const cells = (block.cells || []).filter((c) => c && (c.value || c.label));
    if (!cells.length) return "";
    const cellHtml = cells.map((c) => {
      const value = c.value ? `<span class="stat-value">${renderInline(c.value)}</span>` : "";
      const cap = c.cap ? `<span class="stat-cap">${renderInline(c.cap)}</span>` : "";
      return `<div class="stat">${value}<span class="stat-label">${renderInline(c.label)}</span>${cap}</div>`;
    }).join("");
    return `<div class="stats-row stats-${cells.length}">${cellHtml}</div>`;
  }
  // ── Layout batch 2 (2026-06-12) — chart / cycle / equation. All build-time HTML/SVG:
  // positions and sizes computed here (deterministic, ADR-0014 clean), no runtime drawing,
  // no share-parity hooks. Bar columns and cycle nodes are steppable units (MODE_SELECTOR);
  // pie and line are one composition each in v1; equation reads as one statement.
  if (block.type === "chart") {
    const shape = block.shape === "pie" || block.shape === "line" ? block.shape : "bar";
    const pts = (block.points || []).filter((p) => p && Number.isFinite(p.value));
    if (!pts.length) return "";
    if (shape === "bar") {
      // Vertical columns, bottom-aligned (the {steps} grammar): height % of max computed at
      // build time; authored value text above the column, label beneath.
      const max = Math.max(...pts.map((p) => Math.abs(p.value))) || 1;
      const cols = pts.map((p) => {
        const h = Math.max(3, Math.round((Math.abs(p.value) / max) * 100));
        return `<div class="chart-col"><div class="chart-col-plot"><span class="chart-val">${renderInline(p.valueText)}</span><div class="chart-bar" style="height:${h}%"></div></div><span class="chart-label">${renderInline(p.label || "")}</span></div>`;
      }).join("");
      return `<div class="chart-cols count-${pts.length}">${cols}</div>`;
    }
    const COLOURS = ["#0b3a6b", "#9f1239", "#166534", "#c08a1d", "#7c3aed", "#be185d"];
    if (shape === "pie") {
      // Build-time SVG arcs from percentage shares + a legend column (label · value · %).
      const total = pts.reduce((sum, p) => sum + Math.abs(p.value), 0) || 1;
      const cx = 200, cy = 200, r = 184;
      let angle = -90;
      const slices = pts.map((p, i) => {
        const share = Math.abs(p.value) / total;
        if (share >= 0.9999) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLOURS[i % COLOURS.length]}"/>`;
        const a0 = angle;
        const a1 = angle + share * 360;
        angle = a1;
        const pt = (a) => `${(cx + r * Math.cos((a * Math.PI) / 180)).toFixed(2)} ${(cy + r * Math.sin((a * Math.PI) / 180)).toFixed(2)}`;
        return `<path d="M ${cx} ${cy} L ${pt(a0)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(a1)} Z" fill="${COLOURS[i % COLOURS.length]}"/>`;
      }).join("");
      const legend = pts.map((p, i) => {
        const pc = Math.round((Math.abs(p.value) / total) * 100);
        return `<li><span class="chart-swatch" style="background:${COLOURS[i % COLOURS.length]}"></span><span class="chart-leg-label">${renderInline(p.label || "")}</span><span class="chart-leg-val">${renderInline(p.valueText)} · ${pc}%</span></li>`;
      }).join("");
      return `<div class="chart-pie"><svg viewBox="0 0 400 400" role="img" aria-label="Pie chart">${slices}</svg><ul class="chart-legend">${legend}</ul></div>`;
    }
    // line: build-time SVG polyline + dots, x labels beneath, y scaled to max, baseline rule.
    const max = Math.max(...pts.map((p) => p.value), 0) || 1;
    const min = Math.min(...pts.map((p) => p.value), 0);
    const span = max - min || 1;
    const X0 = 60, X1 = 940, Y0 = 60, Y1 = 360;
    const x = (i) => (pts.length === 1 ? (X0 + X1) / 2 : X0 + (i * (X1 - X0)) / (pts.length - 1));
    const y = (v) => Y1 - ((v - min) / span) * (Y1 - Y0);
    const linePts = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    const dots = pts.map((p, i) => `<circle class="chart-dot" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="9"/><text class="chart-val-svg" x="${x(i).toFixed(1)}" y="${(y(p.value) - 22).toFixed(1)}" text-anchor="middle">${escapeHtml(p.valueText)}</text>`).join("");
    const labels = pts.map((p, i) => `<text class="chart-label-svg" x="${x(i).toFixed(1)}" y="404" text-anchor="middle">${escapeHtml(p.label || "")}</text>`).join("");
    return `<div class="chart-line"><svg viewBox="0 0 1000 430" role="img" aria-label="Line chart"><line class="chart-baseline" x1="${X0}" y1="${Y1}" x2="${X1}" y2="${Y1}"/><polyline class="chart-poly" points="${linePts}"/>${dots}${labels}</svg></div>`;
  }
  if (block.type === "sigmoid") {
    // {sigmoid} / {curve=sigmoid} (2026-06-13): a conceptual S-curve (NOT a data plot). Items are
    // PLACED on the curve at a named stage or a 0–100 percent; the curve shape is fixed. Build-time
    // SVG, deterministic. One composition in v1 (points are not individually stepped).
    const pts = (block.points || []).filter((p) => p && Number.isFinite(p.x));
    if (!pts.length) return "";
    const VB_W = 1000, VB_H = 480;
    const X0 = 70, X1 = 930, Y0 = 70, Y1 = 380; // plot box; label band below Y1
    const K = 11; // steepness; s(0)/s(1) are normalised out so the curve spans the full box
    const raw = (t) => 1 / (1 + Math.exp(-K * (t - 0.5)));
    const s0 = raw(0), s1 = raw(1);
    const sig = (t) => (raw(t) - s0) / (s1 - s0); // normalised 0..1
    const sx = (t) => X0 + t * (X1 - X0);
    const sy = (t) => Y1 - sig(t) * (Y1 - Y0);
    // Curve path: sample the normalised sigmoid across the box.
    const SAMPLES = 60;
    const path = Array.from({ length: SAMPLES + 1 }, (_, i) => {
      const t = i / SAMPLES;
      return `${i === 0 ? "M" : "L"} ${sx(t).toFixed(1)} ${sy(t).toFixed(1)}`;
    }).join(" ");
    const baseline = `<line class="sigmoid-axis" x1="${X0}" y1="${Y1}" x2="${X1}" y2="${Y1}"/>`;
    // Labels alternate above/below their dot so neighbouring labels do not collide.
    const marks = pts.map((p, i) => {
      const cx = sx(p.x), cy = sy(p.x);
      const above = i % 2 === 0;
      const ly = above ? cy - 20 : cy + 30;
      return `<g class="sigmoid-point"><line class="sigmoid-stem" x1="${cx.toFixed(1)}" y1="${Y1}" x2="${cx.toFixed(1)}" y2="${cy.toFixed(1)}"/>`
        + `<circle class="sigmoid-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="10"/>`
        + `<text class="sigmoid-label" x="${cx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${escapeHtml(p.label || "")}</text></g>`;
    }).join("");
    return `<div class="sigmoid-curve"><svg viewBox="0 0 ${VB_W} ${VB_H}" role="img" aria-label="S-curve">${baseline}<path class="sigmoid-path" d="${path}"/>${marks}</svg></div>`;
  }
  if (block.type === "timetable") {
    // Day schedule table: time column + event. Break rows get .timetable-break. The schedule
    // (timed rows → minutes + label) rides data-tt-schedule so the runtime can arm a presenter
    // reminder at each wall-clock time. Rows are steppable units (.timetable tbody tr).
    const rows = (block.rows || []);
    if (!rows.length) return "";
    const body = rows.map((r) => {
      const cls = r.isBreak ? ' class="timetable-break"' : "";
      const timeCell = `<td class="tt-time">${renderInline(r.time || "")}</td>`;
      const eventCell = `<td class="tt-event">${renderInline(r.event || "")}</td>`;
      return `<tr${cls}>${timeCell}${eventCell}</tr>`;
    }).join("");
    const schedule = rows
      .filter((r) => Number.isFinite(r.minutes))
      .map((r) => ({ m: r.minutes, label: `${r.time} · ${r.event}` }));
    const schedAttr = schedule.length ? ` data-tt-schedule='${JSON.stringify(schedule).replace(/'/g, "&#39;")}'` : "";
    return `<table class="timetable"${schedAttr}><tbody>${body}</tbody></table>`;
  }
  if (block.type === "cycle") {
    // Circular arrow flow: node cards absolutely positioned on an ellipse with BUILD-TIME %
    // coordinates. Arcs interleave with nodes in DOM order (SD-13): node0, arcSvg0, node1,
    // arcSvg1, ..., nodeN-1, arcSvgN-1. Each arc is its own positioned SVG so MODE_SELECTOR
    // can step nodes and arcs as separate beats (node reveals first, its outgoing arc second).
    const nodes = (block.nodes || []).filter((n) => n && n.text);
    if (!nodes.length) return "";
    const n = nodes.length;
    const RX = 380, RY = 230, CX = 500, CY = 310;
    // Angular clearance around each node: enough that arcs never touch the cards, small
    // enough that the arrows still read as a connected ring (stubby arcs look detached).
    const gapDeg = Math.min(26, 8 + 56 / n);
    const arcPath = (i) => {
      const a0 = -90 + (360 / n) * i + gapDeg;
      const a1 = -90 + (360 / n) * (i + 1) - gapDeg;
      const pt = (a) => `${(CX + RX * Math.cos((a * Math.PI) / 180)).toFixed(1)} ${(CY + RY * Math.sin((a * Math.PI) / 180)).toFixed(1)}`;
      return `M ${pt(a0)} A ${RX} ${RY} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(a1)}`;
    };
    const DEFS = `<defs><marker id="cycleArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>`;
    const arcSvg = (i) => `<svg class="cycle-arc-svg" viewBox="0 0 1000 620" aria-hidden="true">${DEFS}<path class="cycle-arc" d="${arcPath(i)}" marker-end="url(#cycleArrow)"/></svg>`;
    const interleavedHtml = nodes.map((node, i) => {
      const ang = (-90 + (360 / n) * i) * (Math.PI / 180);
      const left = (50 + 38 * Math.cos(ang)).toFixed(2);
      const top = (50 + 37 * Math.sin(ang)).toFixed(2);
      const cap = node.cap ? `<span class="cycle-cap">${renderInline(node.cap)}</span>` : "";
      const stage = String(node.text).replace(/:\s*$/, "");
      const nodeDiv = `<div class="cycle-node" style="left:${left}%;top:${top}%"><span class="cycle-stage">${renderInline(stage)}</span>${cap}</div>`;
      return nodeDiv + arcSvg(i);
    }).join("");
    return `<div class="cycle-diagram">${interleavedHtml}</div>`;
  }
  if (block.type === "equation") {
    // Converging relationship: operand discs joined by accent + glyphs, an arrow into a
    // solid-accent result disc. One composition (not stepped) — it reads as one statement.
    const operands = block.operands || [];
    const terms = operands.map((o, i) => {
      const op = i < operands.length - 1
        ? `<span class="eq-op" aria-hidden="true">+</span>`
        : `<span class="eq-op eq-arrow" aria-hidden="true">→</span>`;
      return `<span class="eq-unit"><span class="eq-term">${renderInline(o)}</span>${op}</span>`;
    }).join("");
    const shape = ["pills", "circle", "square", "oval"].includes(block.shape) ? block.shape : "pills";
    return `<div class="equation-row equation-${shape}">${terms}<span class="eq-term eq-result">${renderInline(block.result || "")}</span></div>`;
  }
  if (block.type === "process") {
    // Numbered-circle agenda strip: accent discs on a connector line, label below, an optional
    // `· time` tail on the item as a small accent sub-label, nested children as quiet detail
    // lines. The classic "Plan for the day" PPT shape.
    const nodes = (block.nodes || []).filter((n) => n && n.text);
    if (!nodes.length) return "";
    const stepHtml = nodes.map((n, i) => {
      const t = String(n.text).trim();
      // `· time` tail — any space-surrounded dash works too (last occurrence wins).
      const procSeps = [...t.matchAll(/\s[·—–-]\s/g)];
      const sepMatch = procSeps.length ? procSeps[procSeps.length - 1] : null;
      const label = sepMatch ? t.slice(0, sepMatch.index).trim() : t;
      const time = sepMatch ? `<span class="proc-time">${renderInline(t.slice(sepMatch.index + sepMatch[0].length).trim())}</span>` : "";
      const kids = (n.children || []).filter((c) => c && c.text);
      const details = kids.length
        ? `<ul class="proc-details">${kids.map((c) => `<li>${renderInline(c.text)}</li>`).join("")}</ul>`
        : "";
      return `<div class="proc-step"><span class="proc-num">${i + 1}</span><span class="proc-label">${renderInline(label)}</span>${time}${details}</div>`;
    }).join("");
    return `<div class="process-strip count-${nodes.length}">${stepHtml}</div>`;
  }
  if (block.type === "steps") {
    // Ascending stairs: bottom-aligned columns rising left→right (first item = lowest step,
    // last = highest, accent-filled — the tint ramp mirrors the pyramid's nth-last-child scheme).
    // Heights are computed at build time so the CSS stays custom-property-free.
    const nodes = (block.nodes || []).filter((n) => n && n.text);
    if (!nodes.length) return "";
    const n = nodes.length;
    const colHtml = nodes.map((node, i) => {
      const pct = n === 1 ? 100 : Math.round(34 + (66 * i) / (n - 1));
      const cap = (node.children || []).filter((c) => c && c.text).map((c) => renderInline(c.text)).join(" · ");
      const capHtml = cap ? `<span class="step-cap">${cap}</span>` : "";
      return `<div class="step-col" style="height:${pct}%"><span class="step-label">${renderInline(node.text)}</span>${capHtml}</div>`;
    }).join("");
    return `<div class="steps-diagram count-${n}">${colHtml}</div>`;
  }
  if (block.type === "iconrow") {
    // Horizontal icon + label + description row. Icons are ALWAYS on for this layout (that is
    // its point); they resolve through the same pipeline as {iconlist} — per-item {icon=…}
    // overrides and the deck `icons:` map win over the algorithmic vocabulary pick.
    const nodes = (block.nodes || []).filter((n) => n && n.text);
    if (!nodes.length) return "";
    const items = nodes.map((n) => n.text);
    const overrides = resolveIconOverrides(items, block.iconOverrides, deckUsed && deckUsed.iconMap);
    // The icon decider NEVER half-icons a list (any unresolvable slot → icons:null). An iconrow
    // without icons falls back to NUMBERED DISCS so the row keeps its anchor device — same
    // icon-or-number contract feature-lists follow, never a blank slot.
    const { icons } = decideFeatureListStyle(items, false, deckUsed, "icons", overrides);
    const itemHtml = nodes.map((n, i) => {
      const kids = (n.children || []).filter((c) => c && c.text);
      const desc = kids.length
        ? `<ul class="ir-desc">${kids.map((c) => `<li>${renderInline(c.text)}</li>`).join("")}</ul>`
        : "";
      const anchor = icons
        ? `<span class="ir-icon">${iconSvg(icons[i])}</span>`
        : `<span class="ir-icon ir-num">${i + 1}</span>`;
      return `<div class="ir-item">${anchor}<span class="ir-label">${renderInline(n.text)}</span>${desc}</div>`;
    }).join("");
    return `<div class="icon-row count-${nodes.length}">${itemHtml}</div>`;
  }
  if (block.type === "image-quote") {
    // Quote beside image with the attribution as a full-width accent bar below — the classic
    // PPT person-photo/tweet + quotation slide. The cite moves OUT of the blockquote into the
    // bar (a plain {quote}+figure keeps the existing quiet-cite treatment; this is the variant).
    const img = block.image;
    const q = block.quote || {};
    const paras = Array.isArray(q.paragraphs) && q.paragraphs.length ? q.paragraphs : [q.text ?? ""];
    const fullText = paras.join(" ");
    const bucket = fullText.length <= 220 ? "short" : fullText.length <= 600 ? "medium" : "long";
    const body = paras.map((p) => `<p>${renderInline(p)}</p>`).join("");
    const cap = img && img.caption ? `<figcaption>${renderInline(img.caption)}</figcaption>` : "";
    const contain = img && img.width && img.height && img.width / img.height > 4 / 3 ? " iq-contain" : "";
    const figure = img ? `<figure class="iq-figure${contain}"><img src="${escapeHtml(img.src)}"${imageSizeAttrs(img)} alt="${escapeHtml(img.alt || "")}">${cap}</figure>` : "";
    const citeBar = q.cite ? `<p class="iq-cite">${renderInline(q.cite)}</p>` : "";
    return `<div class="image-quote">${figure}<blockquote data-quote-length="${bucket}">${body}</blockquote>${citeBar}</div>`;
  }
  if (block.type === "image-grid") {
    // Annotated image grid: a STATIC grid of figure cells — image on top, note card (title +
    // text) beneath — all visible at once. Balanced columns like tiles/system-map; the cells
    // are the reveal units in step mode. Images render plain (no .slide-figure) so the grid
    // owns their sizing and stepping.
    const MEDIA = new Set(["image", "embed", "video"]);
    const cells = (block.cells || []).filter((c) => c && Array.isArray(c.blocks) && c.blocks.length);
    if (!cells.length) return "";
    const cols = block.dims ? block.dims.cols : chooseBalancedColumns(cells.length);
    const cellHtml = cells.map((cell) => {
      const media = cell.blocks.filter((b) => b && b.type === "image");
      const text = cell.blocks.filter((b) => b && !MEDIA.has(b.type));
      const mediaHtml = media.map((b) =>
        `<img src="${escapeHtml(b.src)}"${imageSizeAttrs(b)} alt="${escapeHtml(b.alt || "")}">`
      ).join("");
      const head = cell.title ? `<h4>${renderInline(cell.title)}</h4>` : "";
      const textHtml = text.map((b) => renderBlock(b, deckUsed, frameIcons)).filter(Boolean).join("\n");
      const note = (head || textHtml) ? `<div class="ig-note">${head}${textHtml}</div>` : "";
      return `<figure class="ig-cell">${mediaHtml ? `<div class="ig-media">${mediaHtml}</div>` : ""}${note}</figure>`;
    }).join("");
    return `<div class="image-grid" style="--ig-cols:${cols}">${cellHtml}</div>`;
  }
  // A run of one or more action buttons → a .slide-actions row of accent buttons. A lone
  // `action` block (not grouped upstream) still renders as a single-button row.
  if (block.type === "actions" && Array.isArray(block.actions)) {
    return renderActionRow(block.actions);
  }
  if (block.type === "action") {
    return renderActionRow([block]);
  }
  if (block.type === "image-claim") {
    return `<div class="evidence-layout">${renderBlock(block.image, deckUsed, frameIcons)}<ul class="callouts">${(block.callouts ?? []).map((c) => `<li>${renderInline(c)}</li>`).join("")}</ul></div>`;
  }
  if (block.type === "cta-screenshots") {
    // .cta-layout: a screenshots strip (left, ~1.45fr) beside a right column holding the
    // callout list (v3 `.callouts` style — same as image-claim) and, below it, any action
    // buttons. Each screenshot is a .cta-shot figure (image + optional caption). With 0/1
    // images the strip simply holds what it has; the grid stays robust.
    const shots = (block.images ?? []).map((img) => {
      const cap = img.caption ? `<figcaption>${renderInline(img.caption)}</figcaption>` : "";
      return `<figure class="cta-shot"><img src="${escapeHtml(img.src)}"${imageSizeAttrs(img)} alt="${escapeHtml(img.alt || "")}">${cap}</figure>`;
    }).join("");
    const callouts = (block.callouts ?? []).length
      ? `<ul class="callouts cta-callouts">${block.callouts.map((c) => `<li>${renderInline(c)}</li>`).join("")}</ul>`
      : "";
    const actions = (block.actions ?? []).length ? renderActionRow(block.actions) : "";
    return `<div class="cta-layout"><div class="cta-images">${shots}</div><div class="cta-aside">${callouts}${actions}</div></div>`;
  }
  if (block.type === "compare") {
    // {compare} (ADR-0005 "50/50 comparison"): two halves filling the stage. Half A sits on the
    // section tint, half B on paper; each carries a small-caps mono label + vertically-centred
    // content. The slide's own title is nav-only (assembly emits the quiet head). Half B is one
    // reveal beat — the runtime steps it via MODE_SELECTOR (.layout-compare .compare-half.half-b).
    const sideClass = ["half-a", "half-b"];
    const halves = (block.halves ?? []).slice(0, 2).map((half, i) => {
      const label = half.label ? `<div class="compare-label">${renderInline(half.label)}</div>` : "";
      const body = (half.blocks ?? []).map((b) => renderBlock(b, deckUsed, frameIcons)).filter(Boolean).join("\n");
      return `<div class="compare-half ${sideClass[i]}"><div class="compare-inner">${label}${body}</div></div>`;
    }).join("");
    return `<div class="compare-grid">${halves}</div>`;
  }
  if (block.type === "cards" && block.staticCompare) {
    // {contrast} + #### groups: a static comparison — all columns visible at once, no title
    // card, no fragments, no exclusive stepping. The slide's own header stays in place.
    const compareCards = block.cards.map((card) => {
      const blocks = Array.isArray(card.blocks) ? card.blocks : [];
      const headHtml = card.title ? `<h4>${renderInline(card.title)}</h4>` : "";
      const body = blocks.map((b) => renderBlock(b, deckUsed, frameIcons)).filter(Boolean).join("\n");
      return `<article class="card">${headHtml}${body}</article>`;
    }).join("");
    return `<div class="contrast-cards" style="--compare-cols:${block.cards.length}">${compareCards}</div>`;
  }
  if (block.type === "cards") {
    // Cards render as a STATIC GRID (all cards visible at once) by default; one-at-a-time stepping
    // is opt-in via {cards=stepped} (ADR-0021 design call). Stepped mode opens with an auto title
    // card (index 0, shown on arrival) and the content cards become reveal fragments; static mode
    // shows the slide title as a header above the grid and has no title card / no fragments.
    const stepped = !!block.stepped;
    const titleCard = stepped && block.title
      ? `<article class="card card-title"><div class="card-title-inner">${block.kicker ? `<p class="card-title-kicker">${escapeHtml(block.kicker)}</p>` : ""}<h2 class="card-title-h">${renderInline(block.title)}</h2></div></article>`
      : "";
    const offset = titleCard ? 1 : 0;
    // D7: a card carrying BOTH media (image/embed/video) and text (quote/paragraph/list) lays
    // them out side-by-side inside the card — media one column, text the other — instead of
    // stacking (which clips). Detected per card; the media + text each get their own column
    // wrapper so the CSS .card-media-split grid can place them. Media-only or text-only cards
    // are unaffected and render their blocks in the normal flow.
    const CARD_MEDIA_TYPES = new Set(["image", "embed", "video"]);
    // G2: any text content beside media triggers the in-card split — including a
    // feature-list (the jagged-frontier card is a 1-item list + tweet image that
    // previously stacked) and the static feature-lists produced inside gallery cards.
    const CARD_TEXT_TYPES = new Set(["quote", "paragraph", "list", "feature-list", "timeline", "table"]);
    // G2/G4: a card's NON-QUOTE text is Dominik's own comment, not a quotation. A quote gets
    // the decorative quotation-mark device (blockquote); a comment gets the "speaker statement"
    // accent-bar callout (.card-comment) — no quote mark — so the two read as different things.
    // Wraps the bare <p> a paragraph block renders into a .card-comment block; quote/list/etc.
    // pass through renderBlock unchanged.
    const renderCardBlock = (b) => {
      // Mockup .lblgrp (roles-h/roles-v): a card list whose EVERY item reads "Label: value"
      // renders as label groups — mono accent label over ink value, hairline-separated.
      const LBL = /^([^:]{2,28}):\s+(.+)$/;
      if (b && Array.isArray(b.items) && b.items.length && b.items.every((t) => LBL.test(String(t)))) {
        return b.items.map((t) => {
          const m = LBL.exec(String(t));
          return `<div class="lblgrp"><span class="lbl">${renderInline(m[1])}</span><span class="val">${renderInline(m[2])}</span></div>`;
        }).join("");
      }
      if (b && b.type === "paragraph") {
        const t = b.text ?? b.content ?? b.body ?? "";
        return t ? `<p class="content-p card-comment">${renderInline(t)}</p>` : "";
      }
      return renderBlock(b, deckUsed, frameIcons);
    };
    const contentCards = block.cards.map((card, cardIndex) => {
      const blocks = Array.isArray(card.blocks) ? card.blocks : [];
      const hasMedia = blocks.some((b) => b && CARD_MEDIA_TYPES.has(b.type));
      const hasText = blocks.some((b) => b && CARD_TEXT_TYPES.has(b.type));
      const fragmentAttr = stepped && cardIndex + offset > 0 ? " data-fragment" : "";
      const headHtml = card.title ? `<h4>${renderInline(card.title)}</h4>` : "";
      if (hasMedia && hasText) {
        // G5: group the media column's consecutive images into a side-by-side row.
        const mediaHtml = groupImageRows(blocks.filter((b) => b && CARD_MEDIA_TYPES.has(b.type))).map((b) => renderBlock(b, deckUsed, frameIcons)).filter(Boolean).join("\n");
        const textHtml = blocks.filter((b) => !(b && CARD_MEDIA_TYPES.has(b.type))).map(renderCardBlock).filter(Boolean).join("\n");
        return `<article class="card card-media-split"${fragmentAttr}>${headHtml}<div class="card-split-grid"><div class="card-media-col">${mediaHtml}</div><div class="card-text-col">${textHtml}</div></div></article>`;
      }
      // G5: a media-only / mixed card with consecutive images lays them side-by-side too.
      return `<article class="card"${fragmentAttr}>${headHtml}${groupImageRows(blocks).map(renderCardBlock).join("\n")}</article>`;
    }).join("");
    if (stepped) {
      return `<div class="card-gallery" data-exclusive>${titleCard}${contentCards}</div>`;
    }
    // Static grid: the slide title rides above the grid (cards has no slide-level title stamp).
    const header = block.title
      ? `<div class="cards-grid-head">${block.kicker ? `<p class="card-title-kicker">${escapeHtml(block.kicker)}</p>` : ""}<h2 class="cards-grid-title">${renderInline(block.title)}</h2></div>`
      : "";
    return `${header}<div class="card-gallery card-grid${block.rows ? " cards-rows" : ""}">${contentCards}</div>`;
  }
  if (block.type === "feature-list" && Array.isArray(block.items)) {
    // H1 — nested children: `block.children[i]` (when present) is item i's nested sub-tree
    // (`[{text, children}]`). The style decision uses ONLY the depth-0 item texts (children
    // never influence icons/numbers/plain). Children render INSIDE the parent card as a
    // quiet sub-list (thin dashes, smaller type, no icons, no fragments of their own — the
    // parent <li> is the reveal unit, so children appear with their parent).
    const children = Array.isArray(block.children) ? block.children : [];
    const anyChildren = children.some((c) => Array.isArray(c) && c.length);
    // {annotated} (2026-06-10): the PPT "Icon Label Description" treatment — each item is a
    // roomy card with a BIG primary label, and its children render as a quiet annotation
    // column on the RIGHT of the card (no bullets), not as an indented sub-list below.
    // Declared BEFORE wide/hasKids so those can suppress themselves for the annotated path.
    const annotated = block.sublist === "aside" && anyChildren;
    const annotatedClass = annotated ? " fl-annotated" : "";
    const iconlistVariantClass = block.iconlistVariant === "list" ? " fl-iconlist-list" : "";
    // fl-wide interplay (judged visually): a list with nested children reads better as a
    // full-width single column so each parent card has room for its sub-list; otherwise the
    // existing >6-items width rule applies.
    // SD-9 (Task 6): annotated uses a single shared-axis grid — suppress fl-wide/fl-has-children
    // so the parent grid-template-columns is not overridden by the two-column wide rule.
    const wide = (!annotated && (anyChildren || block.items.length > 6)) ? " fl-wide" : "";
    const hasKids = (!annotated && anyChildren) ? " fl-has-children" : "";
    // v3 (revised) — a list is one of three styles, decided per-list (see decideFeatureListStyle):
    //   icons   → semantic icons via the per-deck concept→icon vocabulary (same concept reuses its
    //             glyph; distinct concepts stay distinct), or brand logos (no uniqueness);
    //   numbers → ordered sequence, numbered discs;
    //   plain   → no icon column at all (.fl-plain) — name lists or weak-match lists.
    // LAYER 2 OVERRIDES: per-item `{icon=name}` (block.iconOverrides) merged with the deck `icons:`
    // map (deckUsed.iconMap, keyed by normalised concept phrase). A per-item override wins over the
    // deck map; both win over the algorithmic vocabulary pick.
    const overrides = resolveIconOverrides(block.items, block.iconOverrides, deckUsed && deckUsed.iconMap);
    // SD-10: effective icon level — reconciles frame.icons (universal) with block.liststyle.
    // frame.icons drives any list on the slide; liststyle="icons" means the author already
    // opted in via {icons}/{iconlist}. Neither is redundant:
    //   - liststyle="icons"  → top-level icons (the existing path; bare {icons}/{iconlist})
    //   - frame.icons="top"  → force top-level icons even on a plain (non-iconlist) list
    //   - frame.icons="all"  → top-level icons AND sub-bullet icons (depth ≥ 1)
    //   - frame.icons="off"  → no override; liststyle still decides
    // Rule: effectiveIcons = "all" when frame says all; "top" when frame says top OR
    // liststyle already makes the list an icon-list; "off" otherwise.
    const liststyleIsIcons = block.liststyle === "icons" || block.liststyle === "logos";
    const effectiveIcons = frameIcons === "all"
      ? "all"
      : (frameIcons === "top" || liststyleIsIcons)
        ? "top"
        : "off";
    // When frame.icons forces icons on a list that has no explicit liststyle ("icons/logos"),
    // synthesise the liststyle so decideFeatureListStyle applies the icon path.
    const resolvedListstyle = effectiveIcons !== "off" ? (block.liststyle || "icons") : (block.liststyle || "");
    const { style, icons } = decideFeatureListStyle(block.items, block.ordered, deckUsed, resolvedListstyle, overrides);
    const plainClass = style === "plain" ? " fl-plain" : "";
    // Feature lists NEVER emit data-fragment: items render fully visible by default. Stepping
    // is opt-in via reveal/focus mode (runtime walks .feature-list > li and .fl-sublist > li as
    // content units). The old always-on per-item fragment was removed in Dominik's redesign.
    // Quiet nested sub-list: thin-dash markers, smaller type, scaled again per depth (≥2),
    // never iconed unless effectiveIcons === "all". As of 2026-06-13 each sub-bullet IS its
    // own reveal step (MODE_SELECTOR adds .fl-sublist > li); `depth` starts at 1 for the
    // first level. The structure of .fl-sublist > li is NOT changed — sub-icons are injected
    // as an optional leading .fl-sub-icon inside the existing <li>, so stepping units are unchanged.
    const renderSubList = (nodes, depth, resolveSubIcons) => {
      if (!Array.isArray(nodes) || nodes.length === 0) return "";
      // Sub-bullet icon resolution: use the same semantic resolver as the top level but
      // against a fresh fresh-per-sublist assignment (sub-bullets are independent of the
      // top-level vocabulary — we resolve semantically but don't pollute the deck lexicon).
      // We use a fresh empty vocab for sub-bullets so they stay independent of deck consistency.
      let subIcons = null;
      if (resolveSubIcons && nodes.length > 0) {
        const subItems = nodes.map((n) => n.text);
        const { style: subStyle, icons: subIconsArr } = decideFeatureListStyle(subItems, false, null, "icons", null);
        subIcons = subStyle === "icons" ? subIconsArr : null;
      }
      const lis = nodes.map((n, si) => {
        const kids = Array.isArray(n.children) && n.children.length ? renderSubList(n.children, depth + 1, resolveSubIcons) : "";
        let subIconHtml = "";
        if (subIcons && subIcons[si]) {
          const subSvg = iconSvg(subIcons[si]);
          if (subSvg) subIconHtml = `<span class="fl-sub-icon">${subSvg}</span>`;
        }
        return `<li>${subIconHtml}<span class="fl-subtext">${renderInline(n.text)}</span>${kids}</li>`;
      }).join("");
      return `<ul class="fl-sublist${subIcons ? " fl-sublist-icons" : ""}" data-depth="${depth}">${lis}</ul>`;
    };
    // {group}: the whole list reveals as one beat — MODE_SELECTOR treats [data-reveal-group] as a
    // single unit and excludes its bullets from individual stepping.
    const groupAttr = block.revealGroup ? " data-reveal-group" : "";
    const resolveSubIcons = effectiveIcons === "all";
    // SD-9 (Task 6): annotated shared-axis grid. Each <li> is display:contents (CSS), so lead
    // and ann lift directly into the parent grid columns. The lead wraps icon + text in .fl-lead
    // (column 1, max-content); annotation children render as a flat .fl-ann span (column 2).
    // Annotation text: join depth-0 child texts with " · " so multiple children stay readable.
    if (annotated) {
      return `<ul class="feature-list${annotatedClass}${iconlistVariantClass}"${groupAttr}>${block.items.map((item, itemIndex) => {
        let iconHtml = "";
        if (style === "icons") {
          const svg = iconSvg(icons[itemIndex]);
          iconHtml = svg
            ? `<span class="fl-icon">${svg}</span>`
            : `<span class="fl-icon fl-num">${itemIndex + 1}</span>`;
        } else if (style === "numbers") {
          iconHtml = `<span class="fl-icon fl-num">${itemIndex + 1}</span>`;
        }
        // SD-9 fix: single child → inline fl-ann span (original look); multiple children → stepped
        // fl-sublist in col 2 (bullets + one reveal step per sub-bullet, via MODE_SELECTOR entry
        // .feature-list .fl-sublist > li). display:contents on <li> is DOM-transparent so the
        // CSS selector engine still resolves fl-sublist > li even though the <li> parent is contents.
        const childNodes = Array.isArray(children[itemIndex]) ? children[itemIndex] : [];
        let annHtml = "";
        if (childNodes.length === 1) {
          // Single child: keep the existing inline annotation look
          annHtml = `<span class="fl-ann">${renderInline(childNodes[0].text || "")}</span>`;
        } else if (childNodes.length > 1) {
          // Multiple children: render as a proper stepped sub-list in col 2
          annHtml = renderSubList(childNodes, 1, resolveSubIcons);
        }
        return `<li><span class="fl-lead">${iconHtml}<span class="fl-text">${renderInline(item)}</span></span>${annHtml}</li>`;
      }).join("")}</ul>`;
    }
    return `<ul class="feature-list${wide}${plainClass}${hasKids}${annotatedClass}${iconlistVariantClass}"${groupAttr}>${block.items.map((item, itemIndex) => {
      let icon = "";
      if (style === "icons") {
        // Icon-or-number: a slot whose icon doesn't resolve (e.g. one invalid {icon=name} among
        // valid pins) shows a number disc rather than a blank — the valid pins still render.
        const svg = iconSvg(icons[itemIndex]);
        icon = svg
          ? `<span class="fl-icon">${svg}</span>`
          : `<span class="fl-icon fl-num">${itemIndex + 1}</span>`;
      } else if (style === "numbers") icon = `<span class="fl-icon fl-num">${itemIndex + 1}</span>`;
      const sub = renderSubList(children[itemIndex], 1, resolveSubIcons);
      return `<li>${icon}<span class="fl-text">${renderInline(item)}</span>${sub}</li>`;
    }).join("")}</ul>`;
  }
  if (block.type === "list" && Array.isArray(block.items)) {
    return `<ul>${block.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`;
  }
  if (Array.isArray(block.items)) {
    return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  }
  // UNIVERSAL CONTENT PARAGRAPH (G6). Every content paragraph a slide renders — beside a
  // figure (copy-visual / list-visual / cards-media-split), in a statement layout, or as a
  // bare slide paragraph — carries `.content-p`. ONE class is the single styling + stepping
  // hook: CSS gives it the comment/statement treatment per container (descendant selectors,
  // not N container-specific <p> paths) and MODE_SELECTOR steps it as a content unit.
  // Excluded paragraphs (kicker, cite, figcaption, .slide-source, .kicker-compact) are emitted
  // by their own code paths and never pass through here, so they never get `.content-p`.
  return text ? `<p class="content-p">${renderInline(text)}</p>` : "";
}

// === {stats} item parsing (PPT-replication batch, 2026-06-11) ===
// A stat item is `value label` — the VALUE is the first whitespace-separated token that carries
// a digit ("1000+", "95%", "£2m", "3×") and the LABEL is the rest. An explicit ` · ` separator
// overrides the heuristic so non-numeric values stay authorable ("Two thirds · of all teams").
// No digit and no separator → the whole text is the label (renders as a plain cell, no value).
export function parseStatItem(text) {
  const t = String(text || "").trim();
  // ` · ` or any space-surrounded dash splits explicitly (the middot is untypeable; 2026-06-12).
  const sepMatch = t.match(/\s[·—–-]\s/);
  if (sepMatch) return { value: t.slice(0, sepMatch.index).trim(), label: t.slice(sepMatch.index + sepMatch[0].length).trim() };
  const m = t.match(/^(\S*\d\S*)\s+(.+)$/);
  if (m) return { value: m[1], label: m[2] };
  return { value: "", label: t };
}

// === {chart} item parsing (layout batch 2, 2026-06-12) ===
// A chart point is one depth-0 list item in one of three authored shapes:
//   - a bare numeric item whose FIRST CHILD is the label (Dominik's outline shape);
//   - `label · 30` / `30 · label` — the side containing a digit is the value;
//   - `value label` / `label value` single-line (the parseStatItem grammar).
// The DISPLAY text stays AS AUTHORED ("2,000+" math-parses as 2000 but renders "2,000+").
// Items with no parseable number land in `unparsed` so flushSlide can warn
// (`chart-unparsed:<line>`) — never a silent skip.
export function parseChartItems(items, childTrees) {
  const kids = Array.isArray(childTrees) ? childTrees : [];
  const points = [];
  const unparsed = [];
  const numberOf = (s) => {
    const m = String(s).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  // A VALUE-shaped token starts with a digit (optionally signed/currency-prefixed): "80",
  // "2,000+", "£2m", "95%". "Q3" or "v2" merely CONTAIN digits — they are labels.
  const isValueish = (s) => /^[£$€+~-]?\d/.test(String(s).trim());
  (items || []).forEach((raw, i) => {
    const t = String(raw || "").trim();
    const childText = (Array.isArray(kids[i]) ? kids[i] : []).filter((c) => c && c.text).map((c) => c.text).join(" · ");
    // Separators (2026-06-12): the middot was untypeable — any space-surrounded dash family,
    // `=`, or `:` splits label/value too ("Writing the outline - 50", "Q3 = 31", "2024: 60").
    const sepMatch = t.match(/\s[·—–=:-]\s|:\s+/);
    if (sepMatch) {
      const left = t.slice(0, sepMatch.index).trim();
      const right = t.slice(sepMatch.index + sepMatch[0].length).trim();
      const leftValue = isValueish(left);
      const rightValue = isValueish(right);
      if (leftValue !== rightValue) {
        const valueSide = leftValue ? left : right;
        points.push({ value: numberOf(valueSide), valueText: valueSide, label: leftValue ? right : left });
        return;
      }
      // BOTH sides value-shaped (`2023 · 10` — a year label and its value, the canonical
      // line-chart shape): reading order wins, left = label, right = value. Neither → unparsed.
      if (leftValue && rightValue) {
        points.push({ value: numberOf(right), valueText: right, label: left });
        return;
      }
      unparsed.push(t);
      return;
    }
    if (/^\S+$/.test(t) && isValueish(t) && numberOf(t) != null) {
      points.push({ value: numberOf(t), valueText: t, label: childText });
      return;
    }
    const m = t.match(/^(\S+)\s+(.+)$/) || [];
    if (m.length) {
      const a = m[1].trim();
      const b = m[2].trim();
      if (isValueish(a) && !isValueish(b)) {
        points.push({ value: numberOf(a), valueText: a, label: b });
        return;
      }
      const tail = b.match(/^(.+?)\s+(\S+)$/);
      const lastTok = tail ? tail[2] : b;
      const head = tail ? `${a} ${tail[1]}` : a;
      if (!isValueish(a) && isValueish(lastTok) && /^\S+$/.test(lastTok)) {
        points.push({ value: numberOf(lastTok), valueText: lastTok, label: head });
        return;
      }
    }
    unparsed.push(t);
  });
  return { points, unparsed };
}

// === {sigmoid} item parsing (2026-06-13) ===
// Each item places a labelled point ON a fixed S-curve. The position is a named STAGE or a
// 0–100 percent, split from the label by a separator (`:` or any space-surrounded dash/`=`):
//   "early: first movers"  ·  "25: quarter way"  ·  "inflection · tipping point"
// An item with no parseable position is still kept (x=null) and auto-spaced across the curve in
// author order — so a bare list of labels just distributes evenly. Nothing is dropped.
const SIGMOID_STAGES = {
  early: 0.08, start: 0.08,
  rising: 0.30, takeoff: 0.30, growth: 0.30,
  inflection: 0.50, tipping: 0.50, midpoint: 0.50,
  mature: 0.72, maturing: 0.72,
  plateau: 0.92, saturation: 0.92, late: 0.92, end: 0.92,
};
export function parseSigmoidItems(items, _childTrees) {
  const list = Array.isArray(items) ? items : [];
  const positionOf = (token) => {
    const key = String(token).trim().toLowerCase();
    if (key in SIGMOID_STAGES) return SIGMOID_STAGES[key];
    const m = key.match(/^-?\d+(\.\d+)?$/);
    if (m) return Math.max(0, Math.min(1, Number(key) / 100));
    return null;
  };
  const parsed = list.map((raw) => {
    const t = String(raw || "").trim();
    const sep = t.match(/\s[·—–=:-]\s|:\s+/);
    if (sep) {
      const left = t.slice(0, sep.index).trim();
      const right = t.slice(sep.index + sep[0].length).trim();
      const x = positionOf(left);
      if (x != null) return { x, label: right };
    }
    return { x: null, label: t }; // no recognised position → auto-space later
  });
  // Fill auto positions evenly across [0.06, 0.94] by their item index (explicit ones keep theirs).
  const n = parsed.length;
  return parsed.map((p, i) => p.x != null
    ? p
    : { x: n <= 1 ? 0.5 : 0.06 + (i * (0.94 - 0.06)) / (n - 1), label: p.label });
}

// === {timetable} parsing (2026-06-13) ===
// A day schedule: each item is `time · event` (any space-surrounded dash/middot/= splits — NOT
// `:`, since clock times contain a colon). A row is a BREAK when the event starts with `~`
// (stripped) or matches a break keyword. `minutes` (since midnight) drives the presenter
// reminder armed at that wall-clock time; rows with no parseable time get no reminder.
const TIMETABLE_BREAK_RE = /\b(break|lunch|coffee|tea|recess|pause|interval|lunchtime)\b/i;
function timetableMinutes(time) {
  const m = String(time).trim().match(/^(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  const ap = m[3] && m[3].toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23) return null;
  return h * 60 + min;
}
export function parseTimetableRows(items) {
  return (Array.isArray(items) ? items : []).map((raw) => {
    const t = String(raw || "").trim();
    let time = "", event = t;
    const sep = t.match(/\s[·—–=-]\s/); // space-surrounded separator, never the time's own colon
    if (sep) {
      time = t.slice(0, sep.index).trim();
      event = t.slice(sep.index + sep[0].length).trim();
    } else {
      const m = t.match(/^(\d{1,2}:\d{2}(?:\s?[ap]m)?)\s+(.+)$/i); // "09:00 Welcome" without a separator
      if (m) { time = m[1].trim(); event = m[2].trim(); }
    }
    let isBreak = false;
    if (event.startsWith("~")) { isBreak = true; event = event.replace(/^~\s*/, ""); }
    if (TIMETABLE_BREAK_RE.test(event)) isBreak = true;
    return { time, event, isBreak, minutes: time ? timetableMinutes(time) : null };
  });
}

// F1 — content-driven feature lists: any list block that isn't consumed by a
// specialised layout mapping becomes a feature-list. Bare generic <ul> is impossible
// for v2 content — every list either becomes a structural block (contrast/tiles/
// system-map/image-claim/timeline) or a feature-list. Applied as a final pass over
// all layouts so the caller never needs to enumerate which ones need it.
function featurizeRemainingLists(blocks) {
  return blocks.map((b) => (b && b.type === "list" && Array.isArray(b.items)
    ? { ...b, type: "feature-list" }
    : b));
}

export function mapBlocksToLayout(layout, blocks) {
  const firstList = blocks.find((b) => b.type === "list");
  const firstImage = blocks.find((b) => b.type === "image");
  const rest = (skip) => blocks.filter((b) => !skip.includes(b));
  if (layout === "contrast" && firstList) {
    const pairs = firstList.items.map((item) => {
      const idx = item.indexOf(" / ");
      return idx >= 0 ? [item.slice(0, idx), item.slice(idx + 3)] : [item, ""];
    });
    // contrast consumes firstList; featurize any other lists that remain
    return featurizeRemainingLists([...rest([firstList]), { type: "contrast", pairs }]);
  }
  if (layout === "list" && firstList) {
    return featurizeRemainingLists([...rest([firstList]), { type: "feature-list", items: firstList.items, ordered: firstList.ordered, children: firstList.children, ...(firstList.iconOverrides ? { iconOverrides: firstList.iconOverrides } : {}) }]);
  }
  if (layout === "grid" && firstList) return featurizeRemainingLists([...rest([firstList]), { type: "tiles", items: firstList.items }]);
  if (layout === "system-map" && firstList) return featurizeRemainingLists([...rest([firstList]), { type: "system-map", nodes: firstList.items }]);
  // Concept map: the first list's items are RELATION lines `A -label- B`. Parse them into a
  // deduped node set + labelled edges; unparsed lines are carried on the block so flushSlide can
  // warn. The block holds the graph model; renderBlock lays it out as an SVG.
  if (layout === "conceptmap" && firstList) {
    const graph = parseConceptRelations(firstList.items);
    return featurizeRemainingLists([...rest([firstList]), { type: "conceptmap", ...graph }]);
  }
  // SmartArt: a nested list becomes a PowerPoint-style hierarchical node grid. Depth-0 items
  // are nodes (each with a heading); their depth-1 children become that node's ordered steps;
  // deeper nesting nests further node sub-trees. A flat list (no children) renders as a row of
  // heading-only nodes. The list's `children` array is aligned by index to `items`, each entry a
  // `[{text, children}]` sub-tree (the same shape feature-lists consume), so we build the node
  // model directly from it. Other blocks (a leading paragraph, trailing media) stay in flow.
  if (layout === "smartart" && firstList) {
    const childTrees = Array.isArray(firstList.children) ? firstList.children : [];
    const buildNode = (n) => ({
      text: n.text,
      children: (Array.isArray(n.children) ? n.children : []).map(buildNode)
    });
    const nodes = firstList.items.map((text, i) => ({
      text,
      children: (Array.isArray(childTrees[i]) ? childTrees[i] : []).map(buildNode)
    }));
    return featurizeRemainingLists([...rest([firstList]), { type: "smartart", nodes }]);
  }
  // SmartArt variants (pyramid / orgchart / mindmap) all build the SAME node model from the first
  // (nested) list as smartart does — depth-0 items are nodes, their nested children carried as a
  // `[{text, children}]` sub-tree — so the variant renderers can read the hierarchy directly. The
  // variant differs only in how that model is DRAWN (tiers / tree / radial), kept in renderBlock.
  if ((layout === "pyramid" || layout === "orgchart" || layout === "mindmap") && firstList) {
    const childTrees = Array.isArray(firstList.children) ? firstList.children : [];
    const buildNode = (n) => ({
      text: n.text,
      children: (Array.isArray(n.children) ? n.children : []).map(buildNode)
    });
    const nodes = firstList.items.map((text, i) => ({
      text,
      children: (Array.isArray(childTrees[i]) ? childTrees[i] : []).map(buildNode)
    }));
    return featurizeRemainingLists([...rest([firstList]), { type: layout, nodes }]);
  }
  // flow: a list becomes a connected sequence of NODE cards joined by accent connectors. A node
  // is a top-level list item (its text is the node label); its nested children render as the
  // node's smaller detail lines (reusing the same `[{text, children}]` sub-tree feature-lists
  // and smartart consume). The `flow` direction attr (horizontal | vertical | loop | branch) is
  // attached onto the block in flushSlide. Other blocks (lead paragraph, trailing media) stay in
  // flow above/below the diagram.
  if (layout === "flow" && firstList) {
    const childTrees = Array.isArray(firstList.children) ? firstList.children : [];
    const buildNode = (n) => ({
      text: n.text,
      children: (Array.isArray(n.children) ? n.children : []).map(buildNode)
    });
    const nodes = firstList.items.map((text, i) => ({
      text,
      children: (Array.isArray(childTrees[i]) ? childTrees[i] : []).map(buildNode)
    }));
    return featurizeRemainingLists([...rest([firstList]), { type: "flow", nodes }]);
  }
  if (layout === "image-claim" && firstImage && firstList) {
    return featurizeRemainingLists([...rest([firstImage, firstList]), { type: "image-claim", image: firstImage, callouts: firstList.items }]);
  }
  // ── PPT-replication batch (2026-06-11) ──
  // stats: each depth-0 item parses into { value, label } (see parseStatItem); a first nested
  // child becomes the cell's small caption line. The row is the unit; deeper nesting flattens.
  if (layout === "stats" && firstList) {
    const childTrees = Array.isArray(firstList.children) ? firstList.children : [];
    const cells = firstList.items.map((text, i) => {
      const kids = Array.isArray(childTrees[i]) ? childTrees[i] : [];
      const cap = kids.filter((c) => c && c.text).map((c) => c.text).join(" · ");
      return { ...parseStatItem(text), cap };
    });
    return featurizeRemainingLists([...rest([firstList]), { type: "stats", cells }]);
  }
  // process / steps: both consume the first (nested) list into the SAME node model the other
  // smartart-family variants use; the difference is purely how renderBlock draws it (numbered
  // connector strip vs ascending stairs).
  if ((layout === "process" || layout === "steps") && firstList) {
    const childTrees = Array.isArray(firstList.children) ? firstList.children : [];
    const buildNode = (n) => ({
      text: n.text,
      children: (Array.isArray(n.children) ? n.children : []).map(buildNode)
    });
    const nodes = firstList.items.map((text, i) => ({
      text,
      children: (Array.isArray(childTrees[i]) ? childTrees[i] : []).map(buildNode)
    }));
    return featurizeRemainingLists([...rest([firstList]), { type: layout, nodes }]);
  }
  // iconrow: the same node model plus the list's per-item {icon=…} overrides, so the renderer
  // can resolve icons through the SAME vocabulary feature-lists use (deck icons: map included).
  if (layout === "iconrow" && firstList) {
    const childTrees = Array.isArray(firstList.children) ? firstList.children : [];
    const nodes = firstList.items.map((text, i) => ({
      text,
      children: (Array.isArray(childTrees[i]) ? childTrees[i] : []).filter((c) => c && c.text).map((c) => ({ text: c.text }))
    }));
    return featurizeRemainingLists([...rest([firstList]), {
      type: "iconrow", nodes,
      ...(firstList.iconOverrides ? { iconOverrides: firstList.iconOverrides } : {})
    }]);
  }
  // {timeline} over a PLAIN list (2026-06-12): picking the Timeline layout used to do nothing
  // unless the content was a `**Timeline:**` block — the slide silently fell through to a
  // feature-list. Now the first list converts: each item is a timeline row (children indent as
  // grouped entries), so `- 10 min — Getting ready` becomes a labelled stop via the explicit
  // separator rules. An existing timeline block still wins (rest of the body untouched).
  if (layout === "timeline" && firstList && !blocks.some((b) => b.type === "timeline")) {
    const childTrees = Array.isArray(firstList.children) ? firstList.children : [];
    const rows = [];
    firstList.items.forEach((text, i) => {
      rows.push({ indent: 0, text });
      for (const kid of (Array.isArray(childTrees[i]) ? childTrees[i] : [])) {
        if (kid && kid.text) rows.push({ indent: 1, text: kid.text });
      }
    });
    const groups = groupTimelineRows(rows);
    const items = groups.flatMap((g) => g.items.map((it) => (it.date ? `${it.date} — ${it.body}` : it.body)));
    return featurizeRemainingLists([...rest([firstList]), { type: "timeline", groups, items }]);
  }

  // ── Layout batch 2 (2026-06-12) ──
  // chart: the first list parses into {value, valueText, label} points (parseChartItems);
  // unparseable items ride on the block so flushSlide warns (`chart-unparsed:` — never silent).
  // The shape (bar default | pie | line) is wired on in flushSlide from the `chart` attr.
  if (layout === "chart" && firstList) {
    const { points, unparsed } = parseChartItems(firstList.items, firstList.children);
    return featurizeRemainingLists([...rest([firstList]), { type: "chart", points, unparsed }]);
  }
  // sigmoid: the first list places labelled points on a fixed S-curve (parseSigmoidItems).
  if (layout === "sigmoid" && firstList) {
    const points = parseSigmoidItems(firstList.items, firstList.children);
    return featurizeRemainingLists([...rest([firstList]), { type: "sigmoid", points }]);
  }
  // timetable: the first list is the day schedule (time · event rows; break rows flagged).
  if (layout === "timetable" && firstList) {
    const rows = parseTimetableRows(firstList.items);
    return featurizeRemainingLists([...rest([firstList]), { type: "timetable", rows }]);
  }
  // table: depth-0 items are the column HEADERS, each item's flat children that column's
  // cells; transpose columns→rows (short columns pad with ""). Emits the EXISTING table
  // block so .slide-table styling is reused — markdown pipe tables are unaffected. An
  // all-numeric column right-aligns (numericCols rides to the renderer).
  if (layout === "table" && firstList) {
    const childTrees = Array.isArray(firstList.children) ? firstList.children : [];
    const header = firstList.items;
    const cols = header.map((_, i) => (Array.isArray(childTrees[i]) ? childTrees[i] : [])
      .filter((c) => c && c.text).map((c) => c.text));
    const depth = Math.max(0, ...cols.map((c) => c.length));
    const rows = Array.from({ length: depth }, (_, r) => cols.map((c) => c[r] ?? ""));
    const numericCols = cols.map((c) => c.length > 0 && c.every((cell) => /\d/.test(cell) && !/[a-z]{3,}/i.test(cell)));
    return featurizeRemainingLists([...rest([firstList]), { type: "table", header, rows, numericCols }]);
  }
  // cycle: depth-0 items are the stages around the ellipse; a first child renders as the
  // node's small caption (the pyramid-style detail line).
  if (layout === "cycle" && firstList) {
    const childTrees = Array.isArray(firstList.children) ? firstList.children : [];
    const nodes = firstList.items.map((text, i) => {
      const kids = Array.isArray(childTrees[i]) ? childTrees[i] : [];
      const cap = kids.filter((c) => c && c.text).map((c) => c.text).join(" · ");
      return { text, cap };
    });
    return featurizeRemainingLists([...rest([firstList]), { type: "cycle", nodes }]);
  }
  // equation: items combine A + B → C; the LAST item is the result disc. Fewer than two
  // items cannot equate — leave the list alone so the slide degrades to a feature-list.
  if (layout === "equation" && firstList && firstList.items.length >= 2) {
    return featurizeRemainingLists([...rest([firstList]), {
      type: "equation",
      operands: firstList.items.slice(0, -1),
      result: firstList.items[firstList.items.length - 1]
    }]);
  }
  // image-quote: the first image + the first quote pair into one composed block (image beside
  // quote, attribution bar below). Missing either piece → leave the blocks alone so the slide
  // degrades to its natural rendering instead of half a composition.
  if (layout === "image-quote") {
    const firstQuote = blocks.find((b) => b.type === "quote");
    if (firstImage && firstQuote) {
      return featurizeRemainingLists([...rest([firstImage, firstQuote]), { type: "image-quote", image: firstImage, quote: firstQuote }]);
    }
    return featurizeRemainingLists(blocks);
  }
  // image-grid (bare-images authoring): every image becomes a grid cell, its caption promoted
  // to the cell's note title. (#### card authoring is handled in flushSlide — the cards become
  // the cells so each can carry a note body.)
  if (layout === "image-grid") {
    const images = blocks.filter((b) => b && b.type === "image");
    if (images.length) {
      // ADR-0021 adaptive: pair each image with an immediately-following single-item list as
      // its label (the `![](img)` + `- Label` shape authors reach for); the adjacent bullet wins
      // over the image's own alt-caption because it is the label the author typed beside it.
      // Lists that cannot be paired stay in flow and are flagged so flushSlide can warn.
      const consumed = new Set();
      const cells = [];
      for (let i = 0; i < blocks.length; i += 1) {
        const b = blocks[i];
        if (!b || b.type !== "image") continue;
        consumed.add(b);
        const next = blocks[i + 1];
        let title = "";
        if (next && next.type === "list" && Array.isArray(next.items) && next.items.length === 1) {
          title = next.items[0];
          consumed.add(next);
        }
        if (!title) title = b.caption || "";
        cells.push({ title, blocks: [{ ...b, caption: "" }] });
      }
      const remaining = blocks.filter((b) => !consumed.has(b));
      const igBlock = { type: "image-grid", cells };
      const strayLabels = remaining
        .filter((b) => b && b.type === "list")
        .reduce((n, l) => n + (Array.isArray(l.items) ? l.items.length : 0), 0);
      if (strayLabels) igBlock.strayLabels = strayLabels;
      return featurizeRemainingLists([...remaining, igBlock]);
    }
    return featurizeRemainingLists(blocks);
  }
  if (layout === "cta-screenshots") {
    // Call-to-action layout: a strip of screenshots (left), a callout list (right), and any
    // `[Action:]` buttons (below the callouts). Images, the first list, and action blocks are
    // CONSUMED into one `cta-screenshots` block; the leading lead paragraph (and anything else)
    // stays in flow and renders above the cta-layout.
    const images = blocks.filter((b) => b && b.type === "image");
    const actions = blocks.filter((b) => b && b.type === "action");
    const consumed = [...images, ...actions, ...(firstList ? [firstList] : [])];
    const remaining = blocks.filter((b) => !consumed.includes(b));
    return featurizeRemainingLists([...remaining, {
      type: "cta-screenshots",
      images,
      callouts: firstList ? firstList.items : [],
      actions
    }]);
  }
  // F1: for all other layouts (including list-visual, copy-visual, media, statement,
  // timeline, cards, etc.) featurize any remaining list blocks.
  return featurizeRemainingLists(blocks);
}

export function renderBlocks(blocks, fallbackText = "", deckUsed = null, frameIcons = "off") {
  const normalized = Array.isArray(blocks) ? blocks : fallbackText ? [{ type: "paragraph", text: fallbackText }] : [];
  // G5: side-by-side consecutive images in the slide body / gallery flow. A run of
  // `[Action:]` directives groups into one .slide-actions button row (rendered after the
  // other blocks, in document order).
  const html = groupActionBlocks(groupQrRows(groupImageRows(normalized))).map((b) => renderBlock(b, deckUsed, frameIcons)).filter(Boolean).join("\n");
  return html || "<p></p>";
}
