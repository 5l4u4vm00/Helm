// Auto-scroll ramp for a sidebar drag. Pure and DOM-free, in its own module for
// the same reason dropPosition.ts is: the components own the events, this owns
// the arithmetic, and a node test can import it without pulling in React.
//
// Why it exists at all: the drag controller takes pointer capture (see
// dragContext.tsx), which is what keeps WebView2's native drag layer out of the
// gesture on Windows -- but it also means the list stops scrolling itself while
// a drag is in progress, so a row below the fold would be unreachable.

/** How close to a list edge the pointer must get before the list scrolls, and
 *  the fastest it may scroll (px per frame). */
export const AUTOSCROLL_ZONE_PX = 24;
export const AUTOSCROLL_MAX_PX = 12;

/**
 * Pixels to scroll this frame for a pointer at `clientY` over a list occupying
 * `top`..`bottom`. Negative scrolls up, positive down, 0 means "not in a zone".
 * Speed ramps linearly with depth into the zone, so entering it is a nudge and
 * the very edge is fast.
 */
export function autoScrollStep(
  clientY: number,
  rect: { top: number; bottom: number },
  zone = AUTOSCROLL_ZONE_PX,
  max = AUTOSCROLL_MAX_PX,
): number {
  // Top is checked first so it wins when a list shorter than two zones makes
  // them overlap: without a fixed winner the midpoint would scroll up and down
  // on alternating frames. Clamping the depth at 0 keeps a pointer dragged past
  // the edge at full speed rather than wrapping back through zero.
  const fromTop = clientY - rect.top;
  if (fromTop < zone) return -Math.ceil(((zone - Math.max(fromTop, 0)) / zone) * max);
  const fromBottom = rect.bottom - clientY;
  if (fromBottom < zone) return Math.ceil(((zone - Math.max(fromBottom, 0)) / zone) * max);
  return 0;
}
