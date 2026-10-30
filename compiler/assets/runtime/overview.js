// Shared overview runtime. Inlined verbatim (no export) into the presenter template AND the handout
// (buildShareHtml) — see 01-cli-utils.overviewRuntimeSource, which puts the generated slide-search.js
// (`SlideSearch`, the app's one search rule from src/shared/slide-handling/query.ts) in front of it.
// Pure helpers (rankSlides, deriveSlideStatus) are also loaded by scripts/test-overview.mjs.
// createOverview touches `document` only inside its body, so the test's `new Function(...)` load
// parses but never executes it — no DOM required at load.

// Slide fields as the search reads them, prepared (lowercased) once per slide. A slide that carries
// body / notes / image strings (the tests) is used as given; a slide with only `el` has them read
// from its markup at the first search (overviewSlideText), so loading a deck costs nothing.
// notesOk: presenter notes are read and searched only when true (the presenter view). Audience pages
// (deck, share page, handout) never read them, so a search cannot reveal them. Default true only for
// direct callers (tests); createOverview always passes host.isPresenter.
function overviewFields(s, notesOk = true) {
  if (s.body === undefined && s.el && typeof document !== "undefined") Object.assign(s, overviewSlideText(overviewSlideView(s.el, notesOk), notesOk));
  if (!s._fields) s._fields = { title: s.title || "", body: s.body || "", image: s.image || "", notes: notesOk ? (s.notes || "") : "" };
  if (!s._prepared) s._prepared = SlideSearch.prepareFields(s._fields);
  return s;
}

// Does the slide itself hit the query, and which carousel children (by position in subs) do?
function overviewSlideHits(q, s, notesOk = true) {
  overviewFields(s, notesOk);
  const self = SlideSearch.matchSlide(s._prepared, q);
  const subs = [];
  (Array.isArray(s.subs) ? s.subs : []).forEach((child, i) => {
    const row = SlideSearch.prepareFields({ title: child.title || "", body: child.body || "" });
    if (SlideSearch.matchSlide(row, q)) subs.push(i);
  });
  return { self, subs };
}

// Slides that hit the query, in outline order (the order they have in the talk; a hit does not move).
// Empty query -> all indices. A slide whose carousel child hits counts as a hit too.
// (Kept under its old name: it used to rank by score; the presenter and exported pages now keep the
// outline order and dim what does not match.)
function rankSlides(query, slideData, notesOk = true) {
  const q = SlideSearch.parseQuery(query || "");
  if (SlideSearch.isEmptyQuery(q)) return slideData.map((s) => s.index);
  const hits = [];
  for (const s of slideData) {
    const h = overviewSlideHits(q, s, notesOk);
    if (h.self || h.subs.length) hits.push(s.index);
  }
  return hits;
}

// Reads a slide's searchable strings from its markup: the text in reading order (one line per block,
// so a snippet can quote a line), the presenter notes (only when the page carries them), and the
// picture text — each picture's alt text plus the stored picture text the compiler put on the slide
// (data-picture-text).
const OVERVIEW_INLINE = new Set(["A", "B", "I", "EM", "STRONG", "SPAN", "MARK", "CODE", "SUB", "SUP", "SMALL", "U", "S", "DEL", "INS", "ABBR", "CITE", "Q", "KBD", "VAR", "TIME", "BDI", "BDO"]);
function overviewTextLines(root, skip) {
  const lines = [];
  let lastBlock = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || (skip && parent.closest(skip))) return NodeFilter.FILTER_REJECT;
      return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let block = node.parentElement;
    while (block && OVERVIEW_INLINE.has(block.tagName)) block = block.parentElement;
    if (block === lastBlock && lines.length) lines[lines.length - 1] += node.nodeValue;
    else lines.push(node.nodeValue);
    lastBlock = block;
  }
  return lines.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}
