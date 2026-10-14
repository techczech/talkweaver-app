// =============================================================================
// 3. Markdown lexer — outline lines -> typed blocks (lists, fences, images, embeds, quotes)
// =============================================================================
//
// The lexer's code is in 03-markdown-lexer-core.mjs. This file is the compiler's entry to it: the
// same functions, bound to the compiler's icon vocabulary (05-icons.mjs normalizeIconOverrideKey,
// which reads the vendored icon sets from disk). Every compiler path imports from here. The split
// exists so that the editor's plain view can run the same lexer where no disk is to be read
// (src/shared/plain-view-compiler-facts.ts); it changes nothing the compiler produces
// (test:icons-on-titles-identity). The app's check before a quote write reads one slide with the
// core too (src/shared/quote-write-check.ts).
import { normalizeIconOverrideKey } from "./05-icons.mjs";
import { lexMarkdownBlocksWith, takeParagraphIconWith } from "./03-markdown-lexer-core.mjs";

export { isImageBlockLine } from "./image-line-rules.mjs";
export { paragraphIconTokenAt } from "./03-markdown-lexer-core.mjs";

// The text without the token and the normalised icon key (null when NAME resolves to nothing), or
// the text unchanged when the paragraph does not end in an authoring token.
export function takeParagraphIcon(text) {
  const taken = takeParagraphIconWith(text, normalizeIconOverrideKey);
  return { text: taken.text, icon: taken.icon };
}

export function lexMarkdownBlocks(lines) {
  return lexMarkdownBlocksWith(lines, normalizeIconOverrideKey);
}
