/**
 * Self-contained UI stdout parser for the Hermes Agent adapter.
 *
 * This file is designed to be served to the Paperclip UI for dynamic loading.
 * It has ZERO external runtime imports — all constants are inlined.
 *
 * Usage (by Paperclip UI):
 *   const { createStdoutParser } = await import("./ui-parser.js");
 *   const parser = createStdoutParser();
 *   const entries = parser.parseLine(line, timestamp);
 *
 * The exported `createStdoutParser()` factory returns a stateful parser
 * (tracks multi-line command continuation across calls).
 */

// ── Inlined constants (no imports) ─────────────────────────────────────────

const TOOL_OUTPUT_PREFIX = "\u250A"; // ┊

// ── Kaomoji / noise stripping ──────────────────────────────────────────────

function stripKaomoji(text: string): string {
  return text.replace(/[(][^()]{2,20}[)]\s*/gu, "").trim();
}

// ── Line classification ────────────────────────────────────────────────────

function isAssistantToolLine(stripped: string): boolean {
  return /^┊\s*💬/.test(stripped);
}

function extractAssistantText(line: string): string {
  return line.replace(/^[\s┊]*💬\s*/, "").trim();
}

// ── Tool completion parsing ────────────────────────────────────────────────

interface ToolCompletion {
  name: string;
  detail: string;
  duration: string;
  hasError: boolean;
}

function stripLeadingToolIcon(text: string): string {
  // Hermes quiet output prefixes tool lines with a decorative emoji:
  //   💻 $ curl ...
  //   ✍️ write file.ts
  // That emoji is UI chrome, not the tool name. Strip one leading emoji
  // sequence so the parser sees the real verb (`$`, `write`, `read`, ...).
  return text.replace(/^(?:\p{Emoji}\uFE0F?(?:\u200D\p{Emoji}\uFE0F?)*)\s+/u, "").trim();
}

function parseToolCompletionLine(line: string): ToolCompletion | null {
  let cleaned = line.trim().replace(/^\[done\]\s*/, "");
  if (!cleaned.startsWith(TOOL_OUTPUT_PREFIX)) return null;

  cleaned = cleaned.slice(TOOL_OUTPUT_PREFIX.length);
  cleaned = stripKaomoji(cleaned).trim();

  const durationMatch = cleaned.match(/([\d.]+s)\s*(?:\([\d.]+s\))?\s*$/);
  const duration = durationMatch ? durationMatch[1] : "";

  let verbAndDetail = durationMatch
    ? cleaned.slice(0, cleaned.lastIndexOf(durationMatch[0])).trim()
    : cleaned;
  verbAndDetail = stripLeadingToolIcon(verbAndDetail);

  const hasError =
    /\[(?:exit \d+|error|full)\]/.test(verbAndDetail) ||
    /\[error\]\s*$/.test(cleaned);

  const parts = verbAndDetail.match(/^(\S+)\s+(.*)/);
  if (!parts) return { name: "tool", detail: verbAndDetail, duration, hasError };

  const verb = parts[1];
  const detail = parts[2].trim();

  const nameMap: Record<string, string> = {
    $: "shell",
    exec: "shell",
    terminal: "shell",
    search: "search",
    fetch: "fetch",
    crawl: "crawl",
    navigate: "browser",
    snapshot: "browser",
    click: "browser",
    type: "browser",
    scroll: "browser",
    back: "browser",
    press: "browser",
    close: "browser",
    images: "browser",
    vision: "browser",
    read: "read",
    write: "write",
    patch: "patch",
    grep: "search",
    find: "search",
    plan: "plan",
    recall: "recall",
    proc: "process",
    delegate: "delegate",
    todo: "todo",
    memory: "memory",
    clarify: "clarify",
    session_search: "recall",
    code: "execute",
    execute: "execute",
    web_search: "search",
    web_extract: "fetch",
    browser_navigate: "browser",
    browser_click: "browser",
    browser_type: "browser",
    browser_snapshot: "browser",
    browser_vision: "browser",
    browser_scroll: "browser",
    browser_press: "browser",
    browser_back: "browser",
    browser_close: "browser",
    browser_get_images: "browser",
    read_file: "read",
    write_file: "write_file",
    search_files: "search",
    patch_file: "patch",
    execute_code: "execute",
  };

  const name = nameMap[verb.toLowerCase()] || verb;
  return { name, detail, duration, hasError };
}

// ── Stateful parser ────────────────────────────────────────────────────────

