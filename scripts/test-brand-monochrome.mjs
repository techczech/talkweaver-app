// A row mixing a full-colour svgl mark with a monochrome silhouette reads as broken — some brands
// vivid, others muted. When ANY mark on a slide can only be drawn monochrome (a Simple Icons
// mark), the WHOLE slide goes monochrome, which is a deliberate look rather than an uneven one.
//
// This guards three things: the decision helper + colour strip in isolation; genuine SLIDE-level
// coherence through the real assembly path (a list-level implementation, which decides per render
// site, leaves an all-svgl list coloured and FAILS that test); and — since stripBrandColour used to
// repaint a mark by dropping its whole <defs> block — that PAINT (gradients/patterns) is stripped
// while GEOMETRY (clipPath/mask, which many real svgl marks rely on for their actual silhouette) is
// preserved. Figma proves the clipPath case; a gradient-only mark proves paint still goes.
import { mkdtempSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iconSvg, slideNeedsMonochrome, applySlideMonochrome } from "../compiler/scripts/lib/05-icons.mjs";
import { prepareSource } from "../compiler/scripts/lib/08-source-adapters.mjs";

let fail = 0;
const ck = (c, m) => { if (!c) { console.error("FAIL:", m); fail++; } };

// (1) The decision itself.
ck(slideNeedsMonochrome(["svgl:openai", "svgl:google"]) === false, "all-svgl slide keeps colour");
ck(slideNeedsMonochrome(["svgl:openai", "svgl:minimax"]) === true, "any Simple Icons mark forces monochrome");
ck(slideNeedsMonochrome(["svgl:openai", "monogram:Z"]) === false, "a monogram does not force monochrome");
ck(slideNeedsMonochrome([]) === false, "an empty slide keeps colour");

