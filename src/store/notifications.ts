// 通知中心 store：純列表操作（notificationCenter.ts）的薄 Zustand 包裝。
// 刻意不持久化 —— 與 session / workspace 一樣，跨啟動不保存。
import { create } from "zustand";
import {
  isWaitingKind,
  NOTIFICATION_CAP,
  markAllNotificationsRead,
  markNotificationRead,
  pushNotification,
  resolveSessionNotifications,
  type AppNotification,
  type NotifyKind,
} from "./notificationCenter";
import { appendJournalEntry } from "./eventJournal";

interface NotificationsState {
  items: AppNotification[];
  push: (n: {
    kind: NotifyKind;
    sessionId: string;
    sessionTitle: string;
    agentLabel?: string;
    text?: string;
  }) => void;
  /** 開機時把事件日記讀回來的歷史項目放到列表前面（見 store/eventJournal）。 */
  hydrate: (history: AppNotification[]) => void;
  resolveSession: (sessionId: string) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  items: [],

  push: (n) => {
    const item: AppNotification = {
      ...n,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      read: false,
      // 非 waiting 類（done / error / interrupted / stalled）是瞬時事件，無
      // 「待處理」狀態；waiting 類等回答後才 resolve。
      resolved: !isWaitingKind(n.kind),
    };
    const next = pushNotification(get().items, item);
    if (next === get().items) return; // 去重掉的重複事件不該寫進日記
    set({ items: next });
    appendJournalEntry(item);
  },

  // 歷史項目已由日記端標成 resolved + read（開機時不該有未讀紅點），這裡只
  // 負責接在現有列表前面並守住上限。
  hydrate: (history) => {
    if (history.length === 0) return;
    const merged = [...history, ...get().items];
    set({
      items:
        merged.length > NOTIFICATION_CAP
          ? merged.slice(merged.length - NOTIFICATION_CAP)
          : merged,
    });
  },

  resolveSession: (sessionId) => {
    const next = resolveSessionNotifications(get().items, sessionId);
    if (next !== get().items) set({ items: next });
  },

  markRead: (id) => {
    const next = markNotificationRead(get().items, id);
    if (next !== get().items) set({ items: next });
  },

  markAllRead: () => {
    const next = markAllNotificationsRead(get().items);
    if (next !== get().items) set({ items: next });
  },
}));