let toolCallCounter = 0;

function syntheticToolUseId(): string {
  return `hermes-tool-${++toolCallCounter}`;
}

function isThinkingLine(line: string): boolean {
  return (
    line.includes("\uD83D\uDCAD") ||
    line.startsWith("<thinking>") ||
    line.startsWith("</thinking>") ||
    line.startsWith("Thinking:")
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

function buildToolInput(name: string, detail: string): Record<string, unknown> {
  if (name === "shell") {
    return { command: detail.replace(/^\$\s*/, "").trim() };
  }
  if (name === "read" || name === "write" || name === "write_file" || name === "patch") {
    return { path: detail };
  }
  return { detail };
}

function buildToolResult(name: string, detail: string, duration: string, hasError: boolean): string {
  if (name === "shell") {
    const command = detail.replace(/^\$\s*/, "").trim();
    return [
      `command: ${command}`,
      `status: ${hasError ? "error" : "completed"}`,
      ...(hasError ? [] : ["exit_code: 0"]),
      duration ? "" : null,
      duration ? `duration: ${duration}` : null,
    ].filter((line): line is string => line !== null).join("\n");
  }
  return duration ? `${detail}  ${duration}` : detail;
}

export interface TranscriptEntry {
  kind: "system" | "stderr" | "thinking" | "tool_call" | "tool_result" | "assistant" | "stdout" | "diff";
  ts: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
  content?: string;
  isError?: boolean;
  delta?: boolean;
  changeType?: "add" | "remove" | "context" | "hunk" | "file_header" | "truncation";
}

export interface StdoutParser {
  /** Parse a single line of Hermes stdout into transcript entries. */
  parseLine(line: string, ts: string): TranscriptEntry[];
  /** Reset internal state (e.g., between runs). */
  reset(): void;
}

/**
 * Create a stateful stdout parser instance.
 *
 * Each call returns a fresh parser with its own continuation-tracking state.
 * This is important because the parser is a singleton module in the browser —
 * multiple concurrent runs must not share continuation state.
 */
export function createStdoutParser(): StdoutParser {
  let suppressContinuation = false;
  let inDiffBlock = false;
  let diffOldRemaining = 0;
  let diffNewRemaining = 0;
  let suppressScratchDiffBlock = false;

  // ── Pre-tool-invocation suppression ────────────────────────────────────
  let lastWasProse = false;
  let inPreToolBlock = false;

  // Hermes can echo the entire query/prompt in non-quiet/resume output before
  // the agent starts. That prompt belongs in adapter.invoke metadata, not the
  // Nice transcript.
  let inPromptEcho = false;
  let inStartupPrelude = false;

  function isToolInvocationLine(line: string): boolean {
    // Network commands (require flags to distinguish from prose mentions)
    if (/^(?:curl|wget|ssh|scp|rsync)\b/.test(line) && / -[A-Za-z]/.test(line)) return true;
    // Dev-tool commands (bare word + any args = invocation, not prose)
    if (/^(?:git|npm|bun|yarn|pnpm|docker|kubectl|aws|gh)\b/.test(line) && /\s/.test(line)) return true;
    // Runtime / package managers
    if (/^(?:python3?|node|npx|pip3?)\s/.test(line)) return true;
    // File / shell commands commonly used as tool arguments
    if (/^(?:cat|less|more|head|tail|grep|egrep|fgrep|sed|awk|find|ls|cd|mkdir|rmdir|rm|mv|cp|chmod|chown|touch|ln|stat|file|wc|sort|uniq|diff|tee|xargs|cut|tr|echo|source|export|env|which|pwd|tar|zip|unzip)\b/.test(line) && /\s/.test(line)) return true;
    // Flag-only lines: -H, -d, -X, -s, etc. (shell continuation)
    if (/^-[^-\s]/.test(line)) return true;
    // Lines ending with backslash (shell line continuation)
    if (line.endsWith("\\")) return true;
    // Lines starting with backslash (continuation marker)
    if (/^\\/.test(line)) return true;
    return false;
  }

  function isHeredocTerminatorWithDuration(line: string): boolean {
    // Hermes sometimes renders Python heredoc terminal output as:
    //   ┊ 💻 $         python3 - <<'PY'
    //   PY  0.2s
    // The second line is CLI/tool timing chrome, not assistant prose.
    // Keep this scoped to suppressContinuation so normal prose is unaffected.
    return /^[A-Z_][A-Z0-9_]*\s+\d+(?:\.\d+)?s\s*(?:\([\d.]+s\))?$/i.test(line);
  }

  function resetDiffBlock(): void {
    inDiffBlock = false;
    diffOldRemaining = 0;
    diffNewRemaining = 0;
    suppressScratchDiffBlock = false;
  }

  function isScratchDiffPath(filePath: string): boolean {
    // Hermes often writes short-lived JSON payloads to /tmp before posting to
    // Paperclip APIs. The write tool itself is useful; the one-line JSON diff
    // is internal scratch noise and unlike source edits should not get a diff
    // card in Nice view.
    return /^(?:\/?tmp\/|\/?var\/tmp\/|\/?private\/tmp\/)/.test(filePath);
  }

  function parseDiffHunkHeader(trimmed: string): { oldCount: number; newCount: number } | null {
    const match = trimmed.match(/^@@\s+-\d+(?:,(\d+))?\s+\+\d+(?:,(\d+))?\s+@@/);
    if (!match) return null;
    return {
      oldCount: match[1] === undefined ? 1 : Number(match[1]),
      newCount: match[2] === undefined ? 1 : Number(match[2]),
    };
  }

  function consumeDiffLine(kind: "add" | "remove" | "context"): void {
    if (kind === "add") {
      diffNewRemaining = Math.max(0, diffNewRemaining - 1);
    } else if (kind === "remove") {
      diffOldRemaining = Math.max(0, diffOldRemaining - 1);
    } else {
      diffOldRemaining = Math.max(0, diffOldRemaining - 1);
      diffNewRemaining = Math.max(0, diffNewRemaining - 1);
    }
  }

  function classifyDiffLine(trimmed: string): { entry: TranscriptEntry | null; consumed: boolean } {
    // Hunk header: @@ -X,Y +X,Y @@
    const hunk = parseDiffHunkHeader(trimmed);
    if (hunk) {
      diffOldRemaining = hunk.oldCount;
      diffNewRemaining = hunk.newCount;
      return { entry: null, consumed: true }; // Skip hunk headers — they're noise for the UI
    }
    // File header: a/path → b/path
    if (/^a\/.*→.*b\//.test(trimmed)) {
      diffOldRemaining = 0;
      diffNewRemaining = 0;
      const filePath = trimmed.replace(/^a\//, "").replace(/\s*→.*$/, "");
      suppressScratchDiffBlock = isScratchDiffPath(filePath);
      return { entry: suppressScratchDiffBlock ? null : { kind: "diff", ts: "", changeType: "file_header", text: filePath }, consumed: true };
    }
    // Truncation notice: "… omitted N diff line(s) across M additional file(s)/section(s)"
    if (/^…\s*omitted/.test(trimmed)) {
      diffOldRemaining = 0;
      diffNewRemaining = 0;
      return { entry: suppressScratchDiffBlock ? null : { kind: "diff", ts: "", changeType: "truncation", text: trimmed }, consumed: true };
    }
    if (diffOldRemaining <= 0 && diffNewRemaining <= 0) {
      // Hermes can emit final prose/markdown bullets immediately after the
      // last review diff. Once the hunk counts are consumed, bare lines are
      // prose again — even if they begin with +/-.
      return { entry: null, consumed: false };
    }
    // Removal (but not --- which is the old-file marker in a file header)
    if (/^-/.test(trimmed) && !/^---/.test(trimmed)) {
      consumeDiffLine("remove");
      return { entry: suppressScratchDiffBlock ? null : { kind: "diff", ts: "", changeType: "remove", text: trimmed.slice(1) }, consumed: true };
    }
    // Addition (but not +++ which is the new-file marker)
    if (/^\+/.test(trimmed) && !/^\+\+\+/.test(trimmed)) {
      consumeDiffLine("add");
      return { entry: suppressScratchDiffBlock ? null : { kind: "diff", ts: "", changeType: "add", text: trimmed.slice(1) }, consumed: true };
    }
    // Context line (bare code, no prefix)
    consumeDiffLine("context");
    return { entry: suppressScratchDiffBlock ? null : { kind: "diff", ts: "", changeType: "context", text: trimmed }, consumed: true };
  }

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();

    // Hermes review-diff output often has blank separator lines between the
    // marker, file header, hunk header, and every displayed diff line. Keep the
    // diff block open across those separators; do not count them as hunk lines.
    if (inDiffBlock && !trimmed) {
      suppressContinuation = false;
      return [];
    }

    if (inPromptEcho && !trimmed) {
      return [];
    }

    if (inStartupPrelude && !trimmed) {
      return [];
    }

    if (!trimmed) {
      suppressContinuation = false;
      inPreToolBlock = false;
      lastWasProse = false;
      return [];
    }

    if (trimmed.startsWith("Query:")) {
      inPromptEcho = true;
      inStartupPrelude = false;
      suppressContinuation = false;
      resetDiffBlock();
      lastWasProse = false;
      inPreToolBlock = false;
      return [];
    }

    if (inPromptEcho) {
      if (trimmed === "Initializing agent...") {
        inPromptEcho = false;
        inStartupPrelude = true;
      }
      return [];
    }

    if (inStartupPrelude) {
      if (trimmed.includes(TOOL_OUTPUT_PREFIX)) {
        inStartupPrelude = false;
        // Fall through to normal ┊ handling below.
      } else {
        return [];
      }
    }

    // ── Hermes box-drawing banner (╭─ ⚕ Hermes ── / ╰── / │ content / ─ ⚕ Hermes ─) ──
    if (/^╭[─┄┈┅┆│ ⚕]/.test(trimmed) || /^╰[─┄┈┅┆│]/.test(trimmed) || /^│/.test(trimmed) || /^─+\s*⚕\s*Hermes\s*─/.test(trimmed) || /^[─-]{20,}$/.test(trimmed)) {
      return [];
    }

    // ── Hermes footer / resume hints ─────────────────────────────────────
    if (trimmed === "Resume this session with:" || /^hermes\s+--resume\s+\S+/.test(trimmed) || /^Session:\s+\S+/.test(trimmed) || /^Duration:\s+\S+/.test(trimmed) || /^Messages:\s+\d+/.test(trimmed)) {
      return [];
    }

    if (trimmed.startsWith("[hermes]") || trimmed.startsWith("[paperclip]")) {
      suppressContinuation = false;
      resetDiffBlock();
      lastWasProse = false;
      return [{ kind: "system", ts, text: trimmed }];
    }

    if (trimmed.startsWith("[tool]")) {
      lastWasProse = false;
      return [];
    }

    // ── Hermes 0.7.0 "preparing" lines ──────────────────────────────
    // e.g. "📖 preparing read_file…" — tool announcement, not prose
    if (/^.\s+preparing\s+/.test(trimmed)) {
      lastWasProse = false;
      return [];
    }

    if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      suppressContinuation = false;
      lastWasProse = false;
      return [{ kind: "stderr", ts, text: trimmed }];
    }

    if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(trimmed)) {
      return [];
    }

    if (trimmed.startsWith("session_id:")) {
      suppressContinuation = false;
      resetDiffBlock();
      lastWasProse = false;
      return [{ kind: "system", ts, text: trimmed }];
    }

    // ── Diff block detection ──────────────────────────────────────────
    // After "┊ review diff", subsequent non-┊ lines are diff content
    if (inDiffBlock) {
      if (trimmed.includes(TOOL_OUTPUT_PREFIX)) {
        resetDiffBlock();
        // Fall through to normal ┊ handling below
      } else if (!trimmed) {
        return [];
      } else {
        const diff = classifyDiffLine(trimmed);
        if (diff.consumed) return diff.entry ? [{ ...diff.entry, ts }] : [];
        resetDiffBlock();
        // Fall through and parse this same line as normal prose/output.
      }
    }

    // ── ┊-prefixed lines ──────────────────────────────────────────────
    if (trimmed.includes(TOOL_OUTPUT_PREFIX)) {
      if (isAssistantToolLine(trimmed)) {
        suppressContinuation = false;
        lastWasProse = true;
        return [{ kind: "thinking", ts, text: extractAssistantText(trimmed) }];
      }

      // Detect "┊ review diff" — signals start of diff output (no emoji/verb/duration)
      const afterPipe = trimmed.replace(/^┊\s*/, "").trim();
      if (/^review\s+diff$/.test(afterPipe)) {
        suppressContinuation = false;
        lastWasProse = false;
        inDiffBlock = true;
        diffOldRemaining = 0;
        diffNewRemaining = 0;
        return []; // Marker only — no visible output
      }

      const toolInfo = parseToolCompletionLine(trimmed);
      if (toolInfo) {
        const id = syntheticToolUseId();
        const input = buildToolInput(toolInfo.name, toolInfo.detail);
        const resultText = buildToolResult(toolInfo.name, toolInfo.detail, toolInfo.duration, toolInfo.hasError);
        suppressContinuation = true;
        lastWasProse = false;
        return [
          { kind: "tool_call", ts, name: toolInfo.name, input, toolUseId: id },
          { kind: "tool_result", ts, toolUseId: id, content: resultText, isError: toolInfo.hasError },
        ];
      }

      const stripped = trimmed
        .replace(/^\[done\]\s*/, "")
        .replace(new RegExp(`^${TOOL_OUTPUT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "")
        .trim();
      suppressContinuation = false;
      lastWasProse = false;
      return [{ kind: "stdout", ts, text: stripped }];
    }

    // ── Multi-line continuation suppression ──────────────────────────
    if (suppressContinuation) {
      if (!trimmed) {
        suppressContinuation = false;
        return [];
      }
      // Bare duration line: "1.2s" or "'  1.2s" — end of tool body
      if (/^\s*\d+\.\d+s\s*$/.test(trimmed)) {
        suppressContinuation = false;
        return [];
      }
      if (/^["']\s*\d+\.\d+s\s*$/.test(trimmed)) {
        suppressContinuation = false;
        return [];
      }
      // Heredoc terminator + duration: "PY  0.2s", "EOF  1.2s".
      if (isHeredocTerminatorWithDuration(trimmed)) {
        suppressContinuation = false;
        return [];
      }
      // Duration at end of a continuation line: '...json}'  1.2s
      if (/\d+\.\d+s\s*$/.test(trimmed) && /^(["']?\s*[-\\])/.test(trimmed)) {
        suppressContinuation = false;
        return [];
      }
      if (trimmed.startsWith(TOOL_OUTPUT_PREFIX)) {
        suppressContinuation = false;
        return [{ kind: "assistant", ts, text: trimmed }];
      }
      // Shell/curl continuation flags — NEVER prose
      if (/^[-\\]/.test(trimmed)) {
        return [];
      }
      const codeKeywords = [
        "import ", "from ", "const ", "let ", "var ", "if ", "for ",
        "while ", "def ", "class ", "return ", "print(",
      ];
      const looksLikeProse =
        /^[A-Z\"*#\d(]/.test(trimmed) &&
        !/[{}()\[\];:=]/.test(trimmed.slice(0, 20)) &&
        !codeKeywords.some((kw) => trimmed.startsWith(kw));
      if (looksLikeProse) {
        suppressContinuation = false;
        lastWasProse = true;
        return [{ kind: "assistant", ts, text: trimmed }];
      }
      return [];
    }

    // ── Thinking / Error / Default ────────────────────────────────────
    if (isThinkingLine(trimmed)) {
      return [{ kind: "thinking", ts, text: trimmed.replace(/^💭\s*/, "") }];
    }
    if (trimmed.startsWith("Error:") || trimmed.startsWith("ERROR:") || trimmed.startsWith("Traceback")) {
      lastWasProse = false;
      return [{ kind: "stderr", ts, text: trimmed }];
    }

    // ── Pre-tool-invocation suppression ─────────────────────────────
    if (inPreToolBlock) {
      if (!trimmed) {
        inPreToolBlock = false;
        return [];
      }
      if (trimmed.startsWith(TOOL_OUTPUT_PREFIX)) {
        inPreToolBlock = false;
        lastWasProse = false;
        const stripped = trimmed
          .replace(/^\[done\]\s*/, "")
          .replace(new RegExp(`^${TOOL_OUTPUT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "")
          .trim();
        return [{ kind: "stdout", ts, text: stripped }];
      }
      return [];
    }

    if (lastWasProse && !inPreToolBlock) {
      if (isToolInvocationLine(trimmed)) {
        inPreToolBlock = true;
        lastWasProse = false;
        return [];
      }
    }

    lastWasProse = true;
    return [{ kind: "assistant", ts, text: trimmed }];
  }

  function reset(): void {
    suppressContinuation = false;
    resetDiffBlock();
    lastWasProse = false;
    inPreToolBlock = false;
    inPromptEcho = false;
    inStartupPrelude = false;
  }

  return { parseLine, reset };
}

/** Default singleton parser for simple usage. */
export const defaultParser: StdoutParser = createStdoutParser();

/**
 * Convenience: parse a line using the default singleton parser.
 * Matches the StdoutLineParser type signature expected by Paperclip UI.
 */
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return defaultParser.parseLine(line, ts);
}
