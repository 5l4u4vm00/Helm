// The shortcut reference: every section is generated from the key tables
// (commands/shortcutDocs.ts), so this dialog cannot drift from what the app
// actually does. Opened by Ctrl+A ?, the palette, the sidebar's ? button and
// the native Help menu.
import { useEffect, useRef } from "react";
import { useUiStore } from "../../store/ui";
import { buildShortcutDocs } from "../../commands/shortcutDocs";
import { focusActiveTerminal, handleDismissKey, trapTabKey } from "../../focus/focusUtils";
import { useT } from "../../i18n";
import "./ShortcutsHelp.css";

const IS_MAC = navigator.userAgent.includes("Mac");

export function ShortcutsHelp() {
  const open = useUiStore((s) => s.shortcutsOpen);
  if (!open) return null;
  return <ShortcutsDialog />;
}

function ShortcutsDialog() {
  const t = useT();
  const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);
  const cardRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<Element | null>(document.activeElement);
  const sections = buildShortcutDocs(IS_MAC);

  useEffect(() => cardRef.current?.focus(), []);

  const close = () => {
    setShortcutsOpen(false);
    const prev = prevFocusRef.current;
    if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
    else focusActiveTerminal();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (handleDismissKey(e, close)) return;
    if (e.key === "Tab" && cardRef.current) trapTabKey(e, cardRef.current);
  };

  return (
    <div className="shortcuts-overlay">
      <div className="shortcuts-backdrop" onClick={close} />
      <div
        className="shortcuts-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcut.title")}
        tabIndex={-1}
        ref={cardRef}
        onKeyDown={onKeyDown}
      >
        <div className="shortcuts-header">
          <span>{t("shortcut.title")}</span>
          <span className="shortcuts-header-actions">
            <span className="shortcuts-hint">{t("shortcut.dismiss")}</span>
            <button className="shortcuts-close" onClick={close} title={t("shortcut.dismiss")}>
              ×
            </button>
          </span>
        </div>
        <div className="shortcuts-body">
          {sections.map((section) => (
            <section key={section.titleKey} className="shortcuts-section">
              <h3>{t(section.titleKey)}</h3>
              {section.noteKey && <p className="shortcuts-note">{t(section.noteKey)}</p>}
              {section.rows.map((row) => (
                <div key={`${row.keys}-${row.titleKey}`} className="shortcuts-row">
                  <kbd className="shortcuts-key">{row.keys}</kbd>
                  <span className="shortcuts-title">{t(row.titleKey)}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
