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

export interface TranscriptEntry {
  kind: "system" | "stderr" | "thinking" | "tool_call" | "tool_result" | "assistant" | "stdout";
  ts: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
  content?: string;
  isError?: boolean;
  delta?: boolean;
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

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();

    if (!trimmed) {
      suppressContinuation = false;
      return [];
    }

    if (trimmed.startsWith("[hermes]") || trimmed.startsWith("[paperclip]")) {
      suppressContinuation = false;
      return [{ kind: "system", ts, text: trimmed }];
    }

    if (trimmed.startsWith("[tool]")) {
      return [];
    }

    if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      suppressContinuation = false;
      return [{ kind: "stderr", ts, text: trimmed }];
    }

    if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(trimmed)) {
      return [];
    }

    if (trimmed.startsWith("session_id:")) {
      suppressContinuation = false;
      return [{ kind: "system", ts, text: trimmed }];
    }

    // ── ┊-prefixed lines ──────────────────────────────────────────────
    if (trimmed.includes(TOOL_OUTPUT_PREFIX)) {
      if (isAssistantToolLine(trimmed)) {
        suppressContinuation = false;
        return [{ kind: "thinking", ts, text: extractAssistantText(trimmed) }];
      }

      const toolInfo = parseToolCompletionLine(trimmed);
      if (toolInfo) {
        const id = syntheticToolUseId();
        const detailText = toolInfo.duration
          ? `${toolInfo.detail}  ${toolInfo.duration}`
          : toolInfo.detail;
        suppressContinuation = true;
        return [
          { kind: "tool_call", ts, name: toolInfo.name, input: { detail: toolInfo.detail }, toolUseId: id },
          { kind: "tool_result", ts, toolUseId: id, content: detailText, isError: toolInfo.hasError },
        ];
      }

      const stripped = trimmed
        .replace(/^\[done\]\s*/, "")
        .replace(new RegExp(`^${TOOL_OUTPUT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "")
        .trim();
      suppressContinuation = false;
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
        return [{ kind: "assistant", ts, text: trimmed }];
      }
      return [];
    }

    // ── Thinking / Error / Default ────────────────────────────────────
    if (isThinkingLine(trimmed)) {
      return [{ kind: "thinking", ts, text: trimmed.replace(/^💭\s*/, "") }];
    }
    if (trimmed.startsWith("Error:") || trimmed.startsWith("ERROR:") || trimmed.startsWith("Traceback")) {
      return [{ kind: "stderr", ts, text: trimmed }];
    }

    return [{ kind: "assistant", ts, text: trimmed }];
  }

  function reset(): void {
    suppressContinuation = false;
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