// The one rule for what may be read from a slide's markup: every field is read through these
// helpers. overviewOutsideNotes never returns a node inside aside.notes; overviewInNotes is used
// only when notesOk (presenter view).
function overviewOutsideNotes(root, selector) {
  const all = Array.from(root.querySelectorAll(selector));
  if (root.matches && root.matches(selector)) all.unshift(root);
  return all.filter((node) => !node.closest("aside.notes"));
}
function overviewInNotes(notesEl, selector) {
  const all = Array.from(notesEl.querySelectorAll(selector));
  if (notesEl.matches && notesEl.matches(selector)) all.unshift(notesEl);
  return all;
}
function overviewPictureStrings(nodes) {
  const out = [];
  for (const node of nodes) {
    const text = (node.tagName === "IMG" ? node.getAttribute("alt") : node.dataset && node.dataset.pictureText) || "";
    if (text.trim()) out.push(text.trim());
  }
  return out;
}
// The notes-free view: when notes may not be read (audience surfaces) every search field, title,
// carousel child and thumbnail comes from ONE copy of the slide with every aside.notes removed, so no
// per-field path can reach a note. The live slide is returned as is when it has no notes, or notesOk.
const overviewViewCache = typeof WeakMap !== "undefined" ? new WeakMap() : null;
function overviewSlideView(el, notesOk) {
  if (notesOk || !el || !el.querySelector || !el.querySelector("aside.notes")) return el;
  let view = overviewViewCache && overviewViewCache.get(el);
  if (!view) {
    view = el.cloneNode(true);
    view.querySelectorAll("aside.notes").forEach((n) => n.remove());
    if (overviewViewCache) overviewViewCache.set(el, view);
  }
  return view;
}
// Title and carousel children of a slide as the overview rows read them (from the notes-free view
// unless notesOk). Callers spread this into each slideData entry.
function overviewSlideBase(el, notesOk) {
  const v = overviewSlideView(el, notesOk);
  return {
    title: el.dataset.navLabel || el.dataset.navTitle || v.querySelector("h1,h2")?.textContent || "",
    subs: Array.from(v.querySelectorAll(".carousel-subslide")).map((c) => ({ title: c.dataset.subTitle || "", subIndex: Number(c.dataset.subIndex) || 0, body: c.textContent || "" })),
  };
}
function overviewSlideText(el, notesOk = true) {
  const picSel = "img[alt], [data-picture-text]";
  const notesEl = notesOk ? el.querySelector("aside.notes") : null;
  const notesPics = notesEl ? overviewPictureStrings(overviewInNotes(notesEl, picSel)) : [];
  return {
    body: overviewTextLines(el, "script, style, aside.notes"),
    notes: notesEl ? [overviewTextLines(notesEl, "script, style")].concat(notesPics).filter(Boolean).join("\n") : "",
    image: overviewPictureStrings(overviewOutsideNotes(el, picSel)).join("\n"),
  };
}

function preferredOverviewRow(query, slideData, rankedParents) {
  const q = (query || "").trim().toLowerCase();
  const parent = rankedParents.length ? { index: rankedParents[0] } : null;
  if (!q) return parent;
  const childMatches = [];
  for (const index of rankedParents) {
    const slide = slideData[index];
    for (const child of Array.isArray(slide?.subs) ? slide.subs : []) {
      if ((child.title || "").toLowerCase().includes(q)) {
        childMatches.push({ index, subIndex: Number(child.subIndex) || 0 });
      }
    }
  }
  return childMatches.length === 1 ? childMatches[0] : parent;
}

function clampOverviewHighlight(highlight, rowCount) {
  if (rowCount <= 0) return 0;
  return Math.max(0, Math.min(rowCount - 1, Number(highlight) || 0));
}

// Shown/skipped derivation (presenter only). shown/skippedExplicit are Sets of slide index;
// maxShown is the highest shown index. A gap before maxShown reads as "skipped (jumped)".
function deriveSlideStatus(index, ctx) {
  if (ctx.shown.has(index)) return { status: "shown" };
  if (ctx.skippedExplicit.has(index)) return { status: "skipped", reason: "explicit" };
  if (index < ctx.maxShown) return { status: "skipped", reason: "jumped" };
  return { status: "unseen" };
}

