// Which-key overlay: visible exactly while the Ctrl+A prefix is armed,
// listing every available second key with its command title, grouped by
// category. Pure display — the App capture handler owns all key events,
// and arming/disarming (timeout, Esc, blur) lives in the prefix store.
import { useMemo } from "react";
import { usePrefixStore } from "../../store/prefix";
import { DIGITS_LABEL, prefixKeyLabel, whichKeyHints } from "../../commands/prefix";
import { listCommands } from "../../commands/registry";
import { useT } from "../../i18n";
import "./WhichKey.css";

const IS_MAC = navigator.userAgent.includes("Mac");

interface Row {
  keyLabel: string;
  title: string;
  enabled: boolean;
}

export function WhichKey() {
  const armed = usePrefixStore((s) => s.armed);
  if (!armed) return null;
  return <WhichKeyPanel />;
}

function WhichKeyPanel() {
  const t = useT();

  // Snapshot on arm (the panel remounts per arming), grouped by category.
  const groups = useMemo(() => {
    const byId = new Map(listCommands().map((c) => [c.id, c]));
    const grouped = new Map<string, Row[]>();
    for (const hint of whichKeyHints(IS_MAC)) {
      const cmd = byId.get(hint.commandId);
      if (!cmd) continue;
      const row: Row = {
        keyLabel: hint.keyLabel,
        // The collapsed Digit1..9 row points at switch-1; give it its own title.
        title:
          hint.keyLabel === DIGITS_LABEL ? t("whichKey.switchDigits") : cmd.title,
        enabled: cmd.enabled?.() !== false,
      };
      const cat = cmd.category ?? "";
      const list = grouped.get(cat);
      if (list) list.push(row);
      else grouped.set(cat, [row]);
    }
    return [...grouped.entries()];
  }, [t]);

  return (
    <div className="whichkey" role="dialog" aria-label={t("whichKey.title")}>
      <div className="whichkey-groups">
        {groups.map(([category, rows]) => (
          <div key={category} className="whichkey-group">
            <div className="whichkey-cat">{category}</div>
            {rows.map((r) => (
              <div
                key={r.keyLabel}
                className="whichkey-row"
                data-enabled={r.enabled}
              >
                <kbd className="whichkey-key">{r.keyLabel}</kbd>
                <span className="whichkey-title">{r.title}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="whichkey-footer">
        <span className="whichkey-prefix">{prefixKeyLabel(IS_MAC)}</span>
        <span>{t("whichKey.hint")}</span>
      </div>
    </div>
  );
}
