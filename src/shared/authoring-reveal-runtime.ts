// Installed into the compiled deck's own scope only when marking an authoring document.
// Let the normal paint path clamp the final step against the visible units of the active card.
const STARTUP = '  syncFromHash();\n  // On a cold start,'
const COLD_START = 'if (authored) state.mode = { kind: authored, step: 0 };'

const RUNTIME = `  // TalkWeaver authoring preview
  const normalArrivalMode = arrivalMode;
  arrivalMode = (index) => {
    const mode = normalArrivalMode(index);
    return mode.kind === "reveal" ? { ...mode, step: Number.MAX_SAFE_INTEGER } : mode;
  };
  const normalApplyModeDimming = applyModeDimming;
  applyModeDimming = () => {
    normalApplyModeDimming();
    const slide = currentSlide();
    if (!slide) return;
    const enabled = slide.dataset.mode === "reveal" && !slideNoStep(state.index);
    const count = enabled ? slideSteps(slide, "reveal").max : 0;
    if (enabled) slide.dataset.twRevealSteps = String(count);
    if (window.parent === window) return;
    window.parent.postMessage({
      type: "tw-preview-reveal", url: location.href, slideId: slide.dataset.id, enabled, count,
      step: enabled ? clampStepTo(state.mode.step, count) : 0
    }, "*");
  };
  document.addEventListener("tw-preview-step", (event) => {
    const slide = currentSlide();
    if (slide?.dataset.mode !== "reveal" || slideNoStep(state.index)) return;
    // The Inspector arrows control this slide only. Next at the end and Back at
    // the start never enter a different slide, card, or image sequence.
    event.preventDefault();
    const plan = slideSteps(slide, "reveal");
    const step = clampStepTo(state.mode.step, plan.max);
    const next = clampStepTo(step + event.detail, plan.max);
    if (next !== step) publish({ mode: { ...state.mode, kind: "reveal", step: next }, simType: null });
  });
`

export function installAuthoringRevealRuntime(html: string): string {
  if (!html.includes('data-mode="reveal"')) return html
  const startup = html.lastIndexOf(STARTUP)
  if (startup < 0) return html
  const tail = html.slice(startup)
  if (!tail.includes(COLD_START)) return html
  return html.slice(0, startup) + RUNTIME + tail.replace(COLD_START, 'if (authored) state.mode = arrivalMode(state.index);')
}