// Single overview UI used by BOTH the presenter drawer and the handout. Collapsed = grouped,
// clickable, searchable list; expanded = scaled-thumbnail grid. Search keeps the outline order:
// slides that do not match are dimmed in place, hits carry <mark>, a line saying where the words
// were found ("in text:", "in notes:", "in picture:") and a thumbnail under the row (the same
// search as the editor's outline, src/shared/slide-handling/query.ts). Keyboard: type to search,
// Up/Down move through the hits in order, Enter jumps to the highlighted hit (or the first) and
// closes, Esc closes. Shown/skipped markers render only when host.isPresenter and host.getStatus
// returns a status. host.statusIcon(status), when given, draws a marker (the presenter's lucide
// icons, ticket 08); without it, or when it returns nothing, the marker is the text glyph.
function createOverview(host) {
  let expanded = false;
  let highlight = 0;           // index into the current visible order
  let renderedCurrentIndex = null;
  let visibleOrder = [];       // { index, subIndex? } rows you can move through, in display order (the hits while searching)

  const statusGlyph = { shown: "●", skipped: "⊘", unseen: "○" };
  const THUMBS_WHILE_SEARCHING = 60;  // more hits than this show no thumbnail under the row (cost: one slide clone each)

  // Text with the query's words wrapped in <mark>; a plain text node when there is nothing to mark.
  function marked(text, terms) {
    const frag = document.createDocumentFragment();
    for (const seg of SlideSearch.highlightSegments(text, terms)) {
      if (seg.hit) {
        const m = document.createElement("mark");
        m.className = "tw-match";
        m.textContent = seg.text;
        frag.appendChild(m);
      } else frag.appendChild(document.createTextNode(seg.text));
    }
    return frag;
  }

  // The line under a hit: where the words were found ("in text:", "in notes:", "in picture:") and the quoted line, marked.
  function snippetEl(sn) {
    const line = document.createElement("span");
    line.className = "tw-snippet";
    line.appendChild(document.createTextNode(`${sn.label}: `));
    for (const seg of sn.segments) {
      if (seg.hit) { const m = document.createElement("mark"); m.className = "tw-match"; m.textContent = seg.text; line.appendChild(m); }
      else line.appendChild(document.createTextNode(seg.text));
    }
    return line;
  }

  // A scaled-down copy of the slide. A slide is position:absolute;inset:0;display:none until
  // .active. Render the clone inside a fixed deck-sized inner (the clone fills it via inset:0),
  // force it visible+active, then scale the inner down to the column width (see scaleThumbs).
  // Iframes/videos would reload per thumbnail (cost + network) — swap them for a light placeholder.
  function buildThumb(s, subIndex) {
    const thumb = document.createElement("div");
    thumb.className = "tw-thumb";
    const inner = document.createElement("div");
    inner.className = "tw-thumb-inner";
    const clone = overviewSlideView(s.el, Boolean(host.isPresenter)).cloneNode(true);
    clone.classList.add("active");
    clone.removeAttribute("aria-hidden");
    if (subIndex != null) {   // a carousel child: show that child's card in the copy
      clone.querySelectorAll(".carousel-subslide").forEach((c) => c.classList.toggle("active-card", Number(c.dataset.subIndex) === subIndex));
    }
    clone.querySelectorAll("audio").forEach((m) => m.remove());
    clone.querySelectorAll("iframe, video").forEach((m) => {
      const ph = document.createElement("div");
      ph.className = "tw-thumb-embed";
      m.replaceWith(ph);
    });
    inner.appendChild(clone);
    thumb.appendChild(inner);
    return thumb;
  }

  function build(filter, preferQueryTarget = false, followCurrent = false) {
    if (host.beforeBuild) host.beforeBuild();
    const list = host.listEl;
    list.replaceChildren();
    list.classList.toggle("tw-overview-grid", expanded);
    const skippedOnly = host.isPresenter && Boolean(host.skippedOnlyEl?.checked);
    const q = SlideSearch.parseQuery(filter || "");
    const searching = !SlideSearch.isEmptyQuery(q);   // a query with something to look for
    const terms = searching ? SlideSearch.highlightTerms(q) : [];
    const rows = host.slideData.map((s) => s.index)
      .filter((index) => !skippedOnly || host.getStatus(index)?.status === "skipped");
    // Where the query hits each row: the slide itself and its carousel children (collapsed list only
    // shows children, so then a child-only hit leaves the parent row dimmed).
    const hitsOf = new Map();
    const hitParents = [];
    let hitCount = 0;
    if (searching) {
      for (const index of rows) {
        const h = overviewSlideHits(q, host.slideData[index], Boolean(host.isPresenter));
        hitsOf.set(index, h);
        const parentHit = h.self || (expanded && h.subs.length > 0);
        if (h.self || h.subs.length) hitParents.push(index);
        if (parentHit) hitCount++;
        if (!expanded) hitCount += h.subs.length;
      }
    }
    const hitsInHead = new Map();   // "section" / "section/subsection" -> hits under it
    for (const index of hitParents) {
      const s = host.slideData[index];
      const h = hitsOf.get(index);
      const n = (h.self || (expanded && h.subs.length) ? 1 : 0) + (expanded ? 0 : h.subs.length);
      for (const key of [s.section, `${s.section}/${s.subsection || ""}`]) hitsInHead.set(key, (hitsInHead.get(key) || 0) + n);
    }
    visibleOrder = [];
    const cur = host.getCurrentIndex();
    renderedCurrentIndex = cur;
    if (searching) {
      const count = document.createElement("p");
      count.className = "tw-overview-hits";
      count.setAttribute("role", "status");
      count.textContent = hitCount ? `${hitCount} ${hitCount === 1 ? "match" : "matches"}` : "No slides match";
      if (skippedOnly && !hitCount) count.textContent = "No skipped slides match your search";
      list.appendChild(count);
    }
    // A section or subsection heading: a hit in its own title is marked; no hits under it dims it
    // while searching; the number of hits under it sits at the right.
    function headRow(className, text, key, jumpIndex) {
      const head = document.createElement("button");
      head.type = "button"; head.className = className;
      head.appendChild(searching ? marked(text, terms) : document.createTextNode(text));
      if (searching) {
        const n = hitsInHead.get(key) || 0;
        const titleHit = SlideSearch.fieldHits(SlideSearch.prepareFields({ title: text, body: "" }), q).title;
        if (!n && !titleHit) head.classList.add("tw-dim");
        if (n) {
          const badge = document.createElement("span");
          badge.className = "tw-hit-count";
          badge.textContent = String(n);
          head.appendChild(badge);
        }
      }
      head.addEventListener("click", () => jump(jumpIndex));
      list.appendChild(head);
    }
    let curSection = null, curSub = null;
    let thumbsLeft = THUMBS_WHILE_SEARCHING;
    rows.forEach((index) => {
      const s = host.slideData[index];
      if (s.section !== curSection) {
        curSection = s.section; curSub = null;
        headRow("section-head", host.sectionTitleById.get(curSection) || `Section ${curSection || ""}`.trim(), s.section, index);
      }
      if ((s.subsection || "") !== curSub) {
        curSub = s.subsection || "";
        if (curSub) headRow("subsection-head", host.subsectionTitleById.get(curSub) || curSub, `${s.section}/${curSub}`, index);
      }
      const hits = hitsOf.get(index);
      const isHit = searching && Boolean(hits && (hits.self || (expanded && hits.subs.length > 0)));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slide-link";
      if (searching) btn.classList.add(isHit ? "tw-hit" : "tw-dim");
      if (!searching || isHit) {
        const pos = visibleOrder.length;
        visibleOrder.push({ index });
        btn.dataset.pos = String(pos);
      }
      if (index === cur) btn.classList.add("current");
      const status = host.isPresenter ? host.getStatus(index) : null;
      if (status) { btn.classList.add(`tw-${status.status}`); if (status.reason) btn.title = `skipped (${status.reason})`; }
      const titleText = s.title || "(untitled)";
      if (expanded) btn.appendChild(buildThumb(s));
      const label = document.createElement("span");
      label.className = "slide-link-title";
      if (status) {
        const markerEl = document.createElement("span");
        markerEl.className = "tw-status";
        markerEl.setAttribute("aria-hidden", "true");
        const icon = host.statusIcon ? host.statusIcon(status.status) : null;
        if (icon) markerEl.appendChild(icon);
        else markerEl.textContent = statusGlyph[status.status];
        label.appendChild(markerEl);
      }
      const titleEl = document.createElement("span");
      titleEl.appendChild(document.createTextNode(`${index + 1}. `));
      titleEl.appendChild(isHit ? marked(titleText, terms) : document.createTextNode(titleText));
      label.appendChild(titleEl);
      // The handout draws one small mark per kind a person kept on this slide (host.slideMarks(index) → a node or null).
      const marks = host.slideMarks ? host.slideMarks(index) : null;
      if (marks) label.appendChild(marks);
      btn.appendChild(label);
      btn.addEventListener("click", () => jump(index));
      list.appendChild(btn);
      // Under a hit row while searching: the line saying where the words were found and the slide itself
      // (a live copy). It sits beside the row, not in it, so the row's own text stays its title.
      if (isHit && !expanded) {
        const detail = document.createElement("div");
        detail.className = "tw-hit-detail";
        const sn = hits.self ? SlideSearch.snippet(overviewFields(s, Boolean(host.isPresenter))._fields, q) : null;
        if (sn) {
          detail.appendChild(snippetEl(sn));
        }
        if (thumbsLeft > 0) {
          thumbsLeft--;
          const thumb = buildThumb(s);
          thumb.classList.add("tw-thumb-hit");
          thumb.setAttribute("aria-hidden", "true");
          detail.appendChild(thumb);
        }
        detail.addEventListener("click", () => jump(index));
        list.appendChild(detail);
      } else if (isHit && hits.self) {
        // Expanded rows carry their own thumbnail; the line goes under the title inside the card.
        const sn = SlideSearch.snippet(overviewFields(s, Boolean(host.isPresenter))._fields, q);
        if (sn) {
          btn.appendChild(snippetEl(sn));
        }
      }
      // Expanded thumbnails stay parent-only: sub-slides are navigation rows, not duplicate
      // thumbnail canvases of the same compiled parent slide.
      if (!expanded) {
        (Array.isArray(s.subs) ? s.subs : []).forEach((child, childAt) => {
          const childHit = searching && hits && hits.subs.includes(childAt);
          const subIndex = Number(child.subIndex) || 0;
          const childBtn = document.createElement("button");
          childBtn.type = "button";
          childBtn.className = "slide-link slide-sublink";
          if (searching) childBtn.classList.add(childHit ? "tw-hit" : "tw-dim");
          if (!searching || childHit) {
            const childPos = visibleOrder.length;
            visibleOrder.push({ index, subIndex });
            childBtn.dataset.pos = String(childPos);
          }
          const childLabel = document.createElement("span");
          childLabel.className = "slide-link-title";
          childLabel.appendChild(document.createTextNode(`${index + 1}.${subIndex + 1} `));
          const childTitle = child.title || "(untitled)";
          childLabel.appendChild(childHit ? marked(childTitle, terms) : document.createTextNode(childTitle));
          childBtn.appendChild(childLabel);
          childBtn.addEventListener("click", () => jump(index, subIndex));
          list.appendChild(childBtn);
          // A matching child gets the same detail as a top-level hit: the line where the words were
          // found and a copy of the slide showing that child (children carry title and body only).
          if (childHit) {
            const detail = document.createElement("div");
            detail.className = "tw-hit-detail tw-hit-detail-child";
            const sn = SlideSearch.snippet({ title: child.title || "", body: child.body || "", image: "" }, q);
            if (sn) detail.appendChild(snippetEl(sn));
            if (thumbsLeft > 0 && s.el) {
              thumbsLeft--;
              const thumb = buildThumb(s, subIndex);
              thumb.classList.add("tw-thumb-hit");
              thumb.setAttribute("aria-hidden", "true");
              detail.appendChild(thumb);
            }
            detail.addEventListener("click", () => jump(index, subIndex));
            list.appendChild(detail);
          }
        });
      }
    });
    if (host.isPresenter && followCurrent && !searching && !skippedOnly) {
      const currentPos = visibleOrder.findIndex((row) => row.index === cur && row.subIndex === undefined);
      highlight = currentPos >= 0 ? currentPos : 0;
    } else if (preferQueryTarget) {
      const preferred = preferredOverviewRow(filter, host.slideData, searching ? hitParents : rows);
      const preferredPos = preferred ? visibleOrder.findIndex((row) => row.index === preferred.index
        && row.subIndex === preferred.subIndex) : -1;
      highlight = preferredPos >= 0 ? preferredPos : 0;
    }
    highlight = clampOverviewHighlight(highlight, visibleOrder.length);
    list.querySelectorAll(".slide-link[data-pos]").forEach((row) => {
      row.classList.toggle("tw-highlight", Number(row.dataset.pos) === highlight);
    });
    if (skippedOnly && !visibleOrder.length && !searching) {
      const empty = document.createElement("p");
      empty.className = "tw-overview-empty";
      empty.setAttribute("role", "status");
      empty.textContent = "No skipped slides";
      list.appendChild(empty);
    }
    if (host.isPresenter && followCurrent && !searching && !skippedOnly) revealHighlight();
    // Scale each thumbnail's fixed 1280x720 inner down to its (responsive) column width — done after
    // layout so clientWidth is real (the drawer is open by the time rAF fires).
    if ((expanded || searching) && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        list.querySelectorAll(".tw-thumb-inner").forEach((inner) => {
          const w = inner.parentElement && inner.parentElement.clientWidth;
          if (w) inner.style.transform = "scale(" + (w / 1280) + ")";
        });
      });
    }
  }

  // Wait for the open drawer and thumbnail layout; scroll only its selected row, without
  // moving keyboard focus away from search. Same-slide refreshes must not undo browsing.
  function revealHighlight() {
    requestAnimationFrame(() => {
      if (isOpen()) host.listEl.querySelector(".tw-highlight")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function jump(index, subIndex) { host.onJump(index, subIndex); close(); }
  // Closing must RELEASE focus back to the deck. The drawer hides via a CSS transform (not
  // display:none), so a focused search input / slide-link button inside it keeps focus — and the
  // deck's key handler bails on `event.target instanceof HTMLInputElement`, so every nav key would
  // be swallowed after an Enter/click jump. Blur whatever is focused inside the drawer on close.
  function releaseFocus() {
    const active = document.activeElement;
    if (active && host.drawerEl && host.drawerEl.contains(active) && typeof active.blur === "function") active.blur();
  }
  function moveHighlight(delta) {
    if (!visibleOrder.length) return;
    highlight = (highlight + delta + visibleOrder.length) % visibleOrder.length;
    host.listEl.querySelectorAll(".slide-link[data-pos]").forEach((row) => {
      row.classList.toggle("tw-highlight", Number(row.dataset.pos) === highlight);
    });
    host.listEl.querySelector(".tw-highlight")?.scrollIntoView({ block: "nearest" });
  }
  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveHighlight(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveHighlight(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const target = visibleOrder[highlight] || visibleOrder[0];
      if (target) jump(target.index, target.subIndex);
    }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  }
  function toggleExpand() { expanded = !expanded; build(host.searchEl ? host.searchEl.value : ""); revealHighlight(); }

  function open() {
    highlight = 0;
    host.drawerEl.classList.add("open");
    build(host.searchEl ? host.searchEl.value : "", false, true);
    host.searchEl?.focus({ preventScroll: true });
  }
  function close() { releaseFocus(); host.drawerEl.classList.remove("open"); }
  function isOpen() { return host.drawerEl.classList.contains("open"); }
  function toggle() { isOpen() ? close() : open(); }

  // Filtering changes the navigation order, so begin at the first matching result. Returning
  // to the full outline resumes following; a skipped-only list normally excludes the current slide.
  host.skippedOnlyEl?.addEventListener("change", () => {
    highlight = 0;
    build(host.searchEl ? host.searchEl.value : "", true, !host.skippedOnlyEl.checked);
    revealHighlight();
  });
  host.searchEl?.addEventListener("input", () => { build(host.searchEl.value, true, !host.searchEl.value.trim()); });
  host.searchEl?.addEventListener("keydown", onKey);
  // Esc closes the drawer from whichever control inside it has focus, and that Esc is spent: it must
  // not also reach the deck's key handler (which would end a page full screen in the same press).
  host.drawerEl?.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) { close(); e.stopPropagation(); } });

  // render() with no argument re-reads the live search value — so callers on slide change need not
  // know which drawer (standalone/presenter) is mounted.
  return { render: (f) => build(f !== undefined ? f : (host.searchEl ? host.searchEl.value : ""), false, host.getCurrentIndex() !== renderedCurrentIndex), open, close, toggle, isOpen, toggleExpand };
}
