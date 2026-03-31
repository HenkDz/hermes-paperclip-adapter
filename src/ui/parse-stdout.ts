/**
 * Parse Hermes Agent stdout into TranscriptEntry objects for the Paperclip UI.
 *
 * Hermes CLI quiet-mode output patterns:
 *   Inner thought: "  ┊ 💬 {text}"              → thinking (stream-of-consciousness)
 *   Tool (TTY):    "  ┊ {emoji} {verb:9} {detail}  {duration}"
 *   Tool (pipe):   "  [done] ┊ {emoji} {verb:9} {detail}  {duration} ({total})"
 *   System:        "[hermes] ..."
 *   Assistant:     bare lines after activity    → the final "out loud" response
 *
 * We emit structured tool_call/tool_result pairs so Paperclip renders proper
 * tool cards (with status icons, expand/collapse) instead of raw stdout blocks.
 *
 * Output structure:
 *   All ┊ lines are internal activity (tool calls, inner thoughts).
 *   Bare lines (no ┊ prefix) that appear after tool activity or a blank line
 *   are the actual assistant response — these must NOT be suppressed.
 *
 * Multi-line commands: Hermes splits multi-line tool output across separate
 * stdout chunks (separated by \r\n). The first line has the ┊ prefix, but
 * continuation lines (the actual command body) do not. We suppress these
 * ONLY immediately after a tool_result, until a blank line resets the state.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";

import { TOOL_OUTPUT_PREFIX } from "../shared/constants.js";

// ── Kaomoji / noise stripping ──────────────────────────────────────────────

/**
 * Strip kawaii faces and decorative emoji from a tool summary line.
 * Leaves meaningful emoji (💻 for terminal, 🔍 for search, etc.) intact
 * by only stripping parenthesized kaomoji like (｡◕‿◕｡).
 */
function stripKaomoji(text: string): string {
  // Strip parenthesized kaomoji faces: (｡◕‿◕｡), (★ω★), etc.
  return text.replace(/[(][^()]{2,20}[)]\s*/gu, "").trim();
}

// ── Line classification ────────────────────────────────────────────────────

/** Check if a ┊ line is an assistant message (┊ 💬 ...). */
function isAssistantToolLine(stripped: string): boolean {
  return /^┊\s*💬/.test(stripped);
}

/** Extract assistant text from a ┊ 💬 line. */
function extractAssistantText(line: string): string {
  return line.replace(/^[\s┊]*💬\s*/, "").trim();
}

/**
 * Parse a tool completion line into structured data.
 *
 * Handles both TTY and pipe formats:
 *   TTY:  ┊ 💻 $         curl -s "..."  0.1s
 *   Pipe: [done] ┊ 💻 $   curl -s "..."  0.1s (0.5s)
 */
function parseToolCompletionLine(
  line: string,
): { name: string; detail: string; duration: string; hasError: boolean } | null {
  // Strip leading whitespace and [done] prefix
  let cleaned = line.trim().replace(/^\[done\]\s*/, "");

  // Must start with ┊
  if (!cleaned.startsWith(TOOL_OUTPUT_PREFIX)) return null;

  // Remove ┊ prefix and any leading kaomoji face
  cleaned = cleaned.slice(TOOL_OUTPUT_PREFIX.length);
  cleaned = stripKaomoji(cleaned).trim();

  // Now format is: "{emoji} {verb:9} {detail}  {duration}" or "{emoji} {verb:9} {detail}  {duration} ({total})"
  // Example: "💻 $         curl -s ..." or "🔍 search    pattern  0.1s"
  // The verb+detail are separated by whitespace, duration is at the end

  // Match: emoji + verb + detail + duration
  // Duration pattern: N.Ns (possibly followed by (N.Ns))
  const durationMatch = cleaned.match(/([\d.]+s)\s*(?:\([\d.]+s\))?\s*$/);
  const duration = durationMatch ? durationMatch[1] : "";

  // Remove duration from the end to get verb + detail
  let verbAndDetail = durationMatch
    ? cleaned.slice(0, cleaned.lastIndexOf(durationMatch[0])).trim()
    : cleaned;

  // Check for error suffixes
  const hasError = /\[(?:exit \d+|error|full)\]/.test(verbAndDetail) ||
    /\[error\]\s*$/.test(cleaned);

  // The first token (after emoji) is the verb, rest is detail
  // Verbs are always a single word or symbol ($ for terminal)
  const parts = verbAndDetail.match(/^(\S+)\s+(.*)/);
  if (!parts) {
    return { name: "tool", detail: verbAndDetail, duration, hasError };
  }

  const verb = parts[1];
  const detail = parts[2].trim();

  // Map Hermes verbs to readable tool names
  const nameMap: Record<string, string> = {
    "$": "shell",
    "exec": "shell",
    "terminal": "shell",
    "search": "search",
    "fetch": "fetch",
    "crawl": "crawl",
    "navigate": "browser",
    "snapshot": "browser",
    "click": "browser",
    "type": "browser",
    "scroll": "browser",
    "back": "browser",
    "press": "browser",
    "close": "browser",
    "images": "browser",
    "vision": "browser",
    "read": "read",
    "write": "write",
    "patch": "patch",
    "grep": "search",
    "find": "search",
    "plan": "plan",
    "recall": "recall",
    "proc": "process",
    "delegate": "delegate",
    "todo": "todo",
    "memory": "memory",
    "clarify": "clarify",
    "session_search": "recall",
    "code": "execute",
    "execute": "execute",
    "web_search": "search",
    "web_extract": "fetch",
    "browser_navigate": "browser",
    "browser_click": "browser",
    "browser_type": "browser",
    "browser_snapshot": "browser",
    "browser_vision": "browser",
    "browser_scroll": "browser",
    "browser_press": "browser",
    "browser_back": "browser",
    "browser_close": "browser",
    "browser_get_images": "browser",
    "read_file": "read",
    "write_file": "write_file",
    "search_files": "search",
    "patch_file": "patch",
    "execute_code": "execute",
  };

  const name = nameMap[verb.toLowerCase()] || verb;

  return { name, detail, duration, hasError };
}

