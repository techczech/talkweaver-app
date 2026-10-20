// The participant work page as a file (work-files ticket 15; ADR-0040 decision 4): one self-contained HTML
// page for a Run's pre-work or post-work, built from the compiled, pinned work file (ticket 05, 14) and the
// phase's object on the live Worker (ticket 13). Publishing it (`…/<run>/pre-work`, `…/<run>/post-work`)
// is ticket 16; this builds the page and the headers it is served with.
//
// What holds for every page this returns:
//   - TEXT IS TEXT. Every string from the work file, the Run or the person (titles, the intro, poll labels,
//     the run line) reaches the page only inside the config line, as JSON with `<` escaped, and the runtime
//     writes it with textContent. The page's <title> is escaped here.
//   - ONLY A STEP'S SLIDE IS HTML, and only after the step sanitiser (src/shared/work-step-html.ts, through
//     the compiler's vendored bundle): every `stepHtml` passed in is sanitised again here, whoever made it,
//     and placed in an inert <template>. Poll steps (check, question) are drawn from the form, so their
//     slide is not in the page at all.
//   - NO RIGHT ANSWER. The form is the public form (publicPreworkForm); a `right` key anywhere in it, or a
//     `{right}` left in a slide, refuses the build.
//   - A CONTENT-SECURITY-POLICY, as a <meta> first in <head> and as the header for the host: scripts only
//     by the hash of the page's own inline scripts (no 'unsafe-inline', no 'unsafe-eval', no host),
//     `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, frames only from the video players the
//     compiler embeds, connections only to the Worker's origin, nothing else loaded but inlined data and
//     https pictures and video. The sanitised step HTML is the first defence, the policy the second.
//   - Mermaid (only when a step has a diagram) runs with securityLevel 'strict'.
import { createHash } from "node:crypto";
import { escapeHtml } from "./00-html.mjs";
import { mermaidVendorSource, slideFitRuntimeSource } from "./01-cli-utils.mjs";
import { workPageRuntimeSource, workPageHandoutHref } from "../../assets/runtime/work-page.js";
import { workPageStyles } from "../../assets/runtime/work-page-styles.js";
import { handoutTokens as T } from "../../assets/runtime/handout-tokens.js";
import { sanitiseWorkStepHtmlForCompiler } from "../../assets/vendor/svg-sanitiser.mjs";

/** The only hosts a frame on the page may come from: the players the compiler embeds (06-block-renderers.mjs). */
export const WORK_PAGE_FRAME_HOSTS = Object.freeze(["https://www.youtube-nocookie.com", "https://youtube-nocookie.com", "https://player.vimeo.com"]);

/** The step kinds whose slide is on the page (a poll step is drawn from the form). */
const SLIDE_KINDS = new Set(["slide", "task"]);
const PREWORK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STEP_ID = /^[a-z0-9][a-z0-9-]{0,199}$/;

