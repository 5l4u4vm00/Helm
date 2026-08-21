// 側欄寬度把手：pointer 拖曳調整寬度，雙擊回預設，方向鍵微調。
// 模式沿用 SplitLayout/SplitResizers.tsx（pointer capture + body class）。
//
// 刻意是 .sidebar 的**兄弟節點**、獨立的 tab 停留點：側欄的 region layer
// 已經把 h/ArrowLeft/l/ArrowRight 用在 collapse/expand/focus-parent
// （見 sidebarKeymap.ts 的 SIDEBAR_TABLE），把手若放在側欄內部會撞鍵。
import { useRef, useState } from "react";
import {
  useSettingsStore,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
} from "../../store/settings";
import { useT } from "../../i18n";
import "./SidebarResizer.css";

/** 方向鍵一次移動的 px；比 split 的 ratio 步進直觀（這裡單位就是 px）。 */
const KEY_STEP = 16;

export function SidebarResizer({ sidebarRef }: { sidebarRef: React.RefObject<HTMLElement | null> }) {
  const t = useT();
  const width = useSettingsStore((s) => s.sidebarWidth);
  const [dragging, setDragging] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    // 以側欄左緣為原點把游標位置直接映射成寬度；clamp 交給 setter。
    const left = sidebarRef.current?.getBoundingClientRect().left;
    if (left === undefined) return;
    const setWidth = useSettingsStore.getState().setSidebarWidth;

    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.classList.add("sidebar-resizing");

    const onMove = (ev: PointerEvent) => setWidth(ev.clientX - left);
    const onUp = (ev: PointerEvent) => {
      setWidth(ev.clientX - left);
      cleanup();
    };
    const cleanup = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("sidebar-resizing");
      setDragging(false);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const setWidth = useSettingsStore.getState().setSidebarWidth;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setWidth(width - KEY_STEP);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setWidth(width + KEY_STEP);
    } else if (e.key === "Enter") {
      e.preventDefault();
      setWidth(SIDEBAR_WIDTH_DEFAULT);
    }
  };

  return (
    <div
      ref={barRef}
      className={`sidebar-resizer ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("sidebar.resize")}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      tabIndex={0}
      title={t("sidebar.resize")}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => useSettingsStore.getState().setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
    />
  );
}
