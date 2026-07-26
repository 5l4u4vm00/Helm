// Unified-diff parser (pure, no deps — node-testable).
// Input is git's own `diff` output, or the equivalent patch Rust synthesizes
// for untracked files, so both render through exactly one code path.
// .ts 副檔名：讓 node 測試（strip-types 模式）能直接載入本模組。

export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the old file (absent on added lines). */
  oldNo?: number;
  /** 1-based line number in the new file (absent on removed lines). */
  newNo?: number;
}

export interface DiffHunk {
  /** The raw `@@ ... @@` marker. */
  header: string;
  /** Optional section name git appends after the marker. */
  heading?: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  binary: boolean;
  added: number;
  removed: number;
  oldPath?: string;
  newPath?: string;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
}

// @@ -oldStart,oldCount +newStart,newCount @@ optional heading
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function emptyResult(): ParsedDiff {
  return {
    hunks: [],
    binary: false,
    added: 0,
    removed: 0,
    isNew: false,
    isDeleted: false,
    isRename: false,
  };
}

function stripPathPrefix(raw: string): string | undefined {
  const path = raw.trim();
  if (!path || path === "/dev/null") return undefined;
  // git prefixes with a/ and b/ unless --no-prefix was used.
  return /^[ab]\//.test(path) ? path.slice(2) : path;
}

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const out = emptyResult();
  if (!patch) return out;

  // Tolerate CRLF: git emits LF, but a patch that round-tripped through a
  // Windows tool would otherwise leave \r on every rendered line.
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = HUNK_RE.exec(line);
      if (!m) {
        // Malformed marker: drop the hunk rather than throwing, so the rest
        // of a mostly-valid patch still renders.
        hunk = null;
        continue;
      }
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      const heading = m[5]?.trim();
      hunk = { header: line, lines: [], ...(heading ? { heading } : {}) };
      out.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      // Header section, before the first hunk.
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
        out.binary = true;
      } else if (line.startsWith("new file mode")) {
        out.isNew = true;
      } else if (line.startsWith("deleted file mode")) {
        out.isDeleted = true;
      } else if (line.startsWith("rename from") || line.startsWith("rename to")) {
        out.isRename = true;
      } else if (line.startsWith("--- ")) {
        const p = stripPathPrefix(line.slice(4));
        if (p === undefined) out.isNew = true;
        else out.oldPath = p;
      } else if (line.startsWith("+++ ")) {
        const p = stripPathPrefix(line.slice(4));
        if (p === undefined) out.isDeleted = true;
        else out.newPath = p;
      }
      continue;
    }

    // Inside a hunk.
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" annotates the previous line; it is not
      // itself a diff line and must not be counted.
      continue;
    }
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
      out.added++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
      out.removed++;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line === "") {
      // A truly empty line inside a hunk is a context line whose single
      // leading space git dropped (or the trailing newline of the patch).
      hunk.lines.push({ kind: "ctx", text: "", oldNo: oldNo++, newNo: newNo++ });
    } else {
      // Anything else ends the hunk (e.g. the next `diff --git` header).
      hunk = null;
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
        out.binary = true;
      }
    }
  }

  // A trailing newline produces one phantom context line; drop it.
  const last = out.hunks[out.hunks.length - 1];
  if (last) {
    const tail = last.lines[last.lines.length - 1];
    if (tail && tail.kind === "ctx" && tail.text === "" && patch.endsWith("\n")) {
      last.lines.pop();
    }
  }

  return out;
}
