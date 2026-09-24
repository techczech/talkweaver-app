// Browser-safe HTML escaping shared by the compiler and renderer-consumable lifted renderers.
// 01-cli-utils.mjs re-exports this function so every existing compiler caller keeps one truth.
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
