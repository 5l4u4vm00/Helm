// Sidebar-local keyboard mapping. Keeping this DOM-free makes the interaction
// contract easy to test and prevents workspace/session rows from drifting.
export type SidebarTarget = "workspace" | "session";

export type SidebarShortcut =
  | "activate-session"
  | "toggle-workspace"
  | "focus-parent"
  | "collapse-workspace"
  | "expand-or-enter-workspace"
  | "rename"
  | "new-session"
  | "new-workspace"
  | "choose-folder"
  | "request-delete"
  | "focus-terminal";

export function resolveSidebarShortcut(
  target: SidebarTarget,
  key: string,
): SidebarShortcut | null {
  if (key === "Escape") return "focus-terminal";
  if (key === "r" || key === "F2") return "rename";
  if (key === "a") return "new-session";
  if (key === "A") return "new-workspace";
  if (key === "f") return "choose-folder";
  if (key === "Delete" || key === "Backspace") return "request-delete";

  if (target === "session") {
    if (key === "Enter" || key === " ") return "activate-session";
    if (key === "h" || key === "ArrowLeft") return "focus-parent";
    return null;
  }

  if (key === "Enter" || key === " ") return "toggle-workspace";
  if (key === "h" || key === "ArrowLeft") return "collapse-workspace";
  if (key === "l" || key === "ArrowRight") return "expand-or-enter-workspace";
  return null;
}
