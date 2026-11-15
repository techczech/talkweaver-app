// Which elements are a slide's own: the one rule every search that decides what a slide steps through applies before
// it chooses anything (PR 389 review).
//
// A section's contents strip, contents rail and card table (decorateContainer in the deck runtime) are drawn over a
// slide inside `.ct-overlay`, and each shot of the strip holds a whole copy of another slide (`.ct-shot-mini > .slide`).
// Nothing inside them is a step, a carousel, a file, a picture or a simulation of the slide they are drawn over. A
// search that looked through every descendant found a carousel MINIATURE before the slide's own content and stepped
// "inside" it: the slide lost all its steps.
//
// A slide owns an element when the element's nearest enclosing slide or container overlay is the slide itself. A
// search scoped to a carousel card on a slide reads the same way: the card's slide is the owner. A preview copy of a
// slide (the presenter's panes) is a slide, so its copied strip is excluded the same way.
//
// `stepOwnershipRuntimeSource()` serialises these functions; runtime/emphasis-steps.js carries them inside its own
// runtime source, so both runtimes (the deck template and the handout / venue page) inline one copy.

/** What a slide's own content cannot sit inside: another slide (a miniature copy) or a container overlay. */
export const STEP_BOUNDARY_SELECTOR = '.slide, .ct-overlay';

/** The slide or container overlay that encloses `el` (not counting `el` itself); null when none does. */
export function stepBoundaryOf(el) {
  const parent = el && el.parentElement;
  return parent ? parent.closest(STEP_BOUNDARY_SELECTOR) : null;
}

/** The slide a search scope belongs to: the scope itself when it is a slide, else the slide it sits on. */
export function stepHostOf(root) {
  return root && typeof root.closest === 'function' ? root.closest('.slide') : null;
}

/** Whether `el` (a descendant of `root`) is the slide's own, not part of a miniature or a container overlay. */
export function ownsStepElement(root, el) {
  return Boolean(root && el) && stepBoundaryOf(el) === stepHostOf(root);
}

/** `root.querySelectorAll(selector)`, the slide's own elements only, in page order. */
export function ownedStepElements(root, selector) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const host = stepHostOf(root);
  return Array.prototype.filter.call(root.querySelectorAll(selector), function (el) { return stepBoundaryOf(el) === host; });
}

/** `root.querySelector(selector)`, the first of the slide's own elements; null when it has none. */
export function ownedStepElement(root, selector) {
  if (!root || typeof root.querySelectorAll !== 'function') return null;
  const host = stepHostOf(root);
  const all = root.querySelectorAll(selector);
  for (let i = 0; i < all.length; i += 1) if (stepBoundaryOf(all[i]) === host) return all[i];
  return null;
}

export function stepOwnershipRuntimeSource() {
  return ['const STEP_BOUNDARY_SELECTOR = ' + JSON.stringify(STEP_BOUNDARY_SELECTOR) + ';']
    .concat([stepBoundaryOf, stepHostOf, ownsStepElement, ownedStepElements, ownedStepElement].map((fn) => fn.toString()))
    .join('\n');
}