// ── Synthetic tool ID generation ────────────────────────────────────────────

let toolCallCounter = 0;

/**
 * Generate a synthetic toolUseId for pairing tool_call with tool_result.
 * Paperclip uses this to match them in normalizeTranscript.
 */
function syntheticToolUseId(): string {
  return `hermes-tool-${++toolCallCounter}`;
}

// ── Multi-line command continuation tracking ───────────────────────────────

/**
 * Track multi-line command continuation state.
 *
 * After a tool_result is emitted, the NEXT line(s) may be continuation
 * noise from the command body (split across \r\n chunks). These are
 * immediately after the tool line with no blank separator.
 *
 * A blank line resets this state — it signals the end of tool activity
 * and the start of the actual assistant response (bare lines).
 */
let suppressContinuation = false;

// ── Thinking detection ─────────────────────────────────────────────────────

function isThinkingLine(line: string): boolean {
  return (
    line.includes("💭") ||
    line.startsWith("<thinking>") ||
    line.startsWith("</thinking>") ||
    line.startsWith("Thinking:")
  );
}

// ── Main parser ────────────────────────────────────────────────────────────

/**
 * Parse a single line of Hermes stdout into transcript entries.
 *
 * Emits structured tool_call/tool_result pairs (with synthetic IDs) so
 * Paperclip renders proper tool cards with status icons and expand/collapse.
 *
 * @param line  Raw stdout line from Hermes CLI
 * @param ts    ISO timestamp for the entry
 * @returns     Array of TranscriptEntry objects (may be empty)
 */
