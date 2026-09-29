// Shared talk, ticket 04: the colleague page's styles, built to
// docs/design/2026-09-28-shared-talk/LOCKED-colleague-page.html (the Margin direction). Loaded
// into the handout's <style> only when buildShareHtml is called with `sharedTalk`. Every class
// is prefixed tw-st- so the deck stylesheet and the handout chrome cannot collide with it.

export const sharedTalkStyles = String.raw`
/* ===== Shared talk: the colleague's page (LOCKED Margin) ===== */
body.tw-st { background: #fffdf2; color: #17202a; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
body.tw-st .share-shell {
  height: 100vh; height: 100dvh; min-height: 0;
  grid-template-columns: 230px minmax(0, 1fr) 400px;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  grid-template-areas: "list top rail" "list banner rail" "list stage rail" "list foot rail";
}
body.tw-st .stage-fit { grid-area: stage; margin: 22px 22px 0; background: transparent; }
body.tw-st .stage-fit[hidden] { display: none !important; }
body.tw-st .stage { background: #fdfdfb; box-shadow: 0 2px 10px #17202a14; outline: 1px solid #e3e2dc; }
body.tw-st .nav-panel:not(.open), body.tw-st .mynotes-panel:not(.open), body.tw-st .notes-panel:not(.open) { box-shadow: none; }
body.tw-st .phone-script, body.tw-st #revealBtn, body.tw-st #myNotesBtn, body.tw-st .help-fab { display: none !important; }
body.tw-st .share-footer { grid-area: foot; background: #f4f1e6; border-top: 0; padding: 12px 22px 16px; font-size: 12.5px; }
body.tw-st .share-footer #slideCount { font-weight: 700; }
.tw-st-centre-bg { grid-column: 2; grid-row: 1 / -1; background: #f4f1e6; }
.tw-st button { font-family: inherit; }
.tw-st-hidden, .tw-st-banner[hidden], .tw-st-grid[hidden], .tw-st-ghostfit[hidden], .tw-st-offline[hidden], .tw-st-field[hidden], .tw-st-send[hidden] { display: none !important; }

/* left: the slide list */
.tw-st-list { grid-area: list; min-height: 0; overflow-y: auto; border-right: 1px solid #17202a1a; padding: 16px 10px; background: #fffdf2; }
.tw-st-title { font-size: 13px; font-weight: 700; padding: 0 8px; line-height: 1.3; margin: 0; }
.tw-st-by { font-size: 11.5px; color: #5b6572; padding: 2px 8px 12px; }
.tw-st-row { display: flex; gap: 8px; align-items: baseline; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; font-size: 13px; color: #384452; text-align: left; cursor: pointer; }
.tw-st-row:hover { background: #17202a08; }
.tw-st-row .n { font: 11px ui-monospace, monospace; color: #8a9099; width: 14px; text-align: right; flex: none; }
.tw-st-row .t { min-width: 0; flex: 1; }
.tw-st-row.on { background: #17202a0d; color: #17202a; font-weight: 600; }
.tw-st-row.ghost { border: 1px dashed #0f4bd8; color: #0f4bd8; font-weight: 600; background: #e8eefc; }
.tw-st-row.ghost .n { color: #0f4bd8; }
.tw-st-marks { margin-left: auto; display: inline-flex; gap: 6px; flex: none; }
.tw-st-mk { font-size: 10.5px; font-weight: 600; white-space: nowrap; }
.tw-st-mk.sent { color: #1a7f4b; } .tw-st-mk.upd { color: #0f4bd8; font-weight: 400; } .tw-st-mk.draft { color: #0f4bd8; }
.tw-st-mk.del { color: #9f1239; } .tw-st-mk.kept { color: #92600a; }
.tw-st-sec { font: 700 9.5px ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; color: #0f4bd8; padding: 6px 8px 0 30px; }
.tw-st-foot { font-size: 11.5px; color: #5b6572; padding: 14px 8px 0; line-height: 1.45; }

/* centre: top bar, banner, grid and draft preview */
.tw-st-top { grid-area: top; display: flex; align-items: center; gap: 8px; padding: 10px 18px; font-size: 12px; color: #5b6572; border-bottom: 1px solid #17202a12; background: #fffdf2; min-height: 44px; box-sizing: border-box; }
.tw-st-live { width: 7px; height: 7px; border-radius: 50%; background: #1a7f4b; box-shadow: 0 0 0 3px #1a7f4b22; flex: none; }
.tw-st-live.off { background: #c9a44a; box-shadow: 0 0 0 3px #c9a44a22; }
.tw-st-live.stopped { background: #8a9099; box-shadow: none; }
.tw-st-viewtog { margin-left: auto; display: flex; gap: 2px; background: #17202a0d; border-radius: 6px; padding: 2px; }
.tw-st-viewtog button { font-size: 11.5px; padding: 3px 10px; border: 0; border-radius: 4px; color: #5b6572; background: transparent; display: inline-flex; gap: 5px; align-items: center; cursor: pointer; }
.tw-st-viewtog button[aria-pressed="true"] { background: #fff; color: #0f4bd8; font-weight: 600; box-shadow: 0 1px 3px #17202a1a; }
.tw-st-viewtog svg { width: 12px; height: 12px; }
.tw-st-banner { grid-area: banner; display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: #9f1239; background: #fbe9ec; border: 1px solid #f1c7d0; border-radius: 7px; padding: 7px 11px; margin: 22px 22px -10px; }
.tw-st-banner.new { color: #0f4bd8; background: #e8eefc; border-color: #c9d6f6; }
.tw-st-banner.ok { color: #1a7f4b; background: #1a7f4b12; border-color: #1a7f4b33; }
.tw-st-banner svg { width: 14px; height: 14px; flex: none; }
.tw-st-ghostfit { grid-area: stage; position: relative; overflow: hidden; margin: 22px 22px 0; min-height: 0; }
.tw-st-ghostcanvas { position: absolute; overflow: hidden; border: 2px dashed #0f4bd8; box-sizing: content-box; background: #fdfdfb; }
.tw-st-ghostinner, .tw-st-tinner { position: absolute; top: 0; left: 0; width: var(--slide-w); height: var(--slide-h); transform-origin: top left; pointer-events: none; }
.tw-st-ghostinner > .slide, .tw-st-tinner > .slide { display: grid !important; position: absolute; inset: 0; }
.tw-st-grid { grid-area: stage; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: 22px; row-gap: 30px; padding: 20px 22px; align-content: start; }
.tw-st-tile { position: relative; border-radius: 7px; padding: 6px; }
.tw-st-tile.sel { background: #fff; box-shadow: 0 0 0 2px #0f4bd8; }
.tw-st-tbtn { display: block; width: 100%; border: 0; padding: 0; background: transparent; text-align: left; cursor: pointer; font: inherit; color: inherit; }
.tw-st-canvas { position: relative; width: 100%; aspect-ratio: 16 / 9; overflow: hidden; background: #fdfdfb; border: 1px solid #e3e2dc; border-radius: 3px; box-shadow: 0 1px 5px #17202a14; }
.tw-st-tile.ghost .tw-st-canvas { border: 2px dashed #0f4bd8; box-shadow: none; }
.tw-st-tcap { display: flex; gap: 6px; align-items: baseline; margin-top: 6px; font-size: 12px; font-weight: 600; line-height: 1.3; }
.tw-st-tcap .n { font: 11px ui-monospace, monospace; color: #8a9099; flex: none; }
.tw-st-tsec { font: 700 9.5px ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; color: #0f4bd8; margin: 4px 0 0; }
.tw-st-tmarks { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 5px; min-height: 18px; }
.tw-st-tmarks .tw-st-mk { border-radius: 9px; padding: 1px 7px; }
.tw-st-tmarks .tw-st-mk.sent { background: #1a7f4b18; }
.tw-st-tmarks .tw-st-mk.draft { border: 1px dashed #0f4bd8; background: #fff; }
.tw-st-tmarks .tw-st-mk.del { background: #fbe9ec; }
.tw-st-tmarks .tw-st-mk.kept { background: #fbf3df; }
.tw-st-tmarks .tw-st-mk.upd { background: #e8eefc; font-weight: 600; }
.tw-st-slot { position: absolute; top: 0; bottom: 0; right: -22px; width: 22px; display: flex; justify-content: center; padding-top: 40px; border: 0; background: transparent; cursor: pointer; z-index: 1; }
.tw-st-slot i { position: relative; z-index: 1; width: 16px; height: 16px; border-radius: 50%; border: 1px dashed #17202a33; color: #8a9099; font: 600 12px/14px system-ui; text-align: center; font-style: normal; box-sizing: border-box; }
.tw-st-slot:hover i, .tw-st-slot:focus-visible i { background: #0f4bd8; border: 0; color: #fff; line-height: 16px; box-shadow: 0 0 0 4px #0f4bd822; }
.tw-st-slot:hover::before, .tw-st-slot:focus-visible::before { content: ""; position: absolute; top: 6px; height: 100px; left: 50%; width: 2px; margin-left: -1px; background: #0f4bd8; border-radius: 1px; }
.tw-st-slot .tip { display: none; position: absolute; top: -20px; left: 50%; transform: translateX(-50%); background: #17202a; color: #fff; font-size: 11px; font-weight: 600; padding: 4px 8px; border-radius: 5px; white-space: nowrap; z-index: 2; }
.tw-st-slot:hover .tip, .tw-st-slot:focus-visible .tip { display: block; }

/* right: the margin */
.tw-st-rail { grid-area: rail; min-height: 0; overflow-y: auto; border-left: 1px solid #17202a1a; background: #fffdf2; padding: 16px 20px 24px; box-sizing: border-box; font-size: 13px; }
.tw-st-mr-h { font: 700 10px ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; color: #5b6572; }
.tw-st-mr-t { font-size: 15px; font-weight: 700; margin-top: 3px; }
.tw-st-namef { display: flex; align-items: center; gap: 8px; margin: 12px 0 4px; font-size: 12px; color: #5b6572; }
.tw-st-namef input { flex: 1; min-width: 0; border: 1px solid #17202a22; border-radius: 6px; padding: 5px 8px; font: 12.5px system-ui; background: #fff; color: #17202a; }
.tw-st-namehint { font-size: 11px; color: #8a9099; margin-bottom: 12px; }
.tw-st-sec3 { border-top: 1px solid #17202a14; padding-top: 12px; margin-top: 12px; }
.tw-st-sec3 h3 { font-size: 12.5px; font-weight: 700; display: flex; align-items: baseline; gap: 8px; margin: 0; }
.tw-st-sec3 h3 span { font-weight: 400; color: #5b6572; font-size: 11.5px; }
.tw-st-ta { display: block; width: 100%; box-sizing: border-box; border: 1px solid #17202a22; border-radius: 7px; padding: 8px 9px; font: 13px/1.45 system-ui, -apple-system, sans-serif; background: #fff; margin-top: 7px; min-height: 52px; color: #17202a; resize: vertical; }
.tw-st-ta.note { min-height: 38px; }
.tw-st-ta.md { font: 11.5px/1.55 ui-monospace, "SF Mono", Menlo, monospace; min-height: 96px; }
.tw-st-ta:focus-visible, .tw-st-namef input:focus-visible, .tw-st-field input:focus-visible { outline: 2px solid #0f4bd855; outline-offset: 1px; }
.tw-st-row2 { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.tw-st-send { border: 0; background: #0f4bd8; color: #fff; border-radius: 7px; padding: 6px 13px; font: 700 12.5px system-ui; cursor: pointer; }
.tw-st-send:disabled { opacity: .45; cursor: default; }
.tw-st-send.ghost { background: #fff; color: #17202a; border: 1px solid #17202a22; font-weight: 600; }
.tw-st-small { font-size: 11.5px; color: #5b6572; }
.tw-st-flag { margin-top: 7px; font-size: 11.5px; color: #92600a; line-height: 1.4; }
.tw-st-link { border: 0; background: none; padding: 0; color: #0f4bd8; font: 600 12px system-ui; cursor: pointer; text-decoration: underline; margin-top: 7px; }
.tw-st-receipt { margin-top: 8px; border-left: 3px solid #1a7f4b; padding: 4px 0 4px 10px; }
.tw-st-receipt .rt { white-space: pre-wrap; overflow-wrap: anywhere; }
.tw-st-receipt .rt b { font-weight: 700; }
.tw-st-receipt .rr { font-size: 12.5px; color: #384452; margin-top: 3px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.tw-st-receipt .rm { font-size: 11px; color: #1a7f4b; font-weight: 600; margin-top: 3px; }
.tw-st-receipt.del { border-left-color: #9f1239; }
.tw-st-receipt.kept { border-left-color: #c9a44a; } .tw-st-receipt.kept .rm { color: #92600a; }
.tw-st-receipt.failed { border-left-color: #9f1239; } .tw-st-receipt.failed .rm { color: #9f1239; }
.tw-st-receipt.dismissed .rm, .tw-st-receipt.done .rm { color: #5b6572; }
.tw-st-receipt.dismissed .rt { color: #5b6572; }
.tw-st-diffcap { font-size: 11.5px; color: #5b6572; margin: 10px 0 5px; }
.tw-st-diff { font: 11px/1.45 ui-monospace, "SF Mono", Menlo, monospace; border: 1px solid #d9d0c1; border-radius: 6px; background: #fff; overflow: hidden; }
.tw-st-diff div { padding: 1px 8px 1px 22px; position: relative; white-space: pre-wrap; overflow-wrap: anywhere; min-height: 1.45em; }
.tw-st-diff div::before { position: absolute; left: 8px; top: 1px; }
.tw-st-diff .d { background: #fbe9ec; color: #9f1239; } .tw-st-diff .d::before { content: "\2212"; }
.tw-st-diff .d span { text-decoration: line-through; text-decoration-color: #9f12398c; }
.tw-st-diff .a { background: #e6f2e9; color: #166534; } .tw-st-diff .a::before { content: "+"; }
.tw-st-diff .c { color: #5d6875; }
.tw-st-rowbtn { display: flex; align-items: center; gap: 9px; width: 100%; border: 1px solid #17202a22; border-radius: 7px; padding: 7px 10px; font: 600 12.5px system-ui; color: #17202a; background: #fff; margin-top: 7px; text-align: left; cursor: pointer; }
.tw-st-rowbtn svg { width: 14px; height: 14px; color: #5b6572; flex: none; }
.tw-st-rowbtn .chev { margin-left: auto; color: #8a9099; font-weight: 400; }
.tw-st-box { border: 1px solid #0f4bd8; border-radius: 8px; padding: 10px 11px; margin-top: 8px; background: #fff; }
.tw-st-box.del { border-color: #9f1239; }
.tw-st-boxh { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 700; }
.tw-st-boxh svg { width: 14px; height: 14px; color: #0f4bd8; }
.tw-st-box.del .tw-st-boxh svg { color: #9f1239; }
.tw-st-swrow { display: flex; align-items: center; gap: 10px; margin-top: 9px; font-size: 12.5px; font-weight: 600; }
.tw-st-tog { width: 34px; height: 20px; border-radius: 10px; background: #c7cbd1; position: relative; flex: none; margin-left: auto; border: 0; padding: 0; cursor: pointer; }
.tw-st-tog::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left 120ms ease; }
.tw-st-tog[aria-checked="true"] { background: #0f4bd8; }
.tw-st-tog[aria-checked="true"]::after { left: 16px; }
.tw-st-field { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: #5b6572; }
.tw-st-field input { flex: 1; min-width: 0; border: 1px solid #17202a22; border-radius: 6px; padding: 5px 8px; font: 12.5px system-ui; background: #fff; color: #17202a; }
.tw-st-propline { margin-top: 12px; font-size: 11.5px; color: #5b6572; background: #17202a08; border-radius: 7px; padding: 7px 10px; line-height: 1.45; }
.tw-st-propline b { color: #17202a; }
.tw-st-offline { margin: 10px 0 0; background: #fbf3df; border: 1px solid #e8d6a8; color: #6b4e08; border-radius: 9px; padding: 9px 11px; font-size: 13px; line-height: 1.4; }
.tw-st-plink { display: none; }
.tw-st-phone-only { display: none; }
.tw-st-ppos { display: none; }

/* phone: the margin falls below the slide, Note first, proposals behind one row */
@media (max-width: 699px) {
  body.tw-st .share-shell { grid-template-columns: minmax(0, 1fr); }
  body.tw-st.phone-list-mode .share-shell { grid-template-areas: "plist"; grid-template-rows: minmax(0, 1fr); }
  body.tw-st.phone-list-mode .phone-list { grid-area: plist; }
  body.tw-st.phone-list-mode .tw-st-list, body.tw-st.phone-list-mode .tw-st-top, body.tw-st.phone-list-mode .tw-st-banner,
  body.tw-st.phone-list-mode .tw-st-rail, body.tw-st.phone-list-mode .tw-st-grid, body.tw-st.phone-list-mode .tw-st-ghostfit,
  body.tw-st.phone-list-mode .tw-st-centre-bg { display: none !important; }
  body.tw-st.phone-detail-mode .share-shell { height: auto; min-height: 100dvh; grid-template-rows: auto auto auto auto auto 1fr auto; grid-template-areas: "pbar" "top" "banner" "stage" "rail" "." "foot"; }
  body.tw-st.phone-detail-mode .phone-bar { grid-area: pbar; position: sticky; top: 0; z-index: 5; }
  body.tw-st .tw-st-list, body.tw-st .tw-st-grid, body.tw-st .tw-st-viewtog, body.tw-st .tw-st-centre-bg, body.tw-st .tw-st-desk-only,
  body.tw-st #phoneFull, body.tw-st .phone-bar-title { display: none !important; }
  body.tw-st .tw-st-ppos { display: inline; margin-left: auto; font: 12px ui-monospace, monospace; color: #5b6572; }
  body.tw-st .tw-st-top { border-bottom: 0; padding: 9px 16px 0; min-height: 0; font-size: 11.5px; background: transparent; }
  body.tw-st .tw-st-live { width: 6px; height: 6px; box-shadow: none; }
  body.tw-st.phone-detail-mode .stage-fit { margin: 10px 16px 0; }
  body.tw-st .tw-st-banner { margin: 10px 16px 0; }
  body.tw-st .tw-st-ghostfit { margin: 10px 16px 0; aspect-ratio: 16 / 9; }
  body.tw-st .tw-st-rail { border-left: 0; padding: 12px 16px 16px; overflow: visible; font-size: 15px; }
  body.tw-st .tw-st-phone-only { display: block; }
  body.tw-st .tw-st-ta, body.tw-st .tw-st-namef input, body.tw-st .tw-st-field input { font-size: 16px; }
  body.tw-st .tw-st-ta.note { min-height: 96px; }
  body.tw-st .tw-st-note-sec { border-top: 0; margin-top: 0; padding-top: 0; }
  body.tw-st .tw-st-note-sec h3 { display: none; }
  body.tw-st .tw-st-note-send { display: block !important; width: 100%; margin-top: 10px; }
  body.tw-st .tw-st-send, body.tw-st .tw-st-rowbtn, body.tw-st .tw-st-link, body.tw-st .tw-st-tog-wrap, body.tw-st .tw-st-namef input, body.tw-st .tw-st-field input { min-height: 44px; }
  body.tw-st .tw-st-send { padding: 12px 18px; font-size: 15px; border-radius: 10px; }
  body.tw-st .tw-st-link { display: inline-flex; align-items: center; }
  body.tw-st .tw-st-tog { width: 44px; height: 26px; border-radius: 13px; }
  body.tw-st .tw-st-tog::after { width: 22px; height: 22px; }
  body.tw-st .tw-st-tog[aria-checked="true"]::after { left: 20px; }
  body.tw-st .tw-st-name-wrap { display: none; }
  body.tw-st .tw-st-rail.name-open .tw-st-name-wrap { display: block; }
  body.tw-st .tw-st-more { display: none; }
  body.tw-st .tw-st-rail.more-open .tw-st-more { display: block; }
  body.tw-st .tw-st-plink { display: flex; justify-content: space-between; align-items: center; width: 100%; min-height: 44px; margin-top: 14px; font: 600 14px system-ui; color: #0f4bd8; border: 0; border-top: 1px solid #17202a14; background: none; padding: 12px 0 0; cursor: pointer; }
  body.tw-st .tw-st-offline { font-size: 14px; }
  body.tw-st.phone-detail-mode .share-footer { position: sticky; bottom: 0; z-index: 5; background: #fffdf2; border-top: 1px solid #17202a12; padding: 10px 16px max(16px, env(safe-area-inset-bottom)); }
  body.tw-st .share-footer > div:first-child, body.tw-st .share-actions > :not(#prevBtn):not(#nextBtn) { display: none !important; }
  body.tw-st .share-actions { width: 100%; gap: 8px; }
  body.tw-st #prevBtn, body.tw-st #nextBtn { flex: 1; justify-content: center; min-height: 44px; border-radius: 10px; font-size: 14px; }
  .tw-st-pslide-marks { display: flex; gap: 6px; margin-left: auto; }
}
@media print {
  .tw-st-list, .tw-st-top, .tw-st-banner, .tw-st-rail, .tw-st-grid, .tw-st-ghostfit, .tw-st-centre-bg { display: none !important; }
  body.tw-st .share-shell { display: block; height: auto; }
}
`
