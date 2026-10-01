// The board panel's look on the published audience page (ADR-0032; drawings round-2 F1-F14, round-3 L1, L2).

/** The panel's look: a docked stack under the slide on a phone (699px and below, the page's own
 *  breakpoint), a panel beside the slide on a laptop (700px and up). */
export const audienceBoardStyles = `
.bd-panel{display:none;background:#fdfdfb;color:#17202a;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;box-sizing:border-box;min-width:0}
.bd-panel *{box-sizing:border-box}
.bd-panel[hidden]{display:none!important}
.bd-panel svg{width:18px;height:18px;flex:none}
.bd-ico{display:inline-flex}
.bd-head{display:none}
.bd-top{padding:8px 10px 10px;border-bottom:1px solid #e3e2dc}
.bd-instr{margin:0 2px 8px}
.bd-instr[hidden]{display:none}
.bd-instr p{margin:0;font-size:14px;line-height:1.35;color:#3d4753;overflow-wrap:anywhere}
.bd-instr .bd-ex{margin-top:5px;display:flex;gap:6px;align-items:baseline;color:#5b6572}
.bd-instr .bd-ex span{flex:none;padding:1px 6px;border-radius:4px;background:#eceae4;font:600 11px/1.4 ui-monospace,"SF Mono",Menlo,monospace;text-transform:uppercase;letter-spacing:.06em;color:#3d4753}
.bd-tabs{display:flex;gap:4px;padding:3px;border-radius:11px;background:#eceae4}
.bd-tab{flex:1 1 0;min-width:0;height:44px;display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:8px;background:transparent;color:#3d4753;font:600 15px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;touch-action:manipulation;overflow:hidden;white-space:nowrap}
.bd-tab .n{font:600 12.5px/1 ui-monospace,"SF Mono",Menlo,monospace;color:#5b6572}
.bd-tab[aria-selected="true"]{background:#fff;color:#0f4bd8;box-shadow:0 1px 3px #17202a26,inset 0 0 0 1.5px #0f4bd8}
.bd-tab[aria-selected="true"] .n{color:#0f4bd8}
.bd-tab[aria-disabled="true"]{opacity:.5;cursor:default}
.bd-tab:focus-visible,.bd-send:focus-visible,.bd-ask:focus-visible,.bd-cancel:focus-visible,.bd-ic:focus-visible,.bd-text:focus-visible{outline:3px solid #0f4bd855;outline-offset:2px}
.bd-to{display:flex;align-items:center;gap:6px;margin:9px 2px 6px;font-size:13px;color:#5b6572}
.bd-to[hidden],.bd-compose[hidden],.bd-keys[hidden],.bd-cards-left[hidden],.bd-state[hidden],.bd-cancel[hidden],.bd-ask[hidden]{display:none}
.bd-to-text{min-width:0;overflow-wrap:anywhere}
.bd-to b{color:#17202a}
.bd-left{margin-left:auto;white-space:nowrap;font:500 12.5px/1 ui-monospace,"SF Mono",Menlo,monospace;color:#5b6572}
.bd-cancel{margin-left:auto;min-height:32px;padding:0 10px;border:1px solid #c9ced4;border-radius:8px;background:#fff;color:#17202a;font:600 13px/1 system-ui,sans-serif;cursor:pointer}
.bd-cancel+.bd-left{margin-left:8px}
.bd-compose{display:flex;align-items:stretch;gap:8px}
.bd-text{flex:1 1 auto;min-width:0;min-height:50px;padding:9px 11px;border:1.5px solid #0f4bd8;border-radius:10px;background:#fff;color:#17202a;font:400 16px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;resize:none}
.bd-text::placeholder{color:#8a939d}
.bd-compose.is-full .bd-text{border-color:#b45309}
.bd-send{flex:none;width:76px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:0;border-radius:10px;background:#0f4bd8;color:#fff;font:600 13px/1 system-ui,sans-serif;cursor:pointer;touch-action:manipulation}
.bd-send:disabled{background:#c9ced4;cursor:default}
.bd-send svg{width:20px;height:20px}
.bd-keys{display:none;margin:0;font-size:12.5px;color:#5b6572}
.bd-cards-left{margin:6px 2px 0;font:500 12.5px/1.2 ui-monospace,"SF Mono",Menlo,monospace;color:#5b6572}
.bd-note{display:flex;align-items:center;gap:7px;margin-top:8px;padding:8px 10px;border-radius:8px;background:#e7f5ec;color:#14532d;font-size:14px;line-height:1.3}
.bd-note:empty{display:none}
.bd-note svg{color:#15803d}
.bd-note.offline{background:#fff4e0;color:#7c2d12}
.bd-note.offline svg{color:#b45309}
.bd-note.sending{background:#eceae4;color:#3d4753}
.bd-note.failed{background:#fbe9e7;color:#8c2a20}
.bd-note.failed svg{color:#8c2a20}
.bd-state{display:flex;align-items:flex-start;gap:9px;margin-top:9px;padding:11px 12px;border-radius:10px;background:#eceae4;color:#3d4753;font-size:14.5px;line-height:1.35}
.bd-state b{display:block;color:#17202a}
.bd-state svg{margin-top:1px;color:#5b6572}
.bd-ask{display:flex;align-items:center;gap:7px;width:100%;min-height:44px;margin-top:6px;padding:0 4px;border:0;background:none;color:#3d4753;font:500 14px/1.2 system-ui,sans-serif;text-align:left;cursor:pointer}
.bd-ask b{color:#0f4bd8;font-weight:600}
.bd-read{padding:10px 10px 24px}
.bd-yours{display:flex;align-items:flex-start;gap:8px;margin:0 0 8px;padding:7px 10px;border:1px solid #bfd0f6;border-radius:8px;background:#e8eefc;font-size:13px;color:#0b3a9e}
.bd-yours svg{margin-top:1px}
.bd-read-head{display:flex;align-items:baseline;gap:8px;margin:2px 0 10px}
.bd-read-head h3{margin:0;font:700 19px/1.2 system-ui,sans-serif;overflow-wrap:anywhere}
.bd-read-head span{font-size:13.5px;color:#5b6572}
.bd-cards{display:flex;flex-direction:column;gap:7px}
.bd-card{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:8px;padding:10px 12px;border:1px solid #e3e2dc;border-radius:9px;background:#fff;font-size:16px;line-height:1.35}
.bd-card.is-group{grid-template-columns:26px minmax(0,1fr) auto;background:#fcece3;border-color:transparent}
.bd-card .num{font:700 14px/1.5 ui-monospace,"SF Mono",Menlo,monospace;color:#c2410c}
.bd-card-text{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.bd-card .x{padding:1px 7px;border-radius:10px;background:#c2410c;color:#fff;font:700 12.5px/1.5 ui-monospace,"SF Mono",Menlo,monospace}
.bd-card.is-mine{border-color:#0f4bd8;box-shadow:inset 3px 0 0 #0f4bd8}
.bd-card.is-mine:not(.is-sorted):not(.is-sending){cursor:pointer}
.bd-card.is-sending{border-style:dashed;border-color:#b45309}
.bd-card.is-going{opacity:.5}
.bd-card.is-editing{background:#e8eefc}
.bd-mine{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:10px;background:#e8eefc;color:#0f4bd8;font:600 12px/1.4 system-ui,sans-serif;white-space:nowrap}
.bd-mine svg{width:13px;height:13px}
.bd-mine.sending{background:#fff4e0;color:#7c2d12}
.bd-acts{display:inline-flex;align-items:center;gap:4px}
.bd-ic{display:none;place-items:center;width:36px;height:36px;padding:0;border:1px solid #d5d9de;border-radius:7px;background:#fff;color:#3d4753;cursor:pointer}
.bd-ic.danger{color:#b42318}
.bd-ic svg{width:15px;height:15px}
.bd-sheet-scrim{position:fixed;inset:0;z-index:2147483000;background:#17202a66;display:flex;align-items:flex-end}
.bd-sheet{width:100%;padding:8px 16px 20px;background:#fdfdfb;border-radius:16px 16px 0 0;box-shadow:0 -10px 30px #17202a33;font-family:system-ui,-apple-system,sans-serif;color:#17202a}
.bd-sheet svg{width:18px;height:18px;flex:none}
.bd-grip{width:40px;height:4px;margin:4px auto 8px;border-radius:2px;background:#d5d9de}
.bd-sheet-k{display:flex;align-items:center;gap:6px;margin:8px 0 4px;font-size:13.5px;color:#0f4bd8;font-weight:600}
.bd-sheet-t{margin:0 0 12px;font-size:17px;line-height:1.35;font-weight:600;overflow-wrap:anywhere}
.bd-sheet-b{display:flex;align-items:center;gap:10px;width:100%;min-height:50px;margin-top:6px;padding:0 14px;border:1px solid #d5d9de;border-radius:11px;background:#fff;color:#17202a;font:600 16px/1 system-ui,sans-serif;cursor:pointer}
.bd-sheet-b.danger{color:#b42318}
.bd-sheet-b.plain{justify-content:center;border:0;background:#eceae4}
.bd-sheet-n{margin:10px 2px 4px;font-size:13.5px;line-height:1.4;color:#5b6572}

/* Phone: the panel takes the row under the slide; it scrolls as a whole when the screen is short. */
@media (max-width:699px){
  body.phone-detail-mode.has-bd-bar .share-shell{grid-template-rows:auto auto minmax(0,1fr) auto}
  body.phone-detail-mode.has-bd-bar .phone-script{display:none}
  body.phone-detail-mode .bd-panel:not([hidden]){display:block;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;border-top:1px solid #e3e2dc}
  body.phone-list-mode .bd-panel{display:none!important}
  .bd-top{border-bottom:1px solid #e3e2dc}
}

/* Laptop: the slide at the left, the panel at the right (400px; 380 at 1280 and below). */
@media (min-width:700px){
  body.has-bd-bar .share-shell{grid-template-columns:minmax(0,1fr) var(--bd-w,400px);grid-template-rows:minmax(0,1fr) auto}
  body.has-bd-bar .stage-fit{grid-column:1;grid-row:1}
  body.has-bd-bar .rx-dock{display:none!important}
  body.has-bd-bar .share-footer{grid-column:1/-1;grid-row:2}
  .bd-panel:not([hidden]){grid-column:2;grid-row:1;display:flex;flex-direction:column;min-height:0;border-left:1px solid #e3e2dc}
  .bd-head{display:block;padding:16px 18px 6px}
  .bd-eyebrow{margin:0 0 4px;font:700 11px ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:#5b6572}
  .bd-title{margin:0;font:800 20px/1.2 system-ui,sans-serif;letter-spacing:-.005em;overflow-wrap:anywhere}
  .bd-top{flex:none;padding:6px 18px 12px}
  .bd-tab{height:38px;font-size:14.5px}
  .bd-to{font-size:13px}
  .bd-text{min-height:74px}
  .bd-send{width:auto;flex-direction:row;height:38px;padding:0 16px;gap:7px;font-size:14.5px}
  .bd-compose{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px}
  .bd-text{grid-column:1/-1}
  .bd-keys{display:block}
  .bd-ic{display:grid}
  .bd-read{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 18px 16px}
  .bd-card{font-size:14.5px;padding:8px 11px}
  .bd-read-head h3{font-size:17px}
  .bd-cards{gap:6px}
  .bd-ask{padding:0 2px}
}
@media (min-width:700px) and (max-width:1300px){
  body.has-bd-bar .share-shell{--bd-w:380px}
}
@media print{.bd-panel,.bd-sheet-scrim{display:none!important}}
`

