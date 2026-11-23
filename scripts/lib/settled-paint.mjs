// A reduced-motion preference does not suppress every legacy CSS transition. Wait for
// finite transitions on the active slide before comparing its final painted state.
export async function waitForSlidePaint(page, { timeout = 5000 } = {}) {
  await page.waitForFunction(() => !document.getAnimations().some(animation =>
    animation instanceof CSSTransition && (animation.playState === 'running' || animation.pending)
    && animation.effect?.target?.closest?.('.stage > .slide.active')), null, { timeout });
}