export function parseHermesStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  const trimmed = line.trim();

  // ── Blank line → resets continuation suppression ─────────────────────
  // Blank lines signal the boundary between tool activity and the
  // assistant's actual response. After a blank line, bare lines
  // are real output, not command continuation noise.
  if (!trimmed) {
    suppressContinuation = false;
    return [];
  }

  // ── System/adapter messages ────────────────────────────────────────────
  if (trimmed.startsWith("[hermes]") || trimmed.startsWith("[paperclip]")) {
    suppressContinuation = false;
    return [{ kind: "system", ts, text: trimmed }];
  }

  // ── Non-quiet mode tool start lines: [tool] (kaomoji) emoji verb ... ──
  // These are redundant — the tool_call/tool_result pair arrives later from
  // the ┊ completion line. Skip them to avoid duplicate entries.
  if (trimmed.startsWith("[tool]")) {
    return [];
  }

  // ── MCP / server init noise reclassified from stderr by wrappedOnLog ──
  // Pattern: [2026-03-25T10:40:53.941Z] INFO: ...
  // Emit as stderr so Paperclip groups them into the amber accordion.
  if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    suppressContinuation = false;
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  // ── Standalone spinner remnants: "💻 Completed", "💻\nCompleted", etc. ─
  // These are non-quiet mode spinner frame leftovers — skip them.
  if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(trimmed)) {
    return [];
  }

  // ── Session info line ────────────────────────────────────────────────
  if (trimmed.startsWith("session_id:")) {
    suppressContinuation = false;
    return [{ kind: "system", ts, text: trimmed }];
  }

  // ── Quiet-mode tool/message lines (prefixed with ┊) ────────────────────
  if (trimmed.includes(TOOL_OUTPUT_PREFIX)) {
    // Inner thought: ┊ 💬 {text} → thinking, not assistant output
    // These are the model's stream-of-consciousness while working.
    // The actual "out loud" response arrives as bare lines later.
    if (isAssistantToolLine(trimmed)) {
      suppressContinuation = false;
      return [{ kind: "thinking", ts, text: extractAssistantText(trimmed) }];
    }

    // Tool completion: ┊ {emoji} {verb} {detail} {duration}
    const toolInfo = parseToolCompletionLine(trimmed);
    if (toolInfo) {
      const id = syntheticToolUseId();
      const detailText = toolInfo.duration
        ? `${toolInfo.detail}  ${toolInfo.duration}`
        : toolInfo.detail;

      // Track this tool result for potential continuation lines
      suppressContinuation = true;

      return [
        {
          kind: "tool_call" as const,
          ts,
          name: toolInfo.name,
          input: { detail: toolInfo.detail },
          toolUseId: id,
        },
        {
          kind: "tool_result" as const,
          ts,
          toolUseId: id,
          content: detailText,
          isError: toolInfo.hasError,
        },
      ] as TranscriptEntry[];
    }

    // Fallback: raw ┊ line that doesn't match tool format
    const stripped = trimmed
      .replace(/^\[done\]\s*/, "")
      .replace(new RegExp(`^${TOOL_OUTPUT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "")
      .trim();
    suppressContinuation = false;
    return [{ kind: "stdout", ts, text: stripped }];
  }

  // ── Multi-line command continuation (noise) ─────────────────────────────
  // After a tool_result, bare lines are continuation noise from multi-line
  // command bodies split across \r\n chunks. Keep suppressing until a
  // blank line resets the state.
  //
  // We detect end-of-continuation by:
  //   1. Blank line → definite boundary
  //   2. Bare duration "1.0s" or closing-quote+duration → end of tool cmd
  //   3. Lines that look like prose (start with capital letter, no leading
  //      indentation, no code syntax) → likely real assistant output
  if (suppressContinuation) {
    // Blank line → end of tool block
    if (!trimmed) {
      suppressContinuation = false;
      return [];
    }
    // Duration-only line (trailing timing from tool command)
    if (/^\s*\d+\.\d+s\s*$/.test(trimmed)) {
      suppressContinuation = false;
      return [];
    }
    // Closing quote + duration: '"  1.0s or "' 1.0s
    if (/^["']\s*\d+\.\d+s\s*$/.test(trimmed)) {
      suppressContinuation = false;
      return [];
    }
    // Lines starting with ┊ are new tool/message activity, not continuation
    if (trimmed.startsWith(TOOL_OUTPUT_PREFIX)) {
      suppressContinuation = false;
      // Don't return here — let the ┊ handler above process it on next call
      // Actually we can't re-enter, so fall through after resetting
      return [{ kind: "assistant", ts, text: trimmed }];
    }
    // Duration at end of a continuation line: '-d '{"status":"done"}'  1.0s'
    if (/\d+\.\d+s\s*$/.test(trimmed) && /^(["']?\s*[-\\])/.test(trimmed)) {
      suppressContinuation = false;
      return [];
    }
    // Shell/curl continuation flags — NEVER prose
    if (/^[-\\]/.test(trimmed)) {
      return [];
    }
    // Heuristic: if the line looks like prose (not code), stop suppressing.
    // Code continuation lines typically have: leading whitespace, Python/JS syntax,
    // JSON, operators, closing brackets. Prose starts with a capital letter
    // or common sentence starters and has no code-like patterns.
    const looksLikeProse = /^[A-Z"*#\d(]/.test(trimmed) &&
      !/[{}()\[\];:=]/.test(trimmed.slice(0, 20)) &&
      !trimmed.startsWith("import ") &&
      !trimmed.startsWith("from ") &&
      !trimmed.startsWith("const ") &&
      !trimmed.startsWith("let ") &&
      !trimmed.startsWith("var ") &&
      !trimmed.startsWith("if ") &&
      !trimmed.startsWith("for ") &&
      !trimmed.startsWith("while ") &&
      !trimmed.startsWith("def ") &&
      !trimmed.startsWith("class ") &&
      !trimmed.startsWith("return ") &&
      !trimmed.startsWith("print(");
    if (looksLikeProse) {
      suppressContinuation = false;
      return [{ kind: "assistant", ts, text: trimmed }];
    }
    // Still looks like continuation code — suppress and keep tracking
    return [];
  }

  // ── Thinking blocks ────────────────────────────────────────────────────
  if (isThinkingLine(trimmed)) {
    return [
      {
        kind: "thinking",
        ts,
        text: trimmed.replace(/^💭\s*/, ""),
      },
    ];
  }

  // ── Error output ───────────────────────────────────────────────────────
  if (
    trimmed.startsWith("Error:") ||
    trimmed.startsWith("ERROR:") ||
    trimmed.startsWith("Traceback")
  ) {
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  // ── Bare line = actual assistant output ────────────────────────────────
  // In quiet mode, all ┊ lines are internal activity (tools, inner thoughts).
  // Bare lines are the assistant's final "out loud" response.
  return [{ kind: "assistant", ts, text: trimmed }];
}
