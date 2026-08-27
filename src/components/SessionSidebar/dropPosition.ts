// Sidebar drag pointer geometry. Pure and DOM-free so the fiddly half of
// dragging is unit-testable (same split as Terminal/dropTarget.ts): the
// components own the events, this module owns the decisions.
//
// The drag *transport* is pointer events, not HTML5 DnD, so there are no
// dataTransfer MIME types to inspect any more — what is being dragged travels
// as `ActiveDrag` from dragContext.tsx, which also documents why HTML5 DnD is
// unusable inside Tauri on Windows. `DragKind` stays here because it is the
// vocabulary both halves share.
export type DragKind = "session" | "workspace";

/** Which half of a row the pointer is in. Exactly on the midpoint counts as
 *  "before", so the two halves partition the row and a pointer resting on the
 *  boundary cannot flicker between them. */
export function pointerHalf(
  clientY: number,
  rect: { top: number; height: number },
): "before" | "after" {
  return clientY > rect.top + rect.height / 2 ? "after" : "before";
}
