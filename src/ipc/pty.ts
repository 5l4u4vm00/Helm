// 前端呼叫 Rust PTY commands / 訂閱 PTY events 的封裝層。
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface SpawnOptions {
  id: string;
  cols: number;
  rows: number;
  shell?: string;
  cwd?: string;
  /** Workspace recipe 帶來的額外環境變數；Helm 自己的變數由 pty.rs 擋下不被覆寫。 */
  env?: Record<string, string>;
}

/**
 * Spawn a PTY; its output arrives on `onOutput` as raw bytes through an
 * invoke Channel (ordered, no base64/JSON round-trip). The channel has no
 * unlisten — it dies with the PTY (pty_kill ends the Rust reader thread).
 */
export function ptySpawn(
  options: SpawnOptions,
  onOutput: (bytes: Uint8Array) => void,
): Promise<void> {
  const channel = new Channel<ArrayBuffer | number[]>();
  channel.onmessage = (data) =>
    onOutput(data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data));
  return invoke("pty_spawn", { options, onOutput: channel });
}

// Write/resize/kill reject with "no pty session" once the shell has exited (the
// Rust reader thread removes the session on EOF); callers fire-and-forget
// (`void ptyWrite(...)`), so swallow here — input to a dead session is a no-op,
// not an error worth an unhandled rejection.
//
// try/catch 而不只是 .catch()：沒有 Tauri runtime 時（瀏覽器 npm run dev /
// Playwright）invoke 是**同步 throw**（讀不到 __TAURI_INTERNALS__），根本走不到
// .catch。少了它，Terminal 的 cleanup 在 `void ptyKill(id)` 就中斷，後面的
// term.dispose() 不會執行，接著就是 xterm 在已拆掉的 viewport 上噴錯。
// ptySpawn 刻意不套：它的 rejection 是有意義的訊號（Terminal 靠它落回 $HOME 並
// 決定要不要跳過 launchCommand）。
function ptyFireAndForget(cmd: string, args: Record<string, unknown>): Promise<void> {
  try {
    return invoke<void>(cmd, args).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return ptyFireAndForget("pty_write", { id, data });
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return ptyFireAndForget("pty_resize", { id, cols, rows });
}

export function ptyKill(id: string): Promise<void> {
  return ptyFireAndForget("pty_kill", { id });
}

/** 訂閱某個 PTY 的結束事件。 */
export function onPtyExit(id: string, callback: () => void): Promise<UnlistenFn> {
  return listen(`pty://exit/${id}`, () => callback());
}
