// The one rule for what an audio chip is called: its Markdown title, else its file name without the
// extension. Shared by the chip renderer (06-block-renderers) and the phone text view (slide-script),
// so the two never disagree. Pure: no node imports, so it is safe anywhere the compiler runs.
import { referenceFileName } from "./shown-reference.mjs";

export function audioChipTitle(block) {
  const title = String(block.title || "").trim();
  if (title) return title;
  const src = String(block.src || "");
  // The file's own name, never a folder: taken after decoding, so a percent-encoded path
  // (`%2FUsers%2F…%2Fclip.mp3`) is not shown whole (ADR-0036, shown-reference.mjs).
  const name = String(block.audioName ? referenceFileName(block.audioName) : (/^data:/i.test(src) ? "" : referenceFileName(src.split(/[?#]/)[0])));
  return name.replace(/\.[A-Za-z0-9]+$/, "") || "Audio";
}
