// Sidebar drag-and-drop payload types and pointer geometry. Pure and DOM-free
// so the fiddly half of DnD is unit-testable (same split as Terminal/dropTarget.ts):
// the components own the events, this module owns the decisions.
export const SESSION_DND_TYPE = "application/x-helm-session";
export const WORKSPACE_DND_TYPE = "application/x-helm-workspace";

export type DragKind = "session" | "workspace";

/**
 * What is being dragged, read from `dataTransfer.types` — the only thing
 * readable during `dragover` (getData is blocked until drop), so this is what
 * gates the insertion indicator. Two distinct MIME types are what keep a
 * workspace drag from ever being interpreted as a session drop and vice versa.
 * All-lowercase constants: the browser lowercases the type list.
 */
export function dragKind(types: readonly string[]): DragKind | null {
  if (types.includes(SESSION_DND_TYPE)) return "session";
  if (types.includes(WORKSPACE_DND_TYPE)) return "workspace";
  return null;
}

/** Which half of a row the pointer is in. Exactly on the midpoint counts as
 *  "before", so the two halves partition the row and a pointer resting on the
 *  boundary cannot flicker between them. */
export function pointerHalf(
  clientY: number,
  rect: { top: number; height: number },
): "before" | "after" {
  return clientY > rect.top + rect.height / 2 ? "after" : "before";
}
