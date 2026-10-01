// The pre-work form's look on the published handout (ADR-0032 amendment; drawings round-2 W1-W12,
// round-3 L3-L5): a phone stacks one step per screen with a bottom bar; a laptop (700px and up, the
// page's own breakpoint) shows the steps, the step and "Ask about this" in three columns.

export const preworkFormStyles = `
body.pw-open{overflow:hidden}
.pw-app{position:fixed;inset:0;z-index:950;background:#fdfdfb;color:#17202a;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;box-sizing:border-box;min-width:0}
.pw-app[hidden]{display:none!important}
.pw-app *{box-sizing:border-box}
.pw-app svg{width:18px;height:18px;flex:none}
.pw-ico{display:inline-flex;align-items:center;flex:none}
.pw-loading{margin:40px 20px;color:#5b6572;font-size:16px}
.pw-scroll{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch}
.pw-app button{font-family:inherit;touch-action:manipulation}
.pw-app button:focus-visible,.pw-app textarea:focus-visible,.pw-app input:focus-visible{outline:3px solid #0f4bd855;outline-offset:2px}
.pw-app [hidden]{display:none!important}
.pw-spacer{flex:1 1 auto}
.pw-small{margin:0;font-size:13.5px;line-height:1.4;color:#5b6572;overflow-wrap:anywhere}
.pw-hint{margin:10px 0 0;font-size:15px;line-height:1.5;color:#3d4753}
.pw-talk-title{margin:0;font-size:18px;font-weight:700;line-height:1.25;overflow-wrap:anywhere}
.pw-count{margin:0;font-size:15px;color:#17202a;white-space:nowrap}
.pw-track{flex:1 1 auto;min-width:40px;height:8px;border-radius:99px;background:#e3e2dc;overflow:hidden}
.pw-fill{display:block;height:100%;background:#0f4bd8;border-radius:99px;transition:width .2s}
.pw-track.pw-thin{flex:none;width:100%;height:5px;border-radius:0}
.pw-primary{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 18px;border:0;border-radius:12px;background:#0f4bd8;color:#fff;font-size:18px;font-weight:700;cursor:pointer}
.pw-primary:disabled{background:#c9ced4;cursor:default}
.pw-secondary{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 16px;border:1.5px solid #c9ced4;border-radius:12px;background:#fff;color:#17202a;font-size:16px;font-weight:600;cursor:pointer}
.pw-link{border:0;background:transparent;color:#0f4bd8;font-size:14px;font-weight:600;text-decoration:underline;cursor:pointer;min-height:44px;padding:0 6px}
.pw-cta{width:100%}
.pw-state{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:14px;color:#5b6572}
.pw-state-done{color:#15803d;font-weight:600}
.pw-state-started{color:#b45309;font-weight:600}
.pw-kind{display:inline-flex;align-items:center;gap:6px;font-size:14px;color:#5b6572}
.pw-kind svg{width:16px;height:16px}
.pw-banner{display:flex;align-items:center;gap:10px;margin:0 0 14px;padding:12px 14px;border-radius:12px;font-size:15px;line-height:1.4}
.pw-banner-info{background:#e8eefb;color:#0b3aa8}
.pw-banner-warn{background:#fdf1e3;color:#8a4b06;flex-wrap:wrap}
.pw-title{max-width:none;margin:0 0 10px;font-size:32px;line-height:1.1;letter-spacing:-.02em}
.pw-intro{margin:0 0 14px;font-size:19px;line-height:1.45}
.pw-chips{display:flex;flex-wrap:wrap;gap:8px 18px;margin:0 0 18px;color:#5b6572;font-size:15px}
.pw-chip{display:inline-flex;align-items:center;gap:7px}
.pw-h2{margin:22px 0 10px;font-size:18px}
.pw-steps{display:block;border:1px solid #e3e2dc;border-radius:14px;background:#fff;overflow:hidden}
.pw-row{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:start;gap:0 10px;width:100%;padding:12px 14px;border:0;border-bottom:1px solid #e3e2dc;background:transparent;text-align:left;color:inherit;cursor:pointer}
.pw-row:last-child{border-bottom:0}
.pw-row.is-current{background:#e8eefb;box-shadow:inset 3px 0 0 #0f4bd8}
.pw-row.is-current .pw-row-title{color:#0b3aa8}
.pw-n{font-size:15px;font-weight:600;color:#3d4753;padding-top:2px}
.pw-row-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.pw-row-title{font-size:17px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.pw-row-q{display:inline-flex;align-items:center;gap:6px;margin-top:6px;font-size:14px;color:#0f4bd8}
.pw-thanks{margin:0 0 20px;padding:18px;border-radius:14px;background:#e6f2ea;color:#14532d}
.pw-thanks-title{max-width:none;display:flex;align-items:center;gap:10px;margin:0 0 8px;font-size:26px;line-height:1.15}
.pw-thanks-title svg{width:30px;height:30px}
.pw-thanks p{margin:0;font-size:17px;line-height:1.5}
/* phone: the overview */
.pw-app[data-mode="phone"] .pw-overview{padding:0 0 32px}
.pw-talkbar{padding:14px 18px 10px;border-bottom:1px solid #e3e2dc}
.pw-talkbar .pw-talk-title{font-size:20px}
.pw-meter{display:flex;align-items:center;gap:12px;padding:10px 18px;border-bottom:1px solid #e3e2dc;font-size:15px;color:#3d4753}
.pw-closes{white-space:nowrap}
.pw-app[data-mode="phone"] .pw-main{padding:18px 18px 0}
/* laptop: the overview is two columns */
.pw-overview.is-wide{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:0 22px;max-width:960px;margin:0 auto;padding:18px 20px 40px;align-items:start}
.pw-app[data-mode="laptop"]{background:#f4f3ee}
.pw-overview.is-wide .pw-title{font-size:28px}
.pw-overview.is-wide .pw-intro{font-size:16px}
.pw-overview.is-wide .pw-banner{font-size:13.5px;padding:8px 12px}
.pw-overview.is-wide .pw-row{padding:10px 16px}
.pw-overview.is-wide .pw-row-title{font-size:16px}
.pw-side{display:flex;flex-direction:column;gap:12px;position:sticky;top:18px}
.pw-card{padding:14px 16px;border:1px solid #e3e2dc;border-radius:12px;background:#fff;display:flex;flex-direction:column;gap:8px}
.pw-side .pw-cta{font-size:16px;min-height:46px}
/* a step, on a phone */
.pw-stepview{position:absolute;inset:0;display:flex;flex-direction:column;background:#fdfdfb}
.pw-app .pw-scroll:has(.pw-stepview){overflow:hidden}
.pw-top{display:flex;align-items:center;gap:10px;padding:8px 12px;flex:none}
.pw-top-btn{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 12px;border:1px solid #e3e2dc;background:#fff;font-size:15px;font-weight:600;color:#17202a;white-space:nowrap;cursor:pointer}
.pw-top-btn svg{width:16px;height:16px}
.pw-stepno{font-size:16px;font-weight:700;white-space:nowrap}
.pw-top .pw-stepno{margin-right:auto;font-size:15px}
.pw-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 0 16px;-webkit-overflow-scrolling:touch}
.pw-body>.pw-content{padding:0}
.pw-body>.pw-donenote,.pw-body>.pw-yourq{margin:12px 16px 0}
.pw-canvas{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;background:#fff}
.pw-inner{position:absolute;top:0;left:0;width:1280px;height:720px;transform-origin:top left;pointer-events:none}
.pw-inner>.slide{display:grid!important;position:absolute;inset:0}
.pw-stephead{padding:16px 16px 0}
.pw-stephead .pw-kind{font-size:17px;font-weight:700;color:#5b6572}
.pw-stephead .pw-kind svg{width:22px;height:22px}
.pw-step-title{max-width:none;margin:12px 0 0;font-size:26px;line-height:1.15;letter-spacing:-.01em;overflow-wrap:anywhere}
.pw-lines{margin:14px 16px 0;padding:0 0 0 22px;font-size:20px;line-height:1.4}
.pw-lines li{margin:0 0 10px;padding-left:2px;overflow-wrap:anywhere}
.pw-lines li.is-para{list-style:none;margin-left:-22px;color:#3d4753}
.pw-lines li::marker{color:#0f4bd8}
.pw-content>.pw-hint,.pw-content>.pw-note,.pw-content>.pw-pollintro,.pw-content>.pw-answer{margin-left:16px;margin-right:16px}
.pw-pollintro .pw-hint{font-size:18px;color:#5b6572;margin-top:12px}
.pw-prompt{margin:12px 0 0;font-size:18px;line-height:1.4}
.pw-answer{display:flex;flex-direction:column;gap:10px;margin-top:16px}
.pw-opt{display:flex;align-items:center;gap:12px;width:100%;min-height:52px;padding:10px 14px;border:1.5px solid #d8d7d0;border-radius:12px;background:#fff;color:#17202a;font-size:18px;text-align:left;cursor:pointer}
.pw-opt-label{min-width:0;overflow-wrap:anywhere}
.pw-mark{flex:none;width:24px;height:24px;border:2px solid #8a939d;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff}
.pw-answer[data-type="multiple"] .pw-mark{border-radius:6px}
.pw-opt.is-on{border-color:#0f4bd8;background:#e8eefb;color:#0b3aa8;font-weight:600}
.pw-opt.is-on .pw-mark{border-color:#0f4bd8;background:#0f4bd8;box-shadow:inset 0 0 0 4px #e8eefb}
.pw-answer[data-type="multiple"] .pw-opt.is-on .pw-mark,.pw-answer[data-type="ranking"] .pw-opt.is-on .pw-mark{box-shadow:none}
.pw-rate{display:flex;flex-direction:column;gap:6px}
.pw-rate-label{margin:0;font-size:17px;font-weight:600}
.pw-rate-labels{display:flex;flex-wrap:wrap;gap:8px}
.pw-opt-small{width:auto;min-height:44px;font-size:16px;padding:8px 14px}
.pw-restart{align-self:flex-start}
.pw-text{display:block;width:100%;min-height:96px;padding:11px 13px;border:1.5px solid #0f4bd8;border-radius:12px;background:#fff;color:#17202a;font:400 18px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;resize:vertical}
.pw-note{display:flex;align-items:flex-start;gap:10px;margin-top:16px;padding:14px 16px;border-radius:12px;background:#ebe9e3;color:#3d4753;font-size:17px;line-height:1.45}
.pw-note[data-tone="error"]{background:#fdf1e3;color:#8a4b06}
.pw-donenote{padding:14px 16px;border-radius:12px;background:#e6f2ea;color:#14532d;font-size:16px;line-height:1.45}
.pw-donenote p{margin:0}
.pw-donenote-head{display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:4px!important;font-size:17px}
.pw-yourq{padding:14px 16px;border-radius:12px;background:#e8eefb;color:#17202a}
.pw-yourq-head{display:flex;align-items:center;gap:8px;margin:0 0 4px;font-weight:700;color:#0b3aa8}
.pw-yourq-text{margin:0 0 4px;font-size:17px;line-height:1.4;overflow-wrap:anywhere}
.pw-foot{flex:none;padding:10px 12px 12px;border-top:1px solid #e3e2dc;background:#fdfdfb;display:flex;flex-direction:column;gap:10px}
.pw-nav{display:flex;gap:8px;align-items:stretch}
.pw-prev{flex:none;width:48px;min-height:48px;display:inline-flex;align-items:center;justify-content:center;border:1.5px solid #d8d7d0;border-radius:12px;background:#fff;color:#17202a;cursor:pointer}
.pw-prev:disabled{opacity:.45}
.pw-ask{flex:1 1 auto;min-width:0;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:48px;padding:0 8px;border:1.5px solid #0f4bd8;border-radius:12px;background:#fff;color:#0f4bd8;font-size:16px;font-weight:700;white-space:nowrap;cursor:pointer}
.pw-next{flex:none;padding:0 14px;font-size:17px}
.pw-done{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:52px;border:1.5px solid #15803d;border-radius:12px;background:#15803d;color:#fff;font-size:18px;font-weight:700;cursor:pointer}
.pw-done.is-done{background:#e6f2ea;color:#14532d}
.pw-done-hint{font-size:15px;font-weight:500;color:#3d6b50}
/* the phone's ask sheet */
.pw-sheet-wrap{position:absolute;inset:0;z-index:5;background:#17202a66;display:flex;align-items:flex-end}
.pw-sheet{width:100%;max-height:92%;overflow-y:auto;padding:8px 16px 18px;border-radius:20px 20px 0 0;background:#fdfdfb;box-shadow:0 -8px 30px #17202a33}
.pw-grip{display:block;width:44px;height:5px;border-radius:99px;background:#d8d7d0;margin:4px auto 10px}
.pw-sheet-head{display:flex;align-items:center;justify-content:space-between;margin:6px 0 12px}
.pw-sheet-title{margin:0;font-size:24px}
.pw-x{width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:#17202a;cursor:pointer}
.pw-x svg{width:24px;height:24px}
.pw-about{display:flex;align-items:center;gap:8px;margin:0 0 14px;padding:10px 12px;border-radius:10px;background:#e8eefb;color:#0b3aa8;font-size:16px;min-width:0}
.pw-about b{white-space:nowrap}
.pw-about span:last-child{color:#17202a;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pw-label{display:block;margin:0 0 12px;font-size:16px;font-weight:700}
.pw-label .pw-text,.pw-label .pw-name{margin-top:8px;font-weight:400}
.pw-name{display:block;min-width:0;height:44px;padding:0 12px;border:1.5px solid #c9ced4;border-radius:10px;background:#fff;color:#17202a;font:400 16px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif}
.pw-name-block{width:100%;height:52px;border-radius:12px;font-size:18px}
.pw-privacy{display:flex;gap:10px;align-items:flex-start;margin:0 0 14px;font-size:16px;line-height:1.4;color:#3d4753}
.pw-send-wide{width:100%}
.pw-sent{display:flex;align-items:center;gap:12px;margin:8px 0 14px;font-size:24px;font-weight:700}
.pw-sent svg{width:32px;height:32px;color:#15803d}
.pw-quote{margin:0 0 12px;padding:12px 14px;border-left:4px solid #0f4bd8;background:#fff;font-size:18px;line-height:1.4;overflow-wrap:anywhere}
.pw-sheet-actions{display:flex;gap:10px;margin-top:16px}
.pw-sheet-actions>*{flex:1 1 0}
/* full screen */
.pw-fsview{position:fixed;inset:0;z-index:20;background:#0b1220}
.pw-fsinner{position:absolute;left:50%;top:50%;width:1280px;height:720px;transform-origin:center;background:#fff}
.pw-fsinner>.slide{display:grid!important;position:absolute;inset:0}
.pw-fsclose{position:absolute;top:10px;right:10px;width:48px;height:48px;border:0;border-radius:50%;background:#ffffffdd;color:#17202a;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
/* a step, on a laptop: steps, the step, ask about this */
.pw-stepview.is-wide{display:grid;grid-template-columns:300px minmax(0,1fr) 300px;background:#f4f3ee}
.pw-rail{overflow-y:auto;padding:14px 12px 24px 18px;background:#fdfdfb;border-right:1px solid #e3e2dc;display:flex;flex-direction:column;gap:6px}
.pw-railcount{margin:0;font-size:13.5px;color:#3d4753}
.pw-rail .pw-track{flex:none;width:100%;margin:2px 0 8px}
.pw-rail .pw-steps{border:0;border-radius:0;background:transparent;overflow:visible}
.pw-rail .pw-row{grid-template-columns:22px minmax(0,1fr) auto;padding:8px 8px 8px 6px;border-bottom:0;border-radius:8px}
.pw-rail .pw-row-title{font-size:14px;font-weight:600}
.pw-rail .pw-kind{font-size:12px}
.pw-rail .pw-kind svg{width:13px;height:13px}
.pw-rail .pw-n{font-size:13px}
.pw-rail .pw-state{font-size:12px}
.pw-rail .pw-state-todo span:last-child{display:none}
.pw-center{overflow-y:auto;padding:14px 26px 24px;min-width:0}
.pw-centerhead{display:flex;align-items:center;gap:12px;margin:0 0 10px;font-size:14px;color:#5b6572}
.pw-centerhead .pw-stepno{font-size:14px}
.pw-keys{display:inline-flex;align-items:center;gap:6px;font-size:13px}
.pw-cardbox{border:1px solid #e3e2dc;border-radius:12px;background:#fff;overflow:hidden;box-shadow:0 1px 3px #17202a14}
.pw-cardbox .pw-canvas{border-radius:0}
.pw-cardbox .pw-note,.pw-cardbox .pw-pollintro,.pw-cardbox .pw-answer{margin-left:22px;margin-right:22px}
.pw-cardbox .pw-stephead{padding:18px 22px 0}
.pw-cardbox .pw-step-title{font-size:26px;margin-top:8px}
.pw-cardbox .pw-pollintro .pw-hint{font-size:15px;margin-top:6px}
.pw-cardbox .pw-answer{margin-top:14px;gap:8px}
.pw-cardbox .pw-opt{min-height:50px;font-size:16px}
.pw-cardbox .pw-note{margin-top:14px;margin-bottom:22px;font-size:15px;padding:12px 14px}
.pw-cardbox .pw-text{margin-bottom:22px;width:auto;max-width:100%}
.pw-actions{display:flex;align-items:center;gap:10px;margin-top:12px}
.pw-actions .pw-done{width:auto;min-height:44px;padding:0 16px;font-size:15px}
.pw-actions .pw-prev{width:auto;min-height:44px;padding:0 16px;gap:6px;font-size:15px;font-weight:600}
.pw-actions .pw-next{min-height:44px;font-size:15px;min-width:0;padding:0 16px}
.pw-actions .pw-done-hint{font-size:13.5px}
.pw-askcol{overflow-y:auto;padding:16px 18px;background:#fdfdfb;border-left:1px solid #e3e2dc;display:flex;flex-direction:column;gap:10px}
.pw-ask-title{margin:0;font-size:15px}
.pw-askcol .pw-yourq,.pw-askcol .pw-donenote{font-size:13.5px;padding:10px 12px}
.pw-askcol .pw-yourq-text{font-size:14px}
.pw-askcol .pw-donenote-head{font-size:13.5px}
.pw-asktext{min-height:88px;font-size:14px;border-color:#c9ced4}
.pw-askline{display:flex;align-items:center;gap:8px;color:#5b6572}
.pw-askline .pw-name{flex:1 1 auto;height:38px;font-size:14px}
.pw-send{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:0 14px;border:0;border-radius:10px;background:#0f4bd8;color:#fff;font-size:14px;font-weight:700;cursor:pointer}
.pw-send:disabled{background:#c9ced4;color:#fff;cursor:default}
/* closed: the banner over the slide list (W12) */
.pw-closed-host{margin:0}
.pw-closed{display:flex;gap:12px;align-items:flex-start;margin:14px 14px 10px;padding:14px 16px;border-radius:12px;background:#ebe9e3;color:#17202a;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.pw-closed .pw-ico svg{width:24px;height:24px;margin-top:2px}
.pw-closed p{margin:0}
.pw-closed-head{font-size:18px;font-weight:700}
.pw-closed-line{font-size:16px;line-height:1.45;color:#3d4753}
.pw-closed-top{display:block}
@media (max-width:699px){.pw-closed-top{display:none!important}}
@media (min-width:700px){.pw-closed-list{display:none!important}}
body.pw-closed-page .share-shell{min-height:calc(100vh - 90px)}
@media (max-width:699px){body.pw-closed-page .share-shell{min-height:0}}
@media (max-width:360px){.pw-title{font-size:28px}.pw-thanks-title{font-size:22px}}
`