/** sha256 of a script's text, as CSP names it. @param {string} text */
export function cspHash(text) {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/**
 * The page's policy. `scriptHashes` are the inline scripts' hashes (cspHash); `workerOrigin` the one
 * origin the page talks to; `header` adds what only a header can carry (frame-ancestors).
 * @param {{ scriptHashes: string[], workerOrigin: string, header?: boolean }} input
 */
export function workPageCsp({ scriptHashes, workerOrigin, header = false }) {
  if (!Array.isArray(scriptHashes) || !scriptHashes.length || scriptHashes.some((hash) => !/^'sha256-[A-Za-z0-9+/]+=*'$/.test(hash))) throw new Error("work page: script hashes are required");
  const origin = workerOriginOf(workerOrigin);
  const directives = [
    "default-src 'none'",
    `script-src ${scriptHashes.join(" ")}`,
    "style-src 'unsafe-inline'",
    "img-src data: https:",
    "media-src data: https:",
    "font-src data:",
    `connect-src ${origin}`,
    `frame-src ${WORK_PAGE_FRAME_HOSTS.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ];
  if (header) directives.push("frame-ancestors 'none'");
  return directives.join("; ");
}

function workerOriginOf(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("work page: the Worker address is not an address"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new Error("work page: the Worker address must be http(s) with no credentials");
  return url.origin;
}

/** Whether `value` holds a key that would carry a right answer, at any depth. */
function carriesRightAnswer(value) {
  if (Array.isArray(value)) return value.some(carriesRightAnswer);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, inner]) => /^(right|correct|rightAnswer|answerIndex|correctAnswer)$/i.test(key) || carriesRightAnswer(inner));
}

/** JSON safe inside a <script>: no `<` (so no `</script>` or `<!--`), no line separators. */
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const MERMAID_SCRIPT = (() => {
  const open = "<script>";
  const close = "</script>";
  const source = String(mermaidVendorSource);
  return source.startsWith(open) && source.endsWith(close) ? source.slice(open.length, -close.length) : "";
})();

const EYE_OFF = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';

/** The policy of the not-available page: it runs nothing and loads nothing but its own fonts. */
export const NOT_AVAILABLE_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * "This page is not available" (work-files ticket 17; ADR-0040 decision 9; locked mockup state 11): what an
 * unpublished Run's handout, pre-work and post-work addresses show. One fixed page, the same for every
 * address: it names nothing of the Run, carries no script, no link and no address, and asks no service.
 * @returns {{ html: string, csp: string, headers: Record<string, string> }}
 */
export function buildNotAvailablePage() {
  const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(NOT_AVAILABLE_CSP)}">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>This page is not available</title>
<link rel="icon" href="data:,">
<style>html,body{margin:0;height:100%}
body{background:${T.page};color:${T.ink};font:15px/1.4 ${T.font};-webkit-font-smoothing:antialiased;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.na{text-align:center;max-width:460px;display:flex;flex-direction:column;align-items:center;gap:12px}
.na-ico{width:64px;height:64px;border-radius:50%;background:#fff;border:1px solid ${T.rule};display:flex;align-items:center;justify-content:center;color:${T.soft}}
.na-ico svg{width:30px;height:30px}
.na h1{margin:0;font:700 30px/1.15 ${T.font};color:${T.ink}}
.na p{margin:0;font-size:17px;color:${T.soft}}
</style>
</head>
<body>
<main class="na" data-not-available>
<div class="na-ico">${EYE_OFF}</div>
<h1>This page is not available</h1>
<p>Ask the person who sent you the link.</p>
</main>
</body>
</html>
`;
  return {
    html,
    csp: NOT_AVAILABLE_CSP,
    headers: {
      "Content-Security-Policy": `${NOT_AVAILABLE_CSP}; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  };
}

/**
 * The page and its headers.
 * @param {{
 *   phase: 'pre' | 'post', preworkId: string, workerBaseUrl: string,
 *   form: { title: string, intro: string, steps: Array<{ id: string, kind: string }> },
 *   introText?: string,
 *   steps: Array<{ id: string | null, kind: string, stepHtml: string }>,
 *   styles?: string, talkTitle?: string, runLine?: string, handoutUrl?: string, preview?: boolean, previewWindow?: { opensAt: number, closesAt: number },
 * }} input
 * @returns {{ html: string, csp: string, headers: Record<string, string> }}
 */
export function buildWorkPage(input) {
  const phase = input.phase;
  if (phase !== "pre" && phase !== "post") throw new Error("work page: phase must be pre or post");
  if (!PREWORK_ID.test(String(input.preworkId || ""))) throw new Error("work page: the Worker object id is not one");
  const workerOrigin = workerOriginOf(input.workerBaseUrl);
  const workerBaseUrl = String(input.workerBaseUrl).replace(/\/+$/, "");
  const form = input.form;
  if (!form || typeof form !== "object" || !Array.isArray(form.steps) || !form.steps.length) throw new Error("work page: no form");
  if (carriesRightAnswer(form)) throw new Error("work page: the form carries a right answer");
  if (form.steps.some((step) => !STEP_ID.test(String(step && step.id)))) throw new Error("work page: a step id is not a slug");
  const handoutUrl = input.handoutUrl === undefined || input.handoutUrl === "" ? "" : workPageHandoutHref(input.handoutUrl);
  if (input.handoutUrl && !handoutUrl) throw new Error("work page: the handout link must be an http(s) address or a path on the site");

  const compiled = new Map((Array.isArray(input.steps) ? input.steps : []).filter((step) => step && typeof step.id === "string").map((step) => [step.id, step]));
  const videoSteps = [];
  const slides = [];
  for (const step of form.steps) {
    const source = compiled.get(step.id);
    if (!source) continue;
    if (source.kind === "video") videoSteps.push(step.id);
    if (!SLIDE_KINDS.has(step.kind)) continue;
    const clean = sanitiseWorkStepHtmlForCompiler(String(source.stepHtml || "")).html;
    if (/\{\s*right\s*\}/i.test(clean)) throw new Error("work page: a step still carries {right}");
    slides.push(`<div class="wf-step" data-wp-step="${escapeHtml(step.id)}">${clean}</div>`);
  }
  const hasMermaid = slides.some((html) => /\bmermaid-mm\b/.test(html));

  const config = {
    phase, preworkId: String(input.preworkId), workerBaseUrl, form,
    introText: typeof input.introText === "string" ? input.introText : String(form.intro || ""),
    talkTitle: String(input.talkTitle || ""), runLine: String(input.runLine || ""), handoutUrl, videoSteps,
    // Preview page (ticket 16): opened on the author's computer before anything is published. It asks
    // nothing of the Worker and sends nothing: the page shows as open and answers stay in the page.
    ...(input.preview === true ? { preview: true } : {}),
    // The Run's own times for that preview (epoch ms); without them the page assumes a week from now.
    ...(input.preview === true && input.previewWindow && Number.isSafeInteger(input.previewWindow.opensAt) && Number.isSafeInteger(input.previewWindow.closesAt)
      ? { previewWindow: { opensAt: input.previewWindow.opensAt, closesAt: input.previewWindow.closesAt } } : {}),
  };
  const main = `\n(function () {\n"use strict";\n${slideFitRuntimeSource}\n${workPageRuntimeSource()}\nstartWorkPage(window, ${scriptJson(config)});\n})();\n`;
  if (/<\/script/i.test(main)) throw new Error("work page: the runtime would end its own script");
  const scripts = hasMermaid && MERMAID_SCRIPT ? [MERMAID_SCRIPT, main] : [main];
  const hashes = scripts.map(cspHash);
  const csp = workPageCsp({ scriptHashes: hashes, workerOrigin });
  const header = workPageCsp({ scriptHashes: hashes, workerOrigin, header: true });

  const heading = phase === "post" ? "After the session" : "Before the session";
  const pageTitle = config.talkTitle ? `${heading} · ${config.talkTitle}` : `${heading} · ${String(form.title || "")}`;
  // The page's type is the handout's own system sans-serif (assets/runtime/handout-tokens.js): no fonts are embedded.
  // The compiler's stylesheet is the compiler's own; it may not end its <style> early.
  const deckStyles = String(input.styles || "").replace(/<\/(style)/gi, "<\\/$1");
  const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${escapeHtml(pageTitle)}</title>
<link rel="icon" href="data:,">
<style>${deckStyles}</style>
<style>${workPageStyles}</style>
</head>
<body>
<div id="workPage" data-phase="${phase}"></div>
<template id="wpSteps">${slides.join("\n")}</template>
${scripts.map((text) => `<script>${text}</script>`).join("\n")}
</body>
</html>
`;
  return {
    html,
    csp,
    headers: {
      "Content-Security-Policy": header,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  };
}