// (2) Colour survives when not forced.
const colour = iconSvg("svgl:google");
ck(/#[0-9a-fA-F]{3,6}|rgb\(/.test(colour), "google renders in colour by default");

// (3) Colour is stripped when forced — hex fills, gradient references and inline styles alike.
// Google's real mark carries BOTH a clipPath (its silhouette) and a stack of gradients (its
// colour), so it doubles as a paint-vs-geometry check: the gradient fill references must go, but
// its clip-path="url(#…)" geometry reference — pointing at real, still-present geometry — must not
// be touched by the same sweep, even though both are `url(#…)` text.
const mono = iconSvg("svgl:google", { monochrome: true });
const paintUrlRef = (s) => /\b(fill|stroke)\s*[:=]\s*["']?url\(#/i.test(s);
ck(!/#[0-9a-fA-F]{3,6}/.test(mono), "monochrome strips hex fills (including gradient stop-colours)");
ck(!/<(linearGradient|radialGradient|pattern)\b/i.test(mono), "monochrome removes the gradient/pattern elements themselves");
ck(!paintUrlRef(mono), "monochrome strips fill/stroke gradient references");
ck(/currentColor/.test(mono), "monochrome paints currentColor");
ck(/<clipPath\b/i.test(mono), "monochrome PRESERVES google's clipPath element (geometry, not paint)");
ck(/clip-path\s*=\s*"url\(#/i.test(mono), "monochrome PRESERVES google's clip-path reference untouched");
ck(/^<svg/.test(mono), "monochrome output is still an svg");
ck(/<\/svg>\s*$/.test(mono), "monochrome output is a closed svg element");

// microsoft carries flat hex fills (no gradient) — the strip must repaint those too.
const monoMs = iconSvg("svgl:microsoft", { monochrome: true });
ck(!/#[0-9a-fA-F]{3,6}/.test(monoMs) && /currentColor/.test(monoMs), "microsoft's flat hex fills are repainted to currentColor");

// (3b) DEDICATED clipPath case — Figma's mark is five plain-fill circle-segments clipped by a
// <clipPath> to its familiar three-piece silhouette; nothing else about it is remotely gradient-
// like. This isolates the exact defect: dropping the whole <defs> would turn Figma into an
// unclipped rounded-square blob. The fix must leave the clip fully intact.
const monoFigma = iconSvg("svgl:figma", { monochrome: true });
ck(/<clipPath\b/i.test(monoFigma), "figma: monochrome KEEPS the <clipPath> element");
ck(/clip-path\s*=\s*"url\(#/i.test(monoFigma), "figma: monochrome KEEPS the clip-path=\"url(#…)\" reference");
ck(!/#[0-9a-fA-F]{3,6}/.test(monoFigma), "figma: monochrome contains no hex colour");
ck(/currentColor/.test(monoFigma), "figma: monochrome paints currentColor");

// (3c) DEDICATED gradient case — Telegram is a real svgl mark whose only <defs> content is a
// single <linearGradient> (id="a") feeding one fill="url(#a)". The gradient element and its
// fill reference must both be gone; nothing here is geometry, so nothing should survive.
const monoTelegram = iconSvg("svgl:telegram", { monochrome: true });
ck(!/<linearGradient\b/i.test(monoTelegram), "telegram: monochrome REMOVES the <linearGradient> element");
ck(!/url\(#/i.test(monoTelegram), "telegram: monochrome leaves no url(#…) reference at all (it had no geometry to keep)");
ck(!/#[0-9a-fA-F]{3,6}/.test(monoTelegram), "telegram: monochrome contains no hex colour");
ck(/currentColor/.test(monoTelegram), "telegram: monochrome paints currentColor");

// (3d) DEDICATED mask case — Angular's mark uses a <mask> (luminance) whose content is a plain
// white path; that fill is not brand colour, it is the mask's opacity data, so it must survive
// completely untouched (not just "not hex" — literally byte-identical) or the masked shape either
// vanishes or inverts once currentColor stands in for white. Angular also has a <clipPath> AND two
// gradient fills on the same mark, so this is the fullest combined check.
const monoAngular = iconSvg("svgl:angular", { monochrome: true });
ck(/<mask\b/i.test(monoAngular), "angular: monochrome KEEPS the <mask> element");
ck(/\bmask\s*=\s*"url\(#/i.test(monoAngular), "angular: monochrome KEEPS the mask=\"url(#…)\" reference");
ck(/<clipPath\b/i.test(monoAngular), "angular: monochrome KEEPS the <clipPath> element");
ck(/clip-path\s*=\s*"url\(#/i.test(monoAngular), "angular: monochrome KEEPS the clip-path=\"url(#…)\" reference");
ck(/<mask\b[^>]*>[\s\S]*?fill="#fff"[\s\S]*?<\/mask>/i.test(monoAngular), "angular: the mask's own luminance fill is left byte-identical, not repainted");
ck(!/<linearGradient\b/i.test(monoAngular), "angular: monochrome REMOVES the <linearGradient> elements (paint)");
ck(!paintUrlRef(monoAngular), "angular: monochrome strips the two fill=\"url(#…)\" gradient references outside the mask");
ck(/currentColor/.test(monoAngular), "angular: monochrome paints currentColor");

// (4) Already-monochrome Simple Icons marks are unharmed by the mono path, and carry the data-mono
// marker in their default render so the slide-level pass can detect them.
ck(/^<svg/.test(iconSvg("svgl:minimax", { monochrome: true })), "a silhouette survives monochrome");
ck(/data-mono/.test(iconSvg("svgl:minimax")), "a Simple Icons mark is tagged data-mono by default");
ck(!/data-mono/.test(iconSvg("svgl:google")), "a full-colour svgl mark is not tagged data-mono");

// (5) RENDER-LEVEL — genuine SLIDE scope through the real assembly path. Two logolists on ONE
// slide: list A all-svgl (OpenAI, Google, Microsoft), list B with a Simple Icons mark (MiniMax).
// The whole slide must render monochrome — list A's Google and Microsoft included. A SECOND,
// separate slide whose marks are all svgl must stay in full colour.
const dir = mkdtempSync(join(tmpdir(), "tw-mono-"));
const outlinePath = join(dir, "mono.md");
const content = [
  "---",
  "title: Monochrome coherence",
  "auto_title_slide: false",
  "auto_thanks_slide: false",
  "---",
  "",
  "### Model makers {logolist id=mixed}",
  "",
  "- OpenAI",
  "- Google",
  "- Microsoft",
  "",
  "Chinese labs:",
  "",
  "- OpenAI",
  "- Google",
  "- MiniMax",
  "",
  "### Western labs {logolist id=allsvgl}",
  "",
  "- OpenAI",
  "- Google",
  "- Microsoft",
].join("\n");
writeFileSync(outlinePath, content, "utf8");
const model = await prepareSource(outlinePath, content, "mono", statSync(outlinePath));
const html = model.fullHtml.replace(/<style[\s\S]*?<\/style>/g, "");

const sectionById = (id) =>
  html.match(new RegExp(`<section class="slide"[^>]*data-id="${id}"[\\s\\S]*?</section>`))?.[0] ?? "";
const brandSvgsIn = (section) => section.match(/<svg[^>]*fl-svg-brand[^>]*>[\s\S]*?<\/svg>/g) ?? [];
const hasHex = (s) => /#[0-9a-fA-F]{3,6}/.test(s);
// Paint reference only — a geometry reference (clip-path=/mask=, e.g. Google's real clipPath) is
// SUPPOSED to survive monochrome, so a blanket url(#…) check would false-fail on it.
const hasPaintUrlRef = (s) => /\b(fill|stroke)\s*=\s*"url\(#/i.test(s);

const mixed = sectionById("mixed");
const mixedBrand = brandSvgsIn(mixed);
ck(mixedBrand.length === 6, `mixed slide renders both logolists as brand marks (got ${mixedBrand.length}/6)`);
ck(/data-mono/.test(mixed), "mixed slide carries the Simple Icons data-mono marker");
ck(mixedBrand.every((s) => !hasHex(s)), "SLIDE-LEVEL: no brand mark on the mixed slide keeps hex colour (list A's Google/Microsoft included)");
ck(mixedBrand.every((s) => !hasPaintUrlRef(s)), "SLIDE-LEVEL: no brand mark on the mixed slide keeps a gradient fill reference");
ck(mixedBrand.every((s) => /currentColor/.test(s)), "SLIDE-LEVEL: every brand mark on the mixed slide is painted currentColor");

const allSvgl = sectionById("allsvgl");
const allSvglBrand = brandSvgsIn(allSvgl);
ck(allSvglBrand.length === 3, `all-svgl slide renders its logolist as brand marks (got ${allSvglBrand.length}/3)`);
ck(!/data-mono/.test(allSvgl), "all-svgl slide carries no data-mono marker");
ck(allSvglBrand.some((s) => hasHex(s)), "an all-svgl slide keeps its full brand colour (Google/Microsoft stay vivid)");

// (6) KNOCKOUT SWAP — a brand whose svgl mark carries its shape in colour CONTRAST (Facebook's white
// `f` knocked out of a blue disc, Telegram's white plane on a gradient disc) collapses to a solid
// blob when colour-stripped. On a mono slide, such a brand renders its Simple Icons SILHOUETTE
// instead — single-colour by design, so the shape survives. The rule is the simplest correct one:
// ANY svgl/extra brand WITH a Simple Icons twin swaps to the silhouette on mono; only twinless
// brands colour-strip. No knockout detection — swapping a clean-geometry mark like Figma is fine.
const simpleIcons = JSON.parse(
  readFileSync(new URL("../compiler/assets/icons/simple-icons.json", import.meta.url), "utf8")
);

// Preconditions: the swap can only fire for a brand that HAS a Simple Icons twin.
ck(!!simpleIcons.facebook, "precondition: facebook has a Simple Icons twin (_simpleIcons.facebook)");
ck(!!simpleIcons.telegram, "precondition: telegram has a Simple Icons twin (_simpleIcons.telegram)");

// iconSvg tags svgl/extra marks with data-brand so the pass identifies the brand without re-resolving.
ck(/data-brand="facebook"/.test(iconSvg("svgl:facebook")), "svgl facebook carries data-brand for the pass to read");
ck(/data-brand="google"/.test(iconSvg("svgl:google")), "svgl google carries data-brand");
ck(!/data-brand/.test(iconSvg("svgl:minimax")), "a Simple Icons mark carries data-mono, not data-brand");

// Drive the swap through the REAL HTML pass. A slide needs ANY data-mono mark to trigger it; the
// minimax silhouette supplies that trigger without itself being an svgl brand under test. The brand
// under test sits first, so match()[0] is its (post-pass) mark.
const monoTrigger = iconSvg("svgl:minimax");
const firstMonoMark = (name) =>
  (applySlideMonochrome(`<span class="ir-icon">${iconSvg("svgl:" + name)}</span>${monoTrigger}`)
    .match(/<svg[^>]*fl-svg-brand[^>]*>[\s\S]*?<\/svg>/g) ?? [])[0] ?? "";

const fbColour = iconSvg("svgl:facebook");
ck(/#[0-9a-fA-F]{3,6}/.test(fbColour), "svgl facebook is a colour knockout (blue disc) by default");
const fbMono = firstMonoMark("facebook");
ck(fbMono.includes(simpleIcons.facebook.body), "MONO facebook IS the Simple Icons silhouette body (recognisable f, not a stripped blob)");
// The svgl facebook mark is a disc-plus-knockout drawn in a 0 0 666.667 box with a clipPath; the
// silhouette is a single path in a 0 0 24 24 box with none of that structure.
ck(/viewBox="0 0 24 24"/.test(fbMono), "MONO facebook uses the Simple Icons 0 0 24 24 viewBox (silhouette), not the svgl knockout box");
ck(!/<clipPath\b/i.test(fbMono), "MONO facebook does NOT retain the svgl knockout's clipPath structure");
ck(!/#[0-9a-fA-F]{3,6}/.test(fbMono), "mono facebook carries no hex colour");
ck(/currentColor/.test(fbMono), "mono facebook is painted currentColor");
ck(/data-mono/.test(fbMono), "swapped facebook is tagged data-mono (it is a silhouette now)");
ck(/fl-svg fl-svg-brand/.test(fbMono), "swapped facebook keeps the fl-svg-brand container class");

const tgColour = iconSvg("svgl:telegram");
const tgMono = firstMonoMark("telegram");
ck(/url\(#|#[0-9a-fA-F]{3,6}/.test(tgColour), "svgl telegram is a coloured (gradient) knockout by default");
ck(tgMono.includes(simpleIcons.telegram.body), "MONO telegram IS the Simple Icons paper-plane silhouette body");
ck(!/url\(#/i.test(tgMono), "mono telegram has no gradient reference (it is the silhouette, not a stripped gradient)");
ck(!/#[0-9a-fA-F]{3,6}/.test(tgMono), "mono telegram carries no hex colour");

// (7) A clean-GEOMETRY brand WITH a twin swaps too — the rule is uniform, documented: twin ⇒ swap.
// Figma's svgl mark is honest clipPath geometry, but it has a Simple Icons twin, so on a mono SLIDE
// it renders the silhouette all the same. (Its direct opts.monochrome colour-strip, checked at (3b),
// still preserves the clipPath — that is a different surface, used only for a single mark forced grey.)
ck(!!simpleIcons.figma, "precondition: figma has a Simple Icons twin");
const figMonoSlide = firstMonoMark("figma");
ck(figMonoSlide.includes(simpleIcons.figma.body), "MONO figma swaps to its Simple Icons silhouette on a slide (twin ⇒ swap, uniformly)");
ck(!/<clipPath\b/i.test(figMonoSlide), "swapped figma drops the svgl clipPath — it is the silhouette, not stripped geometry");

// (8) A TWINLESS brand still colour-strips on mono, preserving its geometry (Task 7 behaviour).
// Runway is an svgl clipPath mark with no Simple Icons twin — under EITHER hyphenation, since svgl
// and Simple Icons disagree on it (svgl `hugging-face` vs Simple Icons `huggingface`), so a twin
// check must test both the exact key and its hyphen-collapsed form. Runway has neither, so the slide
// pass strips it rather than swapping. Geometry survives; only paint is repainted to currentColor.
const twinless = "runway";
ck(!simpleIcons[twinless] && !simpleIcons[twinless.replace(/-/g, "")],
  `precondition: ${twinless} has NO Simple Icons twin (exact or hyphen-collapsed)`);
const twColour = iconSvg(`svgl:${twinless}`);
ck(new RegExp(`data-brand="${twinless}"`).test(twColour), `twinless ${twinless} still carries data-brand`);
const twMono = firstMonoMark(twinless);
ck(!/#[0-9a-fA-F]{3,6}/.test(twMono), `twinless ${twinless}: mono strips its hex colour`);
ck(/currentColor/.test(twMono), `twinless ${twinless}: mono paints currentColor`);
ck(/<clipPath\b/i.test(twMono), `twinless ${twinless}: mono PRESERVES its clipPath geometry (colour-stripped, not swapped)`);
ck(!/data-mono/.test(twMono), `twinless ${twinless}: colour-stripped, not turned into a silhouette`);

// (9) The hyphen-mismatch swap: Hugging Face is svgl `hugging-face` but Simple Icons `huggingface`.
// A Sketch mask/knockout export, it collapses to a black blob if colour-stripped, so it MUST reach
// its twin across the hyphen difference.
ck(!simpleIcons["hugging-face"] && !!simpleIcons["huggingface"],
  "precondition: hugging-face twins only via hyphen collapse");
const hfMono = firstMonoMark("hugging-face");
ck(/data-mono/.test(hfMono), "hugging-face swaps to its Simple Icons silhouette across the hyphen mismatch");
ck(hfMono.includes(simpleIcons.huggingface.body), "swapped hugging-face carries the huggingface silhouette body");
ck(!/Sketch|<defs>/i.test(hfMono), "swapped hugging-face drops the svgl Sketch/defs structure");

// (10) DECK OPTION `logo-colour` — the author's switch between the unified default and brand colours
// (Task 9a). The SAME mixed {logolist} (a full-colour svgl mark, Google, + a Simple Icons silhouette,
// MiniMax) is compiled twice through the real assembly path. Default = unified: every mark drops to
// currentColor. `logo-colour: brand`: the svgl mark KEEPS its real hex/gradient; the silhouette-only
// mark still renders flat. The American alias `logo-color` is proven to switch identically.
const compileLogolistMarks = async (frontmatterExtra) => {
  const d = mkdtempSync(join(tmpdir(), "tw-logocol-"));
  const p = join(d, "deck.md");
  const c = [
    "---",
    "title: Logo colour",
    "auto_title_slide: false",
    "auto_thanks_slide: false",
    ...frontmatterExtra,
    "---",
    "",
    "### Model makers {logolist id=mixed}",
    "",
    "- Google",
    "- MiniMax",
  ].join("\n");
  writeFileSync(p, c, "utf8");
  const m = await prepareSource(p, c, "logocol", statSync(p));
  const h = m.fullHtml.replace(/<style[\s\S]*?<\/style>/g, "");
  const section = h.match(/<section class="slide"[^>]*data-id="mixed"[\s\S]*?<\/section>/)?.[0] ?? "";
  return section.match(/<svg[^>]*fl-svg-brand[^>]*>[\s\S]*?<\/svg>/g) ?? [];
};

const unifiedMarks = await compileLogolistMarks([]);
ck(unifiedMarks.length === 2, `logo-colour default: mixed logolist renders both marks (got ${unifiedMarks.length}/2)`);
ck(unifiedMarks.every((s) => /currentColor/.test(s)), "logo-colour default (unified): every brand mark is painted currentColor");
ck(unifiedMarks.every((s) => !hasHex(s)), "logo-colour default (unified): no brand mark keeps hex colour (Google is brought down too)");

const brandMarks = await compileLogolistMarks(["logo-colour: brand"]);
ck(brandMarks.length === 2, `logo-colour: brand: mixed logolist renders both marks (got ${brandMarks.length}/2)`);
ck(brandMarks.some((s) => hasHex(s)), "logo-colour: brand KEEPS a real brand colour (Google's svgl mark stays vivid on a mixed slide)");

const brandMarksAlias = await compileLogolistMarks(["logo-color: brand"]);
ck(brandMarksAlias.some((s) => hasHex(s)), "logo-color (American alias) switches identically to logo-colour");

const explicitUnifiedMarks = await compileLogolistMarks(["logo-colour: unified"]);
ck(explicitUnifiedMarks.every((s) => !hasHex(s)), "explicit logo-colour: unified matches the default (row brought to accent)");

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
console.log("PASS: slide-level monochrome coherence");
