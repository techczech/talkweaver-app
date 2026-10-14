// The fences that are simulations by their language alone. No file or Node access: the layout inference the app
// shares reads it.

export const SIM_FENCE_LANGS = new Set(["chat", "terminal"]);
/** Layout inferred from an untagged fence: ```chat -> chat, ```terminal -> terminal (same place `trace` is inferred). */
export const simulationLayoutForFence = (lang) => (SIM_FENCE_LANGS.has(lang) ? lang : "");
