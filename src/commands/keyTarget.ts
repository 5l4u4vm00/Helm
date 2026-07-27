// Which elements own their keystrokes: a real text field must keep Ctrl+A for
// select-all, so the global prefix listener (capture phase, App.tsx) has to step
// aside there. Pure predicate + thin DOM adapter, so the rules stay testable.

/** Subset of an element needed to classify it (keeps the predicate DOM-free). */
export interface KeyTargetLike {
  /** Uppercase tag name, e.g. "INPUT". */
  tagName: string;
  /** Lowercased `type` attribute for inputs; undefined for everything else. */
  inputType?: string;
  isContentEditable?: boolean;
  /** Element lives inside an xterm container. */
  inTerminal?: boolean;
}

// Input types that behave like a text box (an absent type defaults to "text").
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "password",
  "email",
  "url",
  "tel",
  "number",
]);

/**
 * True when typing into this element should win over app-level shortcuts.
 * The terminal is deliberately excluded: xterm's input sink is a <textarea>,
 * so treating it as a text field would kill the prefix everywhere it matters.
 */
export function isTextEntry(t: KeyTargetLike | null): boolean {
  if (!t || t.inTerminal) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === "TEXTAREA") return true;
  if (t.tagName !== "INPUT") return false;
  return TEXT_INPUT_TYPES.has(t.inputType ?? "text");
}

/**
 * DOM adapter for isTextEntry. Takes a raw EventTarget: a keydown's target is
 * usually an element but can be document or window, and this runs inside the
 * global key handler — throwing there would break every shortcut.
 */
export function isTextEntryElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const el = target;
  const input = el as HTMLInputElement & HTMLElement;
  return isTextEntry({
    tagName: el.tagName,
    inputType: el.tagName === "INPUT" ? input.type?.toLowerCase() : undefined,
    isContentEditable: input.isContentEditable,
    inTerminal: el.closest(".xterm") !== null,
  });
}
