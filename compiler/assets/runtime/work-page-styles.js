// The participant work page's look (work-files ticket 15; locked mockup section 13, `.pw` rules): a laptop
// shows the rail of steps, the step card and the ask column; a phone (760px and narrower) a top bar, the
// handout link under it, the step and the navigation at the bottom. The 0.37 answer controls
// (prework-form-answer.js, `.pw-*` classes) and closed banner are styled here too.
// Colours and type are the handout pages' own (handout-tokens.js, the set handout-home-styles.js reads): system
// sans-serif, a white card on a thin rule, navy main buttons. No serif type, no beige, no shadows.

import { handoutTokens as T } from './handout-tokens.js'

export const workPageStyles = `
:root{--wp-ink:${T.ink};--wp-soft:${T.soft};--wp-faint:${T.faint};--wp-oxford:${T.navy};--wp-oxford-soft:${T.tint};--wp-amber:${T.amber};--wp-green:${T.green};--wp-red:${T.red};
  --wp-sans:${T.font};--wp-mono:${T.mono};--wp-rule:${T.rule};--wp-rule-soft:${T.ruleSoft};--wp-control:${T.control};--wp-page:${T.page}}
html,body{margin:0;height:100%}
body{background:var(--wp-page);color:var(--wp-ink);font:15px/1.4 var(--wp-sans);-webkit-font-smoothing:antialiased}
#workPage{height:100vh;height:100dvh}
.wp,.wp *{box-sizing:border-box}
.wp{height:100%;display:flex;background:var(--wp-page);font-family:var(--wp-sans);color:var(--wp-ink);min-width:0}
:where(.wp) button{font:inherit;color:inherit;cursor:pointer;touch-action:manipulation}
.wp h1,.wp h2,.wp p{max-width:none}
.wp [hidden]{display:none!important}
.wp svg.lucide{width:16px;height:16px;stroke-width:1.9;flex:none}
.wp-ico{display:inline-flex;align-items:center;flex:none}
.wp-spacer{flex:1 1 auto}
.wp button:focus-visible,.wp a:focus-visible,.wp textarea:focus-visible,.wp input:focus-visible{outline:3px solid ${T.cobalt}55;outline-offset:2px}
/* rail */
.wp-rail{width:300px;flex:none;border-right:1px solid var(--wp-rule);background:#fff;padding:22px 18px;display:flex;flex-direction:column;gap:10px;overflow-y:auto}
.wp-eyebrow{margin:0 0 -4px;font-size:13px;font-weight:600;color:var(--wp-soft)}
.wp-talk-title{margin:0;font:700 20px/1.2 var(--wp-sans);color:var(--wp-oxford);overflow-wrap:anywhere}
.wp-runline{margin:-6px 0 0;font-size:14.5px;color:var(--wp-soft)}
.wp-railcount{margin:4px 0 0;font-size:14px;color:var(--wp-soft)}
.wp-track{height:6px;border-radius:3px;background:var(--wp-rule);overflow:hidden;flex:none}
.wp-fill{display:block;height:100%;background:var(--wp-oxford);transition:width .2s}
.wp-track.is-thin{height:4px;border-radius:0}
.wp-steps{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.wp-row{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--wp-rule);border-radius:8px;background:#fff;text-align:left;width:100%;min-height:56px}
.wp-row:hover{border-color:var(--wp-control)}
.wp-row.is-current{border-color:var(--wp-oxford);box-shadow:0 0 0 2px var(--wp-oxford-soft);background:#fff}
.wp-n{width:24px;height:24px;flex:none;border-radius:50%;background:var(--wp-rule);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:var(--wp-soft)}
.wp-row.is-current .wp-n{background:var(--wp-oxford);color:#fff}
.wp-row-body{flex:1;min-width:0;display:flex;flex-direction:column}
.wp-kind{display:flex;align-items:center;gap:5px;font-size:12.5px;color:var(--wp-soft);font-weight:700}
.wp-kind{flex-wrap:wrap;gap:2px 4px}
.wp-kind svg.lucide{width:13px;height:13px}
.wp-kind .wp-lab{margin-left:auto;padding:0 4px;gap:2px;font-size:11px;line-height:16px}
.wp-kind .wp-lab svg.lucide{width:10px;height:10px}
.wp-row-title{font-size:14.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wp-row-q{font-size:12.5px;color:var(--wp-oxford)}
.wp-state{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:12.5px;font-weight:700;color:var(--wp-faint)}
.wp-state svg.lucide{width:14px;height:14px}
.wp-state.is-done{color:var(--wp-green)}.wp-state.is-started{color:var(--wp-amber)}
.wp-handout{margin-top:auto;display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--wp-control);border-radius:8px;background:#fff;text-decoration:none;color:var(--wp-ink)}
.wp-handout-text{flex:1;min-width:0}
.wp-handout b{display:block;font-size:14.5px;color:var(--wp-oxford)}
.wp-handout small{display:block;font:11px var(--wp-mono);color:var(--wp-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wp-handout svg.lucide{color:var(--wp-oxford)}
/* centre */
.wp-center{flex:1;min-width:0;display:flex;flex-direction:column;padding:18px 26px;gap:12px}
.wp-centerhead{display:flex;align-items:center;gap:12px;font-size:14px;color:var(--wp-soft);flex:none}
.wp-stepno{font-weight:800;color:var(--wp-ink)}
.wp-keys{margin-left:auto;display:flex;align-items:center;gap:5px;font-size:13px;color:var(--wp-faint)}
.wp-cardbox{flex:1;min-height:0;background:#fff;border:1px solid var(--wp-rule);border-radius:10px;padding:20px 24px;overflow-y:auto}
.wp-content,.wp-overview,.wp-message{display:flex;flex-direction:column;gap:12px}
.wp-step-title{margin:0;font:700 24px/1.2 var(--wp-sans);overflow-wrap:anywhere}
.wp-title{margin:0;font:700 28px/1.15 var(--wp-sans);color:var(--wp-ink);overflow-wrap:anywhere}
.wp-intro{margin:0;font-size:17px;line-height:1.45;white-space:pre-line}
.wp-hint{margin:0;font-size:15px;color:var(--wp-soft);overflow-wrap:anywhere}
.wp-small{margin:0;font-size:13.5px;color:var(--wp-soft);line-height:1.4;overflow-wrap:anywhere}
.wp-q{display:flex;flex-direction:column;gap:6px}
.wp-prompt{margin:0;font-weight:700;font-size:16px}
.wp-note{margin:0;font-size:13.5px;color:var(--wp-green);display:flex;align-items:flex-start;gap:6px;line-height:1.4}
.wp-note[data-tone=error]{color:var(--wp-red)}
.wp-note[data-tone=info],.wp-note[data-tone=local]{color:var(--wp-soft)}
.wp-note[data-tone=wait]{color:var(--wp-amber)}
.wp-note svg.lucide{width:14px;height:14px;flex:none;margin-top:2px}
.wp-note b{font-weight:700}
.wp-notebox{display:flex;flex-direction:column;gap:8px}
.wp-warn{display:flex;gap:8px;align-items:flex-start;background:color-mix(in srgb,var(--wp-amber) 12%,#fff);border:1px solid color-mix(in srgb,var(--wp-amber) 30%,#fff);color:var(--wp-amber);border-radius:8px;padding:9px 11px;font-size:14px;line-height:1.4}
.wp-warn[hidden]{display:none}
.wp-warn svg.lucide{width:16px;height:16px;flex:none;margin-top:1px}
.wp-route{display:flex;gap:9px;align-items:flex-start;padding:10px 12px;border-radius:8px;font-size:14.5px;line-height:1.35}
.wp-route svg.lucide{width:18px;height:18px;flex:none;margin-top:1px}
.wp-route b{display:block;font-weight:700}
.wp-route.is-sent{background:var(--wp-oxford-soft);color:var(--wp-oxford);border:1px solid color-mix(in srgb,var(--wp-oxford) 22%,#fff)}
.wp-route.is-local{background:var(--wp-rule-soft);color:var(--wp-ink);border:1px solid var(--wp-rule)}
.wp-lab{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:12.5px;font-weight:700;padding:2px 8px;border-radius:9px;white-space:nowrap}
.wp-lab svg.lucide{width:12px;height:12px}
.wp-lab.is-sent{background:var(--wp-oxford-soft);color:var(--wp-oxford)}
.wp-lab.is-local{background:var(--wp-rule-soft);color:var(--wp-ink)}
.wp-done-text{display:flex;flex-direction:column;align-items:flex-start;text-align:left;line-height:1.2}
.wp-done[data-wp-local]{height:auto;min-height:44px;padding:8px 14px;justify-content:flex-start}
.wp-done[data-wp-local] .wp-done-hint{font-size:12.5px}
.wp-done.is-todo[data-wp-local] .wp-done-hint{color:inherit;opacity:.85}
.wp-actions{display:flex;align-items:center;gap:8px;flex:none}
.wp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:38px;padding:0 14px;border-radius:8px;border:1px solid var(--wp-control);background:#fff;font:700 15px var(--wp-sans);color:var(--wp-ink);white-space:nowrap}
.wp-btn.is-primary{background:var(--wp-oxford);border-color:var(--wp-oxford);color:#fff}
.wp-btn:disabled{opacity:.45;cursor:default}
.wp-btn.is-wide{width:100%}
.wp-done.is-todo{background:var(--wp-oxford);border-color:var(--wp-oxford);color:#fff}
.wp-done.is-done{border-color:var(--wp-green);color:var(--wp-green);background:color-mix(in srgb,var(--wp-green) 10%,#fff)}
.wp-done-hint{font-weight:400;font-size:13px;color:var(--wp-soft)}
.wp-cta{align-self:flex-start;height:44px;padding:0 18px}
.wp-link{border:0;background:transparent;color:var(--wp-oxford);font-size:14.5px;font-weight:700;text-decoration:underline;padding:0 4px;min-height:32px}
.wp-chips{display:flex;flex-wrap:wrap;gap:6px 16px;color:var(--wp-soft);font-size:14.5px}
.wp-chip{display:inline-flex;align-items:center;gap:6px}
.wp-count{margin:6px 0 0;font-size:14px;color:var(--wp-soft)}
.wp-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-radius:8px;font-size:14.5px}
.wp-banner.is-info{background:var(--wp-oxford-soft);color:var(--wp-oxford)}
.wp-banner.is-warn{background:color-mix(in srgb,var(--wp-amber) 12%,#fff);color:var(--wp-amber)}
.wp-thanks{padding:12px 14px;border:1px solid color-mix(in srgb,var(--wp-green) 35%,#fff);border-radius:8px;background:color-mix(in srgb,var(--wp-green) 10%,#fff)}
.wp-thanks p{margin:4px 0 0}
.wp-thanks-title{margin:0;display:flex;align-items:center;gap:8px;font:700 19px var(--wp-sans);color:var(--wp-green)}
.wp-loading{margin:0;color:var(--wp-soft)}
/* a step's slide */
.wp-canvas{width:100%;aspect-ratio:16/9;max-width:711px;border:1px solid var(--wp-rule);border-radius:8px;background:#fff;overflow:hidden;position:relative;flex:none}
.wp-canvas-inner{width:1280px;height:720px;transform-origin:0 0;position:absolute;left:0;top:0;container-type:size}/* the slide's cqw type resolves against this 1280px stage, as in the presenter, not the window */
.wp-canvas-inner .slide{display:block!important;position:relative!important;width:1280px!important;height:720px!important;opacity:1!important;visibility:visible!important;transform:none!important}
.wp-media{display:flex;flex-direction:column;gap:8px}
.wp-media figure{margin:0}
.wp-media img,.wp-media video{display:block;max-width:100%;height:auto;border-radius:6px}
.wp-media figcaption{font-size:13px;color:var(--wp-soft);margin-top:4px}
.wp-media .slide-embed{position:relative;width:100%;aspect-ratio:16/9;max-height:360px;border-radius:8px;overflow:hidden;background:#141c27}
.wp-media .slide-embed iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.wp-media.is-video video{width:100%;background:#141c27}
.wp-slide-text{display:flex;flex-direction:column;gap:6px;font-size:15.5px}
.wp-slide-text p{margin:0}
.wp-lines{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px}
.wp-mmd-source{white-space:pre-wrap;font:12px var(--wp-mono)}
/* answers (the 0.37 controls) */
.pw-answer{display:flex;flex-direction:column;gap:5px}
.pw-opt{display:flex;align-items:center;gap:10px;padding:7px 12px;min-height:36px;border:1px solid var(--wp-control);border-radius:8px;font-size:15px;background:#fff;text-align:left;width:100%}
.pw-opt .pw-mark{width:17px;height:17px;border-radius:50%;border:2px solid var(--wp-faint);flex:none;background:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800}
.pw-answer[data-type=multiple] .pw-mark{border-radius:4px}
.pw-opt.is-on{border-color:var(--wp-oxford);background:var(--wp-oxford-soft)}
.pw-opt.is-on .pw-mark{border-color:var(--wp-oxford);box-shadow:inset 0 0 0 3px #fff;background:var(--wp-oxford);color:#fff}
.pw-answer[data-type=ranking] .pw-opt.is-on .pw-mark{box-shadow:none}
.pw-opt-label{flex:1;min-width:0;overflow-wrap:anywhere}
.pw-text,.wp-asktext,.wp-name{width:100%;border:1px solid var(--wp-control);border-radius:8px;background:#fff;padding:8px 10px;font:14.5px/1.4 var(--wp-sans);color:var(--wp-ink)}
.pw-text{min-height:110px;resize:vertical}
.wp-asktext{height:96px;resize:vertical}
.wp-name{height:34px}
.pw-rate{display:flex;flex-direction:column;gap:6px}
.pw-rate-label{margin:0;font-weight:700}
.pw-rate-labels{display:flex;flex-wrap:wrap;gap:6px}
.pw-rate-labels .pw-opt{width:auto}
.pw-answer.is-scale .pw-rate-label{display:none}
.pw-answer.is-scale .pw-rate-labels{flex-wrap:nowrap;gap:8px}
.pw-answer.is-scale .pw-opt{flex:1;height:56px;justify-content:center;font:800 20px var(--wp-sans);color:var(--wp-soft);padding:0}
.pw-answer.is-scale .pw-opt.is-on{background:var(--wp-oxford);color:#fff}
.pw-answer.is-scale .pw-opt-label{flex:none}
.pw-answer.is-scale .pw-mark{display:none}
.wp-scale-ends{display:flex;justify-content:space-between;font-size:13.5px;color:var(--wp-soft);margin-top:2px}
.pw-restart{align-self:flex-start;border:0;background:none;color:var(--wp-oxford);text-decoration:underline;font-weight:700;padding:4px 0}
/* ask column */
.wp-askcol{width:270px;flex:none;border-left:1px solid var(--wp-rule);padding:22px 18px;display:flex;flex-direction:column;gap:10px;background:#fff;overflow-y:auto}
.wp-ask-title{margin:0;font:700 17px var(--wp-sans)}
.wp-askline{display:flex}
.wp-askcol .wp-send{height:34px}
.wp-yourq,.wp-donenote{border:1px solid var(--wp-rule);border-radius:8px;background:#fff;padding:8px 10px;display:flex;flex-direction:column;gap:3px}
.wp-yourq-head,.wp-donenote-head{margin:0;display:flex;align-items:center;gap:5px;font-weight:700;font-size:13.5px;color:var(--wp-oxford)}
.wp-donenote-head{color:var(--wp-green)}
.wp-yourq-text{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
/* the end page's list of what is still to do */
.wp-todo{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--wp-rule);border-left:4px solid var(--wp-amber);border-radius:10px;background:#fff}
.wp-todo-title{margin:0;font:700 18px var(--wp-sans)}
.wp-todo-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--wp-rule)}
.wp-todo-row .wp-row-title{white-space:normal}
.wp-todo-mark{flex:none;height:44px}
.wp.is-phone .wp-todo-row{flex-wrap:wrap}
.wp.is-phone .wp-todo-mark{width:100%}
/* closed, not yet, not available */
.wp-message{max-width:620px}
.pw-closed{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:8px;background:#fff;border:1px solid var(--wp-rule)}
.pw-closed .pw-ico svg{width:18px;height:18px;color:var(--wp-soft)}
.pw-closed-head{margin:0;font:700 18px var(--wp-sans)}
.pw-closed-line{margin:4px 0 0;color:var(--wp-soft)}
/* phone */
.wp.is-phone{flex-direction:column}
.wp-top{height:48px;flex:none;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--wp-rule);background:#fff}
.wp-top .wp-stepno{flex:1;text-align:center;font-size:15px}
.wp-tb{display:inline-flex;align-items:center;gap:3px;font-weight:700;font-size:15px;color:var(--wp-oxford);width:84px;border:0;background:none;padding:0;height:44px}
.wp-ctx{flex:none;display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--wp-rule);background:#fff;font-size:13.5px;color:var(--wp-soft)}
.wp-ctx-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wp-ctx-eyebrow{color:var(--wp-amber)}
.wp-ctx-link{display:inline-flex;align-items:center;gap:4px;font-weight:700;color:var(--wp-oxford);text-decoration:none;white-space:nowrap}
.wp-ctx-link svg.lucide{width:14px;height:14px}
.wp-body{flex:1;min-height:0;overflow-y:auto;padding:16px 16px 12px;display:flex;flex-direction:column;gap:10px;-webkit-overflow-scrolling:touch}
.wp.is-phone .wp-content{gap:10px}
.wp.is-phone .wp-step-title{font-size:22px}
.wp.is-phone .wp-hint{font-size:14.5px}
.wp.is-phone .pw-opt{padding:5px 12px;font-size:14.5px;min-height:34px}
.wp.is-phone .pw-answer.is-scale .pw-opt{height:56px;padding:0;font-size:20px}
.wp.is-phone .wp-q{gap:5px}
.wp.is-phone .wp-prompt{font-size:15px}
.wp.is-phone .wp-media img{width:100%;max-height:300px;object-fit:contain}
.wp-donetop{flex:none;display:flex}
.wp.is-phone .wp-donetop{padding:10px 12px;border-bottom:1px solid var(--wp-rule);background:#fff}
.wp-donetop .wp-btn{height:48px;padding:0 20px;font-size:16px}
.wp.is-phone .wp-donetop .wp-btn{width:100%}
.wp-nav{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px 22px;border-top:1px solid var(--wp-rule);background:#fff}
.wp-nav .wp-btn{height:44px}
.wp-nav .wp-prev{width:48px;padding:0}
.wp-nav .wp-ask{flex:1;color:var(--wp-oxford)}
.wp-nav .wp-next{min-width:80px}
.wp-sheet-wrap{position:fixed;inset:0;background:rgba(23,32,42,.35);display:flex;align-items:flex-end;z-index:20}
.wp-sheet{width:100%;background:#fff;border-radius:14px 14px 0 0;padding:16px 16px 24px;display:flex;flex-direction:column;gap:10px;max-height:90%;overflow-y:auto}
.wp-sheet-head{display:flex;align-items:center;justify-content:space-between}
.wp-x{border:0;background:none;width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center}
.wp-sent{margin:0;display:flex;align-items:center;gap:6px;font-weight:700;color:var(--wp-green)}
.wp-quote{margin:0;padding:8px 12px;border-left:3px solid var(--wp-control);white-space:pre-wrap;overflow-wrap:anywhere}
.wp-sheet-actions{display:flex;gap:8px;justify-content:flex-end}
@media (max-width:1100px) and (min-width:761px){.wp-rail{width:250px}.wp-askcol{width:230px}.wp-center{padding:16px 18px}}
`
