// The handout home page's look (locked design 2026-10-07, "Handout 4b"): navy band, cream page, white
// cards with a thin rule, navy main buttons, cobalt accents, system sans-serif, no shadows. Colours and
// sizes are the design file's (docs/design/2026-10-07-handout-page-claude-design/); they win over the
// talk's own accent colour on this page. Everything is scoped to body.hh-mode / .handout-home, so the
// slides view, the venue page and the download file are untouched. Phone first; the band and the handout
// take two columns from 900px, the live layout from 1200px (Dominik 2026-10-08: the slide was too small
// beside the panel). The page scrolls at every width: the slides view's body{overflow:hidden} (base.css)
// is lifted here, and nothing is wider than the window.

// Icons the shared poll card has no markup for, drawn as CSS masks from inline data (no outside origin).
const mask = (paths) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E${paths}%3C/svg%3E")`
const CHECK = mask("%3Cpath d='M5 12l5 5 9-10'/%3E")
const BARS = mask("%3Cpath d='M6 20V10M12 20V4M18 20v-7'/%3E")
import { handoutTokens as T } from './handout-tokens.js'
const FONT = T.font
const MONO = T.mono

export const handoutHomeStyles = `
body.hh-mode{background:${T.page};color:${T.ink};font-family:${FONT};overflow-x:hidden;overflow-y:auto;height:auto}
body.hh-mode.hh-full-open{overflow:hidden}
body.hh-mode .share-shell,body.hh-mode .help-fab{display:none!important}
body.hh-mode .nav-panel:not(.open),body.hh-mode .notes-panel:not(.open),body.hh-mode .mynotes-panel:not(.open){box-shadow:none}
.handout-home{min-height:100vh;box-sizing:border-box;max-width:100%;overflow-x:clip;font:400 16px/1.4 ${FONT};color:${T.ink}}
.handout-home *{box-sizing:border-box}
.handout-home [hidden]{display:none!important}
.hh-sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.hh-ico{flex:none}
.hh-dot{flex:none;width:9px;height:9px;border-radius:50%;background:#b3372c}

.hh-band{background:${T.navy};color:#fff;padding:18px 16px 22px}
.hh-band-in{display:flex;flex-direction:column;gap:18px;min-width:0;max-width:640px;margin:0 auto}
.hh-band-text{display:flex;flex-direction:column;gap:18px;min-width:0}
.hh-band p{margin:0;max-width:none}
.hh-chip{display:inline-flex;align-self:flex-start;align-items:center;gap:8px;padding:6px 12px;border:1px solid rgba(255,255,255,.35);border-radius:999px;font-size:14px;line-height:1.3;color:#dfe7f7}
.hh-titles{display:flex;flex-direction:column;gap:6px;min-width:0}
.hh-event{font-size:14px;font-weight:600;color:#b9c8ea}
.hh-band h1{margin:0;max-width:none;width:auto;font-family:${FONT};font-size:30px;line-height:1.1;font-weight:700;letter-spacing:-.01em;color:#fff;text-wrap:balance;overflow-wrap:anywhere}
.hh-sub{font-size:17px;color:#dfe7f7}
.hh-speaker{font-size:15px;color:#dfe7f7}
.hh-band-actions{display:flex;flex-direction:column;gap:8px;min-width:0}
.hh-label{font-size:13px;font-weight:600;color:#b9c8ea}
.hh-btn{appearance:none;display:flex;align-items:center;justify-content:center;gap:8px;min-height:44px;margin:0;padding:0 10px;border:1px solid ${T.control};border-radius:10px;background:#fff;color:${T.navy};font:600 15px/1.2 ${FONT};text-decoration:none;cursor:pointer;touch-action:manipulation}
.hh-btn.primary{min-height:48px;gap:10px;padding:0 16px;border:0;font-size:16px}
.hh-band .hh-btn:not(.primary){background:transparent;color:#fff;border-color:rgba(255,255,255,.4)}
.hh-badge{padding:1px 8px;border-radius:999px;background:rgba(255,255,255,.18);color:#fff;font-size:12px;font-weight:600}
.hh-btn:focus-visible,.hh-row:focus-visible,.hh-pill:focus-visible{outline:3px solid ${T.cobalt};outline-offset:2px}
.hh-band .hh-btn:focus-visible{outline-color:#fff}
.handout-home[data-layout="live"] .hh-band{padding:12px 16px 14px}
.handout-home[data-layout="live"] .hh-band-in{flex-direction:row;align-items:center;gap:12px}
.handout-home[data-layout="live"] .hh-band-text{flex:1}
.handout-home[data-layout="live"] .hh-band h1{font-size:16px;line-height:1.25;font-weight:600;letter-spacing:0;text-wrap:wrap}
.hh-livenow{align-self:center;font-weight:600;white-space:nowrap}

.hh-cols{display:flex;flex-direction:column;gap:12px;max-width:672px;margin:0 auto;padding:16px 16px 32px;min-width:0}
.hh-col{display:contents}
#hhAbout,#hhCover{order:1}
#hhPrework,#hhSession{order:2}
#hhLinks{order:3}
#hhDownload{order:4}
#hhShare{order:5}
.hh-card{display:flex;flex-direction:column;gap:10px;min-width:0;padding:14px 16px;background:#fff;border:1px solid ${T.rule};border-radius:10px}
.hh-card h2{margin:0;max-width:none;width:auto;font:600 13px/1.4 ${FONT};letter-spacing:0;text-transform:none;text-wrap:wrap;color:#5c6570}
.hh-card p{margin:0;max-width:none}
.hh-list{padding:12px 16px 4px}
.hh-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.hh-tag{padding:1px 8px;border-radius:999px;background:${T.tint};color:${T.cobalt};font-size:12px;line-height:1.5;font-weight:600;white-space:nowrap}
.hh-rows{display:flex;flex-direction:column}
.hh-row{appearance:none;display:flex;align-items:center;gap:12px;width:100%;min-height:48px;margin:0;padding:6px 0;border:0;border-radius:0;background:none;color:${T.ink};font:400 16px/1.3 ${FONT};text-align:left;text-decoration:none;cursor:pointer;touch-action:manipulation}
.hh-row:not([hidden]) ~ .hh-row{border-top:1px solid ${T.ruleSoft}}
.hh-row .hh-ico{color:${T.cobalt}}
.hh-row-text{flex:1;min-width:0;overflow-wrap:anywhere}
.hh-row-detail{font-size:14px;color:${T.soft};white-space:nowrap}
.hh-facts{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:14px;color:${T.soft}}
.hh-facts span{display:flex;align-items:center;gap:6px}
.hh-cover{padding:0;gap:0;overflow:hidden}
.hh-slide{position:relative;aspect-ratio:16/9;background:#fff;overflow:hidden}
.hh-slide .stage-fit{display:block!important;position:relative;width:100%;height:100%;max-height:none!important;background:#fff;overflow:hidden}
.hh-slide .stage-fit[hidden]{display:none!important}
.hh-cover-row{display:flex;align-items:center;gap:10px;padding:8px 8px 8px 14px;border-top:1px solid ${T.rule};font-size:14px;color:${T.soft}}
.hh-cover-row span{flex:1}
.hh-pill{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px;border-radius:999px;background:${T.tint};color:${T.navy};font-size:15px;font-weight:600;text-decoration:none;white-space:nowrap}
.hh-share{flex-direction:row;align-items:center;gap:14px}
.hh-qr{flex:none;width:84px;height:84px;border-radius:8px;background:#fff}
.hh-qr svg{display:block;width:100%;height:100%}
.hh-share-text{min-width:0;font-size:14px;line-height:1.4}
.hh-share-text b{display:block;font-size:15px;font-weight:700;overflow-wrap:anywhere}
.hh-share-text span{color:${T.soft}}

.hh-live{display:flex;flex-direction:column;gap:14px;max-width:672px;margin:0 auto;padding:16px 16px 28px;min-width:0}
.hh-stagecol{display:flex;flex-direction:column;gap:12px;min-width:0}
.hh-slidebox{display:flex;flex-direction:column;gap:6px;min-width:0}
.hh-live .hh-slide{border:1px solid ${T.rule};border-radius:10px}
.hh-stepbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;min-width:0}
.hh-cap{display:flex;flex:1 1 180px;align-items:center;gap:8px;min-width:0;margin:0;max-width:none;font-size:14px;color:${T.soft}}
.hh-cap .hh-dot{width:8px;height:8px}
.hh-cap.hh-away .hh-dot{background:#9aa1a9}
.hh-cap.hh-away{color:${T.ink};font-weight:600}
.hh-steps{display:flex;align-items:center;gap:6px;margin-left:auto}
.hh-step{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:44px;min-height:44px;margin:0;padding:0 10px;border:1px solid ${T.control};border-radius:10px;background:#fff;color:${T.navy};font:600 14px/1.2 ${FONT};cursor:pointer;touch-action:manipulation}
.hh-step[hidden]{display:none!important}
.hh-step:disabled{color:#b3b8bf;border-color:#e8e5dc;cursor:default}
.hh-step:focus-visible,.hh-tospeaker:focus-visible{outline:3px solid ${T.cobalt};outline-offset:2px}
.hh-fullbtn .hh-full-on,.hh-fullbtn .hh-full-off{display:inline-flex}
.hh-fullbtn[aria-pressed="true"] .hh-full-on,.hh-fullbtn[aria-pressed="false"] .hh-full-off{display:none}
.hh-tospeaker{flex:1 0 100%;background:${T.navy};color:#fff}
.hh-rxslot{min-width:0}
.hh-rxslot:empty{display:none}
/* Full screen: the slide and its step bar fill the window, above the page (the instant slide and the
   question box still come over it). */
.hh-slidebox.hh-full{position:fixed;inset:0;z-index:54;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));background:#0b1117}
.hh-slidebox.hh-full .hh-slide{flex:1 1 auto;min-height:0;aspect-ratio:auto;border:0;border-radius:0;background:transparent}
.hh-slidebox.hh-full .hh-slide .stage-fit{background:transparent}
.hh-slidebox.hh-full .stage{background:#fff}
.hh-slidebox.hh-full .hh-cap,.hh-slidebox.hh-full .hh-cap.hh-away{color:#dfe7f7}
.hh-slidebox.hh-full .hh-step{background:transparent;color:#fff;border-color:rgba(255,255,255,.4)}
.hh-slidebox.hh-full .hh-step:disabled{color:rgba(255,255,255,.35);border-color:rgba(255,255,255,.15)}
.hh-slidebox.hh-full .hh-tospeaker{flex:0 1 auto;background:#fff;color:${T.navy}}
.hh-slidebox.hh-full .hh-step:focus-visible,.hh-slidebox.hh-full .hh-tospeaker:focus-visible{outline-color:#fff}
.hh-slide-title{display:none;margin:0;max-width:none;width:auto;font:700 26px/1.25 ${FONT};letter-spacing:0;text-wrap:wrap;overflow-wrap:anywhere;color:${T.ink}}
.hh-livecol{display:flex;flex-direction:column;gap:14px;min-width:0}

.handout-home .audience-poll-surface{position:static!important;inset:auto;display:flex;flex-direction:column;gap:10px;width:auto;min-height:0;height:auto;max-width:none;padding:16px;overflow:visible;background:#fff;border:1px solid ${T.rule};border-radius:10px;z-index:auto;place-items:initial;font-family:${FONT}}
.handout-home .audience-poll-surface[hidden]{display:none!important}
.handout-home .audience-poll-surface > .poll-card{width:100%;max-height:none;overflow:visible;padding:0;border:0;border-radius:0;box-shadow:none;background:none}
.handout-home .poll-card .ptype{display:flex;align-items:center;gap:6px;font:600 13px/1.3 ${FONT};letter-spacing:0;text-transform:none;color:${T.cobalt}}
.handout-home .poll-card .ptype::before{content:"";flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:${BARS} center/contain no-repeat;mask:${BARS} center/contain no-repeat}
/* The slides view's "back to the slides" button: here the poll sits in the page and covers nothing. */
.handout-home .poll-dismiss{display:none}
.handout-home .poll-card .pq{margin:10px 0;padding-right:0;font:700 20px/1.25 ${FONT}}
.handout-home .poll-option{gap:10px;min-height:48px;margin-bottom:10px;padding:6px 15px;border:1px solid ${T.control};border-radius:10px;font:400 16px/1.3 ${FONT};color:${T.ink}}
.handout-home .poll-option .box{flex:0 0 18px;width:18px;height:18px;border-color:#cfc9b8}
.handout-home .poll-option.sel{padding:6px 14px;border:2px solid ${T.navy};background:${T.tint};font-weight:600;color:${T.navy}}
.handout-home .poll-option.sel .box{border:0;border-radius:0;background:${T.navy};box-shadow:none;-webkit-mask:${CHECK} center/contain no-repeat;mask:${CHECK} center/contain no-repeat}
.handout-home .poll-submit{display:flex;align-items:center;justify-content:center;gap:8px;min-height:48px;margin-top:0;padding:0 16px;border-radius:10px;background:${T.navy};font:600 16px/1.2 ${FONT}}
.handout-home .poll-submit::before{content:"";flex:none;width:18px;height:18px;background:currentColor;-webkit-mask:${CHECK} center/contain no-repeat;mask:${CHECK} center/contain no-repeat}
.handout-home .poll-option:focus-within,.handout-home .poll-submit:focus-visible{outline:3px solid ${T.cobalt};outline-offset:2px}
.handout-home .poll-allowance{width:100%;padding:0;background:none;font:400 13px/1.4 ${FONT};color:${T.soft};text-align:center}
body.hh-mode .handout-home .bd-panel:not([hidden]){display:block!important;border:1px solid ${T.rule};border-radius:10px;background:#fff;overflow:hidden}
/* The board's heading (its "Board · slide N" eyebrow and the question) shows at every width. The audience-board
   styles hide it below 700px because the slides view's phone bar carries it there, and this page has no such bar. */
body.hh-mode .handout-home .bd-head{display:block!important;padding:16px 18px 6px}
body.hh-mode .handout-home .bd-eyebrow{margin:0 0 4px;font:700 11px ${MONO};letter-spacing:.1em;text-transform:uppercase;color:#5b6572}
body.hh-mode .handout-home .bd-title{margin:0;font:800 20px/1.2 ${FONT};letter-spacing:-.005em;overflow-wrap:anywhere}
/* The slides view hides its bar on a board slide (audience-board-styles.js); here it stays (Dominik 2026-10-08). */
body.hh-mode.has-bd-bar #hhLive .rx-dock:not([hidden]){display:block!important}

#hhLive .rx-dock:not([hidden]){display:block;padding:0;border:0;background:none;transform:none!important}
#hhLive .rx-dock:not([hidden])::before{content:"On this slide";display:block;margin-bottom:8px;font:600 13px/1.4 ${FONT};color:#5c6570}
#hhLive .rx-wrap{width:auto!important}
#hhLive .rx-bar{display:flex;flex-wrap:wrap;align-items:stretch;gap:0 8px;min-height:0;padding:0}
#hhLive .rx-sep,#hhLive .rx-sep[hidden]{display:block!important;flex:0 0 100%;width:auto;height:0;margin:0;background:none}
#hhLive .rx,#hhLive .rx-notebtn,#hhLive .rx-ask{border:1px solid ${T.control};border-radius:10px;background:#fff;font-family:${FONT};font-weight:600;letter-spacing:0}
#hhLive .rx{flex:1 1 0;flex-direction:column;justify-content:center;gap:4px;min-width:0;width:auto;height:auto;min-height:56px;padding:6px;font-size:13px;line-height:1.2;color:${T.ink};text-align:center;white-space:normal}
#hhLive .rx-bar .rx svg{width:18px;height:18px;color:currentColor}
#hhLive .rx[aria-pressed="true"]{border-color:${T.navy};background:${T.tint};color:${T.navy};box-shadow:inset 0 0 0 1px ${T.navy}}
#hhLive .rx .rx-tick{top:4px;right:4px;border:0;background:${T.navy}}
#hhLive .rx .rx-tick svg{width:10px;height:10px;color:#fff}
#hhLive .rx .rx-tip,#hhLive .rx-ask .rx-tip{display:none!important}
#hhLive .rx-notebtn,#hhLive .rx-ask{flex:1 1 40%;flex-direction:row;justify-content:center;gap:8px;min-width:0;width:auto;height:auto;min-height:44px;margin:8px 0 0;padding:0 10px;font-size:15px;line-height:1.2;color:${T.navy}}
#hhLive .rx-bar .rx-notebtn svg,#hhLive .rx-bar .rx-ask svg{width:18px;height:18px;color:currentColor}
#hhLive .rx:focus-visible,#hhLive .rx-notebtn:focus-visible,#hhLive .rx-ask:focus-visible{outline:3px solid ${T.cobalt};outline-offset:2px}
#hhLive .rx-note{flex:1 0 100%;margin:8px 0 0;min-height:0;font-size:14px}

@media (min-width:900px){
  .hh-band{padding:40px clamp(32px,5vw,72px)}
  .hh-band-in{display:grid;grid-template-columns:minmax(0,7fr) minmax(320px,3fr);gap:clamp(32px,3.9vw,56px);align-items:end;max-width:1296px}
  .hh-band-text{gap:24px}
  .hh-event{font-size:16px}
  .hh-band h1{font-size:clamp(38px,3.62vw,52px)}
  .hh-sub{font-size:21px}
  .hh-speaker{font-size:16px}
  .hh-band-actions{gap:10px}
  .handout-home[data-layout="live"] .hh-band{padding:16px clamp(32px,5vw,72px)}
  .handout-home[data-layout="live"] .hh-band-in{display:flex;gap:24px}
  .handout-home[data-layout="live"] .hh-band h1{font-size:20px;font-weight:700}
  .hh-cols{display:grid;grid-template-columns:minmax(0,7fr) minmax(320px,3fr);gap:clamp(32px,3.9vw,56px);align-items:start;max-width:1440px;padding:40px clamp(32px,5vw,72px) 64px}
  .hh-col{display:flex;flex-direction:column;min-width:0}
  .hh-main{gap:20px}
  .hh-side{gap:14px}
  .hh-qr{width:96px;height:96px}
}
@media (min-width:700px){
  /* One column up to 1200px: the slide as wide as the window allows, the panel below it. */
  .hh-live{max-width:960px;padding:24px 32px 40px}
}
@media (min-width:1200px){
  .hh-live{display:grid;grid-template-columns:minmax(0,1fr) clamp(320px,28vw,420px);gap:40px;align-items:start;max-width:1440px;padding:32px clamp(32px,5vw,72px) 56px}
  .hh-slide-title{display:block}
  .hh-livecol{gap:16px}
}
`
