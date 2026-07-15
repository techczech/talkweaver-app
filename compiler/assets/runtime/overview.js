// Shared overview runtime. Inlined verbatim (no export) into the presenter template AND the handout
// (buildShareHtml) — see 01-cli-utils.overviewRuntimeSource. Pure helpers (rankSlides,
// deriveSlideStatus) are also loaded by scripts/test-overview.mjs. createOverview (Task 5) touches
// `document` only inside its body, so the test's `new Function(...)` load parses but never executes
// it — no DOM required at load.

// Rank slides for search. Titles first: prefix (4) > substring (3) > section/subsection (2) >
// body (1) > notes (0.5). Empty query -> all indices in original order.
function rankSlides(query, slideData) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return slideData.map((s) => s.index);
  const scored = [];
  for (const s of slideData) {
    const title = (s.title || "").toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score = 4;
    else if (title.includes(q)) score = 3;
    for (const sub of Array.isArray(s.subs) ? s.subs : []) {
      const subTitle = (sub.title || "").toLowerCase();
      if (subTitle.startsWith(q)) score = Math.max(score, 4);
      else if (subTitle.includes(q)) score = Math.max(score, 3);
    }
    if (score < 2 && ((s.section || "").toLowerCase().includes(q) || (s.subsection || "").toLowerCase().includes(q))) score = 2;
    if (score < 1 && (s.body || "").toLowerCase().includes(q)) score = 1;
    if (score < 0.5 && (s.notes || "").toLowerCase().includes(q)) score = 0.5;
    if (score > 0) scored.push({ index: s.index, score });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((x) => x.index);
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
// clickable, searchable list; expanded = scaled-thumbnail grid. Keyboard: type to filter, Up/Down
// move a highlight, Enter jumps to the highlight (or the top-ranked result) and closes, Esc closes.
// Shown/skipped markers render only when host.isPresenter and host.getStatus returns a status.
function createOverview(host) {
  let expanded = false;
  let highlight = 0;           // index into the current visible order
  let visibleOrder = [];       // { index, subIndex? } rows currently shown, in display order

  const statusGlyph = { shown: "●", skipped: "⊘", unseen: "○" };

  function build(filter, preferQueryTarget = false) {
    const list = host.listEl;
    list.replaceChildren();
    list.classList.toggle("tw-overview-grid", expanded);
    const rankedParents = rankSlides(filter || "", host.slideData);
    visibleOrder = [];
    const bySection = filter && filter.trim(); // when searching, skip section grouping (flat ranked list)
    const cur = host.getCurrentIndex();
    let curSection = null, curSub = null;
    rankedParents.forEach((index) => {
      const s = host.slideData[index];
      if (!bySection) {
        if (s.section !== curSection) {
          curSection = s.section; curSub = null;
          const head = document.createElement("button");
          head.type = "button"; head.className = "section-head";
          head.textContent = host.sectionTitleById.get(curSection) || `Section ${curSection || ""}`.trim();
          head.addEventListener("click", () => jump(index));
          list.appendChild(head);
        }
        if ((s.subsection || "") !== curSub) {
          curSub = s.subsection || "";
          if (curSub) {
            const sub = document.createElement("button");
            sub.type = "button"; sub.className = "subsection-head";
            sub.textContent = host.subsectionTitleById.get(curSub) || curSub;
            sub.addEventListener("click", () => jump(index));
            list.appendChild(sub);
          }
        }
      }
      const btn = document.createElement("button");
      const pos = visibleOrder.length;
      visibleOrder.push({ index });
      btn.type = "button";
      btn.className = "slide-link";
      btn.dataset.pos = String(pos);
      if (index === cur) btn.classList.add("current");
      const status = host.isPresenter ? host.getStatus(index) : null;
      if (status) { btn.classList.add(`tw-${status.status}`); if (status.reason) btn.title = `skipped (${status.reason})`; }
      const title = `${index + 1}. ${s.title || "(untitled)"}`;
      if (expanded) {
        const thumb = document.createElement("div");
        thumb.className = "tw-thumb";
        // A slide is position:absolute;inset:0;display:none until .active. Render the clone inside a
        // fixed deck-sized inner (the clone fills it via inset:0), force it visible+active, then
        // scale the inner down to the column width (see scaleThumbs). Iframes/videos would reload
        // per thumbnail (cost + network) — swap them for a light placeholder.
        const inner = document.createElement("div");
        inner.className = "tw-thumb-inner";
        const clone = s.el.cloneNode(true);
        clone.classList.add("active");
        clone.removeAttribute("aria-hidden");
        clone.querySelectorAll("iframe, video").forEach((m) => {
          const ph = document.createElement("div");
          ph.className = "tw-thumb-embed";
          m.replaceWith(ph);
        });
        inner.appendChild(clone);
        thumb.appendChild(inner);
        btn.appendChild(thumb);
      }
      const label = document.createElement("span");
      label.className = "slide-link-title";
      if (status) {
        const markerEl = document.createElement("span");
        markerEl.className = "tw-status";
        markerEl.setAttribute("aria-hidden", "true");
        markerEl.textContent = statusGlyph[status.status];
        label.appendChild(markerEl);
      }
      const titleEl = document.createElement("span");
      titleEl.textContent = title;
      label.appendChild(titleEl);
      btn.appendChild(label);
      btn.addEventListener("click", () => jump(index));
      list.appendChild(btn);
      // Expanded thumbnails stay parent-only: sub-slides are navigation rows, not duplicate
      // thumbnail canvases of the same compiled parent slide.
      if (!expanded) {
        for (const child of Array.isArray(s.subs) ? s.subs : []) {
          const childPos = visibleOrder.length;
          const subIndex = Number(child.subIndex) || 0;
          visibleOrder.push({ index, subIndex });
          const childBtn = document.createElement("button");
          childBtn.type = "button";
          childBtn.className = "slide-link slide-sublink";
          childBtn.dataset.pos = String(childPos);
          const childLabel = document.createElement("span");
          childLabel.className = "slide-link-title";
          childLabel.textContent = `${index + 1}.${subIndex + 1} ${child.title || "(untitled)"}`;
          childBtn.appendChild(childLabel);
          childBtn.addEventListener("click", () => jump(index, subIndex));
          list.appendChild(childBtn);
        }
      }
    });
    if (preferQueryTarget) {
      const preferred = preferredOverviewRow(filter, host.slideData, rankedParents);
      const preferredPos = preferred ? visibleOrder.findIndex((row) => row.index === preferred.index
        && row.subIndex === preferred.subIndex) : -1;
      highlight = preferredPos >= 0 ? preferredPos : 0;
    }
    highlight = clampOverviewHighlight(highlight, visibleOrder.length);
    list.querySelectorAll(".slide-link[data-pos]").forEach((row) => {
      row.classList.toggle("tw-highlight", Number(row.dataset.pos) === highlight);
    });
    // Scale each thumbnail's fixed 1280x720 inner down to its (responsive) column width — done after
    // layout so clientWidth is real (the drawer is open by the time rAF fires).
    if (expanded && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        list.querySelectorAll(".tw-thumb-inner").forEach((inner) => {
          const w = inner.parentElement && inner.parentElement.clientWidth;
          if (w) inner.style.transform = "scale(" + (w / 1280) + ")";
        });
      });
    }
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
    build(host.searchEl ? host.searchEl.value : "");
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
  function toggleExpand() { expanded = !expanded; build(host.searchEl ? host.searchEl.value : ""); }

  function open() {
    highlight = 0;
    build(host.searchEl ? host.searchEl.value : "");
    host.drawerEl.classList.add("open");
    host.searchEl?.focus();
  }
  function close() { releaseFocus(); host.drawerEl.classList.remove("open"); }
  function isOpen() { return host.drawerEl.classList.contains("open"); }
  function toggle() { isOpen() ? close() : open(); }

  host.searchEl?.addEventListener("input", () => { build(host.searchEl.value, true); });
  host.searchEl?.addEventListener("keydown", onKey);
  host.drawerEl?.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  // render() with no argument re-reads the live search value — so callers on slide change need not
  // know which drawer (standalone/presenter) is mounted.
  return { render: (f) => build(f !== undefined ? f : (host.searchEl ? host.searchEl.value : "")), open, close, toggle, isOpen, toggleExpand };
}
