// The handout pages' look as one set of values (locked design 2026-10-07, "Handout 4b"): the handout home
// page (handout-home-styles.js) and the participant pre-work and post-work pages (work-page-styles.js) both
// read them, so the pages of one Run share colours, typeface and general style and cannot drift apart.
// System sans-serif only, no serif; a plain white page with white cards set off by a thin rule, navy main buttons,
// cobalt accents.

export const handoutTokens = Object.freeze({
  font: '-apple-system,system-ui,"Segoe UI",sans-serif',
  mono: 'ui-monospace,"SF Mono",Menlo,monospace',
  page: '#fff',
  ink: '#17202a',
  faint: '#9aa1a9',
  soft: '#5b6470',
  navy: '#0b3a6b',
  cobalt: '#0f4bd8',
  tint: '#e8eefc',
  rule: '#e3e2dc',
  ruleSoft: '#efece3',
  control: '#d9d6cc',
  green: '#15803d',
  amber: '#b45309',
  red: '#b3372c',
});

/** The values as CSS custom properties on :root, for stylesheets that want var(--hd-…). */
export const handoutTokenCss = `:root{--hd-font:${handoutTokens.font};--hd-mono:${handoutTokens.mono};--hd-page:${handoutTokens.page};--hd-ink:${handoutTokens.ink};--hd-soft:${handoutTokens.soft};--hd-navy:${handoutTokens.navy};--hd-cobalt:${handoutTokens.cobalt};--hd-tint:${handoutTokens.tint};--hd-rule:${handoutTokens.rule};--hd-rule-soft:${handoutTokens.ruleSoft};--hd-control:${handoutTokens.control};--hd-green:${handoutTokens.green};--hd-amber:${handoutTokens.amber};--hd-red:${handoutTokens.red}}`;
