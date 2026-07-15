// Reference outline assembly — the ONE outline every Reference fixture compiles into.
//
// FOR ME (agent-facing). Extracted so two callers share it verbatim and can never drift:
//   1. scripts/build-reference-deck.mjs — the self-verifying source-beside-render gallery.
//   2. TalkWeaver's layout:preview-thumbnails handler — renders one thumbnail per fixture for the
//      "/" layout picker, reusing the app's offscreen render path.
// Each group is a `##` section; every fixture markdown drops in verbatim (its {id=…} survives so a
// compiled slide can be matched back to its fixture). fixtures-assets must sit beside the outline
// as assets/ so relative image refs resolve.

import { fixtures, groups } from "./fixtures.mjs";

/** Assemble all fixtures into one outline string (frontmatter + grouped `##` sections). */
export function buildReferenceOutline() {
  const parts = [
    "---",
    "title: HTML Presentations — Reference Deck",
    "slug: reference-deck",
    "author: html-presentations",
    "auto_title_slide: false",
    "auto_thanks_slide: false",
    "---",
    "",
  ];
  for (const group of groups) {
    parts.push(`## ${group.label}`, "");
    for (const fx of fixtures.filter((f) => f.group === group.key)) {
      parts.push(fx.markdown.trim(), "");
    }
  }
  return parts.join("\n");
}
