// Window widths the layout gives way at (house rule R17: every window works from 1000 px up).
/**
 * Below this window width the two sidebars do not share the window: the Talks sidebar on the left and the right sidebar
 * (Inspector, Strip, Guide, Research, Images) are never both open, so the editor keeps at least its share (55%).
 * The one opened last stays; the other collapses.
 */
export const NARROW_WINDOW_PX = 1260
