// VS Code-style command palette: fuzzy filter, arrows + Enter to run.
// Commands are snapshotted on open; closing restores focus to where the user
// was (or the active terminal), and the chosen command runs after close so
// any focus it sets (e.g. switch session) wins.
import { useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../../store/ui";
import { listCommands, runCommand } from "../../commands/registry";
import { filterCommands } from "../../commands/filter";
import { shortcutLabel } from "../../commands/keymap";
import { focusActiveTerminal, handleDismissKey, trapTabKey } from "../../focus/focusUtils";
import type { Command } from "../../commands/types";
import { useT } from "../../i18n";
import "./CommandPalette.css";

const IS_MAC = navigator.userAgent.includes("Mac");

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  if (!open) return null;
  // Inner component mounts fresh on every open, resetting query/selection.
  return <PaletteDialog />;
}

function PaletteDialog() {
  const t = useT();
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<Element | null>(document.activeElement);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const commands = useMemo(
    () =>
      listCommands().filter(
        (c) => !c.hidden && c.enabled?.() !== false && c.id !== "palette:open",
      ),
    [],
  );
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const sel = Math.min(selected, Math.max(results.length - 1, 0));

  useEffect(() => inputRef.current?.focus(), []);

  // Keep the selected row visible while navigating.
  useEffect(() => {
    listRef.current
      ?.querySelector(".selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel, results]);

  const close = () => {
    setPaletteOpen(false);
    const prev = prevFocusRef.current;
    if (prev instanceof HTMLElement && prev.isConnected) {
      prev.focus();
    } else {
      focusActiveTerminal();
    }
  };

  const runSelected = (cmd: Command | undefined) => {
    close();
    if (cmd) runCommand(cmd.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (handleDismissKey(e, close)) {
      return;
    } else if (e.key === "ArrowDown" && results.length > 0) {
      e.preventDefault();
      setSelected((sel + 1) % results.length);
    } else if (e.key === "ArrowUp" && results.length > 0) {
      e.preventDefault();
      setSelected((sel - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runSelected(results[sel]);
    } else if (e.key === "Tab") {
      trapTabKey(e, e.currentTarget as HTMLElement);
    }
  };

  return (
    <div className="palette-overlay">
      <div className="palette-backdrop" onClick={close} />
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.dialogLabel")}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder={t("palette.inputPlaceholder")}
          aria-label={t("palette.searchLabel")}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
        />
        <div className="palette-list" role="listbox" ref={listRef}>
          {results.length === 0 && (
            <div className="palette-empty">{t("palette.empty")}</div>
          )}
          {results.map((c, i) => (
            <div
              key={c.id}
              role="option"
              aria-selected={i === sel}
              className={`palette-item ${i === sel ? "selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => runSelected(c)}
            >
              {c.category && <span className="palette-cat">{c.category}</span>}
              <span className="palette-title">{c.title}</span>
              <span className="palette-key">{shortcutLabel(c.id, IS_MAC)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
