/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat -q "..." -Q` as a child process, streams output,
 * and returns structured results to Paperclip.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             bypass dangerous-command approval prompts (agents have no TTY)
 *   --source           session source tag for filtering
 */

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  buildPaperclipEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
  appendWithCap,
  runningProcesses,
} from "@paperclipai/adapter-utils/server-utils";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_IDLE_TIMEOUT_SEC,
  DEFAULT_MODEL,
  DEFAULT_DELIVERY_TARGET,
  DEFAULT_MEMORY_SCOPE,
  VALID_PROVIDERS,
  VALID_DELIVERY_TARGETS,
  VALID_MEMORY_SCOPES,
  DEFAULT_RESUME_STRATEGY,
} from "../shared/constants.js";

import {
  detectModel,
  resolveProvider,
} from "./detect-model.js";

import {
  ensureProfile,
  resolveProfilePath,
} from "./profiles.js";

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as nodePath from "node:path";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT_TEMPLATE = `You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.

IMPORTANT: Use \`terminal\` tool with \`curl\` for ALL Paperclip API calls (web_extract and browser cannot access localhost).

Your Paperclip identity:
  Agent ID: {{agentId}}
  Company ID: {{companyId}}
  API Base: {{paperclipApiUrl}}

AUTH: Include \`-H "Authorization: Bearer $PAPERCLIP_API_KEY"\` on every curl request to the Paperclip API. This identifies you as this agent (not the board user). GET requests work without it in local mode, but mutating requests (POST/PATCH) need it for correct comment attribution.

Also use \`-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"\` on mutating requests so the server can link actions to this run.

IMPORTANT: Never pipe curl output into python3 (e.g. \`curl … | python3\`). The command safety scanner blocks pipes to interpreters. Instead save to a temp file then read it: \`curl -s URL -o /tmp/resp.json && python3 -m json.tool /tmp/resp.json\`

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools
2. When done, mark the issue as completed:
   \`curl -s -X PATCH "{{paperclipApiUrl}}/issues/{{taskId}}" -H "Content-Type: application/json" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -d '{"status":"done"}'\`
3. Post a completion comment on the issue summarizing what you did:
   \`curl -s -X POST "{{paperclipApiUrl}}/issues/{{taskId}}/comments" -H "Content-Type: application/json" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -d '{"body":"DONE: <your summary here>"}'\`
4. If this issue has a parent (check the issue body or comments for references like TRA-XX), post a brief notification on the parent issue so the parent owner knows:
   \`curl -s -X POST "{{paperclipApiUrl}}/issues/PARENT_ISSUE_ID/comments" -H "Content-Type: application/json" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -d '{"body":"{{agentName}} completed {{taskId}}. Summary: <brief>"}'\`
{{/taskId}}

{{#commentId}}
## Comment on This Issue

Someone commented. Read it:
   \`curl -s "{{paperclipApiUrl}}/issues/{{taskId}}/comments/{{commentId}}" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -o /tmp/comment.json && python3 -m json.tool /tmp/comment.json\`

Address the comment, POST a reply if needed, then continue working.
{{/commentId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List ALL open issues assigned to you (todo, backlog, in_progress):
   \`curl -s "{{paperclipApiUrl}}/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -o /tmp/pclip_issues.json && python3 -c "import json;issues=json.load(open('/tmp/pclip_issues.json'));[print(f'{i[\\\"identifier\\\"]} {i[\\\"status\\\"]:>12} {i[\\\"priority\\\"]:>6} {i[\\\"title\\\"]}') for i in issues if i['status'] not in ('done','cancelled')]" \`

2. If issues found, pick the highest priority one that is not done/cancelled and work on it:
   - Read the issue details: \`curl -s "{{paperclipApiUrl}}/issues/ISSUE_ID" -H "Authorization: Bearer $PAPERCLIP_API_KEY"\`
   - Do the work in the project directory: {{projectName}}
   - When done, mark complete and post a comment (see Workflow steps 2-4 above)

3. If no issues assigned to you, check for unassigned issues:
   \`curl -s "{{paperclipApiUrl}}/companies/{{companyId}}/issues?status=backlog" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -o /tmp/pclip_unassigned.json && python3 -c "import json;issues=json.load(open('/tmp/pclip_unassigned.json'));[print(f'{i[\\\"identifier\\\"]} {i[\\\"title\\\"]}') for i in issues if not i.get('assigneeAgentId')]" \`
   If you find a relevant issue, assign it to yourself:
   \`curl -s -X PATCH "{{paperclipApiUrl}}/issues/ISSUE_ID" -H "Content-Type: application/json" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -d '{"assigneeAgentId":"{{agentId}}","status":"todo"}'\`

4. If truly nothing to do, report briefly what you checked.
{{/noTask}}`;

function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): string {
  const template = cfgString(config.promptTemplate) || DEFAULT_PROMPT_TEMPLATE;

  // Task metadata comes from the heartbeat context (contextSnapshot),
  // NOT from adapterConfig. Paperclip populates context with taskId, wakeReason, etc.
  const context = (ctx.context ?? {}) as Record<string, unknown>;
  const taskId = cfgString(context?.taskId);
  const taskTitle = cfgString(context?.taskTitle) || cfgString(context?.issueTitle) || "";
  const taskBody = cfgString(context?.taskBody) || cfgString(context?.issueDescription) || cfgString(context?.description) || "";
  const commentId = cfgString(context?.commentId) || "";
  const wakeReason = cfgString(context?.wakeReason) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString(ctx.config?.companyName) || "";
  const projectName = cfgString(ctx.config?.projectName) || "";

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
  };

  // Handle conditional sections: {{#key}}...{{/key}}
  let rendered = template;

  // {{#taskId}}...{{/taskId}} — include if task is assigned
  rendered = rendered.replace(
    /\{\{#taskId\}\}([\s\S]*?)\{\{\/taskId\}\}/g,
    taskId ? "$1" : "",
  );

  // {{#noTask}}...{{/noTask}} — include if no task
  rendered = rendered.replace(
    /\{\{#noTask\}\}([\s\S]*?)\{\{\/noTask\}\}/g,
    taskId ? "" : "$1",
  );

  // {{#commentId}}...{{/commentId}} — include if comment exists
  rendered = rendered.replace(
    /\{\{#commentId\}\}([\s\S]*?)\{\{\/commentId\}\}/g,
    commentId ? "$1" : "",
  );

  // Replace remaining {{variable}} placeholders
  return renderTemplate(rendered, vars);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/**
 * Regex for legacy session output format.
 *
 * Hermes session IDs follow the format: YYYYMMDD_HHMMSS_<hash>
 * e.g. 20260330_221824_311fec
 *
 * The previous pattern ([a-zA-Z0-9_-]+) was too greedy and matched
 * prose like "Use a session ID from a previous CLI run" — capturing
 * the literal word "from" as a session ID, which poisoned the runtime
 * state permanently.
 */
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+(\d{8}_\d{6}_[a-f0-9]+)/i;

/** Validate a parsed session ID against Hermes format. Rejects garbage matches. */
function isValidHermesSessionId(id: string): boolean {
  return /^\d{8}_\d{6}_[a-f0-9]+$/.test(id);
}

/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
function cleanResponse(raw: string): string {
  // Track whether we're inside a tool-call block (┊ 💻, ┊ 📖, etc.)
  // Continuation lines of multi-line commands don't start with ┊,
  // so we suppress them by remembering we're still in a tool block.
  let inToolBlock = false;
  const lines = raw.split("\n");

  const filtered = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true; // keep blank lines for paragraph separation
    if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
    if (t.startsWith("session_id:")) return false;
    if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
    if (/^\[done\]\s*┊/.test(t)) return false;

    // ┊ + emoji (except ┊ 💬) = tool activity line → start tool block, suppress
    // Use \p{Emoji} (not Emoji_Presentation) to catch emoji like ✍️ (U+270D+FE0F)
    // that use variation selectors and don't have Emoji_Presentation on the base char.
    if (/^┊\s*\p{Emoji}/u.test(t) && !/^┊\s*💬/.test(t)) {
      inToolBlock = true;
      return false;
    }

    // ┊ 💬 = inner thought (stream-of-consciousness) → suppress from summary
    // The actual assistant response arrives as bare lines later.
    if (/^┊\s*💬/.test(t)) {
      inToolBlock = false;
      return false;
    }

    // Tool result summary: "Done — output: ..." → suppress, end tool block
    if (/^Done\s*[—–-]\s*output:/.test(t)) {
      inToolBlock = false;
      return false;
    }

    // Bare duration line ("1.0s") or closing-quote+duration ('"  1.0s')
    // This signals the end of a tool call body
    if (/^["']?\s*\d+\.\d+s\s*$/.test(t)) {
      inToolBlock = false;
      return false;
    }

    // Status emoji alone (e.g. ✅, ❌ at start of line)
    if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;

    // Continuation lines inside a tool block (code body from multi-line commands)
    if (inToolBlock) return false;

    return true;
  });

  return filtered
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract only the final response block from Hermes stdout.
 *
 * Hermes outputs the full run (thinking + tool calls + final summary) to stdout.
 * We only want the last prose block after the last tool activity — the actual
 * deliverable, not intermediate reasoning.
 */
function extractFinalResponseBlock(stdout: string): string {
  // Split at session_id — everything before it is the response area
  const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
  const text = sessionLineIdx > 0 ? stdout.slice(0, sessionLineIdx) : stdout;
  const lines = text.split("\n");

  // Find the last tool-activity line (┊ + emoji)
  let lastToolIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (/^┊\s*\p{Emoji}/u.test(t) || /^\[done\]\s*┊/.test(t)) {
      lastToolIdx = i;
      break;
    }
  }

  if (lastToolIdx >= 0) {
    // Take everything after the last tool line, skip leading blanks
    const remaining = lines.slice(lastToolIdx + 1);
    const firstNonEmpty = remaining.findIndex((l) => l.trim() !== "");
    if (firstNonEmpty >= 0) {
      return cleanResponse(remaining.slice(firstNonEmpty).join("\n"));
    }
  }

  // No tool lines found — return cleaned full text
  return cleanResponse(text);
}

// ---------------------------------------------------------------------------
// Session usage from Hermes SQLite DB
// ---------------------------------------------------------------------------

/**
 * Read token usage and cost from the Hermes session database.
 *
 * Hermes tracks cumulative token counts (input, output, cache) in its SQLite
 * state.db but does NOT print them to stdout in quiet mode. After the subprocess
 * exits, we query the DB to get the final usage for this session.
 *
 * The DB lives at <hermes_home>/state.db (or <profile_path>/state.db).
 */
function readSessionUsageFromDb(
  sessionId: string,
  hermesHomeOverride?: string,
): { usage: UsageSummary; costUsd: number } | null {
  if (!sessionId) return null;

  try {
    // Resolve the DB path from the profile's HERMES_HOME or default
    const hermesHome = hermesHomeOverride
      || process.env.HERMES_HOME
      || nodePath.join(homedir(), ".hermes");
    const dbPath = nodePath.join(hermesHome, "state.db");

    // Check DB exists before querying
    fsSync.accessSync(dbPath, fsSync.constants.R_OK);

    // Use python3 to query SQLite (available wherever Hermes is installed).
    // This avoids adding better-sqlite3 as a Node.js dependency.
    const pythonScript = [
      "import sqlite3, json",
      "conn = sqlite3.connect('" + dbPath.replace(/'/g, "\\'") + "')",
      "conn.row_factory = sqlite3.Row",
      "row = conn.execute('SELECT input_tokens, output_tokens, cache_read_tokens, estimated_cost_usd, actual_cost_usd FROM sessions WHERE id = ?', ('" + sessionId + "',)).fetchone()",
      "conn.close()",
      "if row:",
      "    print(json.dumps({'input_tokens': row['input_tokens'] or 0, 'output_tokens': row['output_tokens'] or 0, 'cache_read_tokens': row['cache_read_tokens'] or 0, 'estimated_cost_usd': row['estimated_cost_usd'] or 0, 'actual_cost_usd': row['actual_cost_usd'] or 0}))",
      "else:",
      "    print('')",
    ].join("\n");

    const result = execSync(`python3 -c "${pythonScript.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!result) return null;

    const data = JSON.parse(result);
    const inputTokens = (data.input_tokens as number) || 0;
    const outputTokens = (data.output_tokens as number) || 0;
    const cacheReadTokens = (data.cache_read_tokens as number) || 0;

    // Skip if both are zero (session not yet written to DB, e.g. very short runs)
    if (inputTokens === 0 && outputTokens === 0) return null;

    return {
      usage: { inputTokens, outputTokens, ...(cacheReadTokens > 0 ? { cachedInputTokens: cacheReadTokens } : {}) },
      costUsd: (data.actual_cost_usd as number) || (data.estimated_cost_usd as number) || 0,
    };
  } catch {
    // Non-fatal — DB read failure shouldn't block the adapter result.
    // Common reasons: DB not yet written (race), profile path wrong, python3 missing.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  const rawSessionId = sessionMatch?.[1] ?? null;

  if (rawSessionId && isValidHermesSessionId(rawSessionId)) {
    result.sessionId = rawSessionId;
    // Extract only the final response block (after last tool activity),
    // not the full run output with intermediate reasoning.
    result.response = extractFinalResponseBlock(stdout);
  } else {
    // Legacy format (non-quiet mode)
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    const legacyId = legacyMatch?.[1] ?? null;
    if (legacyId && isValidHermesSessionId(legacyId)) {
      result.sessionId = legacyId;
    }
    // In non-quiet mode, extract clean response from stdout by
    // filtering out tool lines, system messages, and noise
    const cleaned = cleanResponse(stdout);
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  }

  // Extract token usage
  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  // Extract cost
  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  // Check for error patterns in stderr
  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Activity-aware child process runner
// ---------------------------------------------------------------------------

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

/**
 * Spawn a child process with a two-tier timeout strategy:
 *
 * 1. **Idle timeout** (`idleTimeoutSec`): Kill if no stdout/stderr activity for
 *    N seconds. Every data event resets the timer. This catches hung processes,
 *    stuck API calls, and infinite loops producing no output — while allowing
 *    long-running builds or LLM inference that continuously produce output.
 *
 * 2. **Hard max timeout** (`maxTimeoutSec`): Unconditional kill after N seconds
 *    regardless of activity. Safety net against runaway processes.
 *
 * When idle timeout fires, a log message is emitted before SIGTERM.
 * The grace period (SIGTERM → SIGKILL) uses `graceSec` from the adapter utils
 * runningProcesses map (so the server's terminate endpoint can also trigger it).
 */
function runChildProcessWithIdleTimeout(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    idleTimeoutSec: number;
    maxTimeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; idleKilled: boolean }> {
  return new Promise((resolve, reject) => {
    const mergedEnv = { ...process.env, ...opts.env } as NodeJS.ProcessEnv;

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: mergedEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcessWithEvents;

    let timedOut = false;
    let idleKilled = false;
    let stdout = "";
    let stderr = "";
    let logChain: Promise<void> = Promise.resolve();

    // Register with Paperclip's running processes map (for server terminate endpoint)
    runningProcesses.set(runId, { child, graceSec: opts.graceSec });

    // ── Idle timeout timer: resets on every stdout/stderr data event ──
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleKilled = true;
        timedOut = true;
        opts.onLog("stdout", `\n[hermes] IDLE TIMEOUT: No output for ${opts.idleTimeoutSec}s. Terminating subprocess.\n`)
          .catch(() => {});
        child.kill("SIGTERM");
        // SIGKILL after grace period (same pattern as adapter-utils)
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, Math.max(1, opts.graceSec) * 1000);
      }, opts.idleTimeoutSec * 1000);
    };

    // Start the idle timer
    resetIdleTimer();

    // ── Hard max timeout: unconditional kill regardless of activity ──
    const maxTimer = setTimeout(() => {
      timedOut = true;
      if (idleTimer) clearTimeout(idleTimer);
      opts.onLog("stdout", `\n[hermes] MAX TIMEOUT: Run exceeded ${opts.maxTimeoutSec}s hard limit. Terminating.\n`)
        .catch(() => {});
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, Math.max(1, opts.graceSec) * 1000);
    }, opts.maxTimeoutSec * 1000);

    // ── Stream handlers: capture output + reset idle timer ──
    child.stdout?.on("data", (chunk: unknown) => {
      const text = String(chunk);
      stdout = appendWithCap(stdout, text);
      logChain = logChain
        .then(() => opts.onLog("stdout", text))
        .catch(() => {});
      resetIdleTimer(); // Activity! Reset idle timer.
    });

    child.stderr?.on("data", (chunk: unknown) => {
      const text = String(chunk);
      stderr = appendWithCap(stderr, text);
      logChain = logChain
        .then(() => opts.onLog("stderr", text))
        .catch(() => {});
      resetIdleTimer(); // Activity! Reset idle timer.
    });

    // ── Cleanup ──
    const cleanup = () => {
      if (maxTimer) clearTimeout(maxTimer);
      if (idleTimer) clearTimeout(idleTimer);
      runningProcesses.delete(runId);
    };

    child.on("error", (err: Error) => {
      cleanup();
      reject(new Error(`Failed to start "${command}": ${err.message}`));
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      void logChain.finally(() => {
        resolve({ exitCode: code, signal, timedOut, stdout, stderr, idleKilled });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = cfgString(config.hermesCommand) || HERMES_CLI;
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);

  // Profile support
  const profileName = cfgString(config.profile);
  // Delivery target (where to send run results)
  const deliveryTarget = cfgString(config.deliveryTarget) || DEFAULT_DELIVERY_TARGET;

  // Memory scope controls session resume behavior
  const memoryScope = cfgString(config.memoryScope) || DEFAULT_MEMORY_SCOPE;

  // ── Resolve model + provider (defense in depth) ────────────────────────
  // Priority chain:
  //   1. Explicit model/provider in adapterConfig (user override)
  //   2. Model/provider from profile's config.yaml or default Hermes config
  //   3. Provider inferred from model name prefix
  //   4. "auto" (let Hermes decide) / DEFAULT_MODEL as last resort
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = cfgString(config.provider);
  const explicitModel = cfgString(config.model);

  // Detect model/provider from profile or default Hermes config.
  // This is used both for resolving the model fallback and for provider detection.
  if (!explicitProvider || !explicitModel) {
    try {
      detectedConfig = await detectModel(undefined, profileName);
    } catch {
      // Non-fatal — detection failure shouldn't block execution
    }
  }

  // Resolve model: explicit config > profile config > hardcoded default
  const model = explicitModel || detectedConfig?.model || DEFAULT_MODEL;

  const { provider: resolvedProvider, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    model,
  });

  // ── Build prompt ───────────────────────────────────────────────────────
  // Load agent instructions file if configured (like droid adapter does).
  // instructionsFilePath is resolved relative to the workspace cwd.
  const instructionsFilePath = cfgString(config.instructionsFilePath) || "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    // Resolve cwd early for instructions path resolution
    const instrCwd =
      cfgString(config.cwd) || cfgString(ctx.config?.workspaceDir) || ".";
    const resolvedPath = nodePath.resolve(instrCwd, instructionsFilePath);
    const instructionsDir = `${nodePath.dirname(resolvedPath)}/`;
    try {
      const instructionsContents = await fs.readFile(resolvedPath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${resolvedPath}. ` +
        `Resolve any relative file references from ${instructionsDir}.`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${resolvedPath}": ${reason}\n`,
      );
    }
  }

  const prompt = instructionsPrefix
    ? `${instructionsPrefix}\n\n${buildPrompt(ctx, config)}`
    : buildPrompt(ctx, config);

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) to get clean output: just response + session_id line
  const useQuiet = cfgBoolean(config.quiet) !== false; // default true
  const args: string[] = ["chat", "-q", prompt];
  if (useQuiet) args.push("-Q");

  // ── Build environment (before args, needed for profile HERMES_HOME) ───
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...buildPaperclipEnv(ctx.agent),
  };

  // Profile: -p is a global flag (must come before subcommand would,
  // but hermes chat also accepts it as a passthrough via extra position).
  // Actually -p is a top-level flag, so we use: hermes -p <name> chat -q ...
  // We handle this by setting HERMES_HOME instead, which is more reliable.
  if (profileName && profileName !== "default") {
    // Ensure profile exists (auto-create with --clone if missing)
    const profilePath = await ensureProfile(profileName);
    if (profilePath) {
      env.HERMES_HOME = profilePath;
      await ctx.onLog(
        "stdout",
        `[hermes] Using profile: ${profileName} (${profilePath})\n`,
      );
    } else {
      await ctx.onLog(
        "stdout",
        `[hermes] Warning: profile "${profileName}" could not be created, falling back to default\n`,
      );
    }
  }

  // When a profile is set and no explicit model/provider is in adapterConfig,
  // let Hermes use its own config.yaml (which we already detected from).
  // Only pass --model / --provider when explicitly configured in Paperclip
  // to avoid overriding the profile's settings with wrong credentials.
  const useProfileConfig = profileName && profileName !== "default" && !explicitModel && !explicitProvider;

  if (!useProfileConfig && model) {
    args.push("-m", model);
  }

  // Only pass --provider when explicitly configured or when not using profile config.
  // "auto" means Hermes will decide on its own — no need to pass it.
  if (!useProfileConfig && resolvedProvider !== "auto") {
    args.push("--provider", resolvedProvider);
  }

  if (toolsets) {
    args.push("-t", toolsets);
  }

  // Worktree mode (backward compat)
  if (cfgBoolean(config.worktreeMode) === true) args.push("-w");
  if (cfgBoolean(config.checkpoints) === true) args.push("--checkpoints");
  if (cfgBoolean(config.verbose) === true) args.push("-v");

  // Tag sessions as "tool" source so they don't clutter the user's session history.
  // Requires hermes-agent >= PR #3255 (feat/session-source-tag).
  args.push("--source", "tool");

  // Bypass Hermes dangerous-command approval prompts.
  // Paperclip agents run as non-interactive subprocesses with no TTY,
  // so approval prompts would always timeout and deny legitimate commands
  // (curl, python3 -c, etc.). Agents operate in a sandbox — the approval
  // system is designed for human-attended interactive sessions.
  args.push("--yolo");

  // Session resume — controlled by memoryScope + resumeStrategy
  const prevSessionParams = ctx.runtime?.sessionParams as Record<string, unknown> | null;
  const prevSessionId = cfgString(prevSessionParams?.sessionId);
  const resumeStrategy = cfgString(config.resumeStrategy) || DEFAULT_RESUME_STRATEGY;
  const persistSession = memoryScope !== "ephemeral";

  // Determine whether to resume the previous session
  let shouldResume = false;
  let resumeReason = "";

  if (!persistSession) {
    resumeReason = "ephemeral memory scope — always fresh";
  } else if (!prevSessionId) {
    resumeReason = "no previous session";
  } else if (resumeStrategy === "always") {
    shouldResume = true;
    resumeReason = "resumeStrategy=always";
  } else if (resumeStrategy === "never") {
    resumeReason = "resumeStrategy=never — starting fresh";
  } else {
    // "smart" (default) — decide based on previous run outcome
    const prevOutcome = cfgString(prevSessionParams?.previousRunOutcome) || "";
    const prevHadContextError = cfgBoolean(prevSessionParams?.previousRunHadContextError);

    if (!prevOutcome) {
      // sessionParams exists but no outcome metadata (legacy or first smart run)
      shouldResume = true;
      resumeReason = `no previous outcome recorded, defaulting to resume (session: ${prevSessionId.slice(0, 12)}…)`;
    } else if (prevOutcome === "success") {
      shouldResume = true;
      resumeReason = `previous run exited cleanly (code 0) — resuming`;
    } else if (prevOutcome === "idle_timeout") {
      shouldResume = true;
      resumeReason = `previous run hit idle timeout — resuming (agent was likely working)`;
    } else if (prevOutcome === "max_timeout") {
      shouldResume = false;
      resumeReason = `previous run hit max timeout — starting fresh (session likely bloated)`;
    } else if (prevOutcome === "sigkill") {
      shouldResume = false;
      resumeReason = `previous run was SIGKILLed (grace expired) — starting fresh (session corrupted)`;
    } else if (prevOutcome === "error" && prevHadContextError) {
      shouldResume = false;
      resumeReason = `previous run hit context/token limit — starting fresh`;
    } else if (prevOutcome === "error") {
      shouldResume = true;
      resumeReason = `previous run had a transient error (code != 0) — resuming`;
    } else {
      shouldResume = false;
      resumeReason = `unknown previous outcome "${prevOutcome}" — starting fresh (safe default)`;
    }
  }

  if (shouldResume && prevSessionId) {
    args.push("--resume", prevSessionId);
  }

  if (prevSessionId && !shouldResume) {
    await ctx.onLog(
      "stdout",
      `[hermes] Smart resume: NOT resuming session ${prevSessionId}. Reason: ${resumeReason}\n`,
    );
  }

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  // ── Inject agent identity and delivery target ────────────────────────
  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;
  const taskId = cfgString((ctx.context as Record<string, unknown>)?.taskId);
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;

  // Inject the agent JWT so curl commands can authenticate as this agent.
  // Without this, the Paperclip auth middleware falls back to "local_implicit"
  // board user, and all issue comments appear attributed to "You" instead of
  // the agent.  The Claude/Codex adapters follow the same pattern.
  const userEnv = config.env as Record<string, string> | undefined;
  const hasExplicitApiKey = typeof userEnv?.PAPERCLIP_API_KEY === "string" && userEnv.PAPERCLIP_API_KEY.trim().length > 0;
  if (!hasExplicitApiKey && ctx.authToken) {
    env.PAPERCLIP_API_KEY = ctx.authToken;
  }

  // Delivery target: tell Hermes where to send run results
  if (deliveryTarget && deliveryTarget !== "none" && (VALID_DELIVERY_TARGETS as readonly string[]).includes(deliveryTarget)) {
    env.HERMES_DELIVERY_TARGET = deliveryTarget;
  }

  const userEnvFinal = userEnv;
  if (userEnvFinal && typeof userEnvFinal === "object") {
    Object.assign(env, userEnvFinal);
  }

  // ── Resolve working directory ──────────────────────────────────────────
  const cwd =
    cfgString(config.cwd) || cfgString(ctx.config?.workspaceDir) || ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Report invocation metadata to Paperclip ───────────────────────────
  // This populates the RunInvocationCard in the UI.
  const commandNotes: string[] = [];
  if (model) commandNotes.push(`Model: ${model} (provider: ${resolvedProvider} [${resolvedFrom}])`);
  if (profileName && profileName !== "default") commandNotes.push(`Profile: ${profileName}`);
  if (toolsets) commandNotes.push(`Toolsets: ${toolsets}`);
  commandNotes.push(`Memory: ${memoryScope}${deliveryTarget !== "none" ? ` → ${deliveryTarget}` : ""}`);
  if (instructionsFilePath) commandNotes.push(`Instructions: ${instructionsFilePath}`);
  if (prevSessionId) commandNotes.push(`Resuming session: ${prevSessionId}`);

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: "hermes_local",
      command: hermesCmd,
      cwd,
      commandArgs: args,
      commandNotes,
      env,
      prompt,
      context: ctx.context as Record<string, unknown> | undefined,
    });
  }

  // ── Resolve timeout configuration ─────────────────────────────────────
  // Two-tier timeout strategy:
  //   - idleTimeoutSec: kill if no stdout/stderr activity for N seconds
  //   - maxTimeoutSec (formerly timeoutSec): hard kill regardless of activity
  //   - graceSec: polite shutdown window after SIGTERM
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const idleTimeoutSec = cfgNumber(config.idleTimeoutSec) || DEFAULT_IDLE_TIMEOUT_SEC;
  const maxTimeoutSec = cfgNumber(config.maxTimeoutSec) || cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, provider=${resolvedProvider} [${resolvedFrom}], memory=${memoryScope}${profileName && profileName !== "default" ? `, profile=${profileName}` : ""}${deliveryTarget !== "none" ? `, deliver=${deliveryTarget}` : ""}, resume=${resumeStrategy}${shouldResume ? "(resuming)" : "(fresh)"}, idle_timeout=${idleTimeoutSec}s, max_timeout=${maxTimeoutSec}s)\n`,
  );
  if (shouldResume && prevSessionId) {
    await ctx.onLog(
      "stdout",
      `[hermes] Resuming session: ${prevSessionId} (${resumeReason})\n`,
    );
  } else if (prevSessionId && !shouldResume) {
    // Already logged above in the smart resume section
  } else if (resumeReason) {
    await ctx.onLog(
      "stdout",
      `[hermes] Fresh session (${resumeReason})\n`,
    );
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Wrap onLog to reclassify benign stderr lines as stdout.
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stderr") {
      const trimmed = chunk.trimEnd();
      // Benign patterns that should NOT appear as errors:
      // - Structured log lines: [timestamp] INFO/DEBUG/WARN: ...
      // - MCP server registration messages
      // - Python import/site noise
      const isBenign = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) || // structured timestamps
        /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) || // log levels
        /Successfully registered all tools/.test(trimmed) ||
        /MCP [Ss]erver/.test(trimmed) ||
        /tool registered successfully/.test(trimmed) ||
        /Application initialized/.test(trimmed);
      if (isBenign) {
        return ctx.onLog("stdout", chunk);
      }
    }
    return ctx.onLog(stream, chunk);
  };

  const result = await runChildProcessWithIdleTimeout(ctx.runId, hermesCmd, args, {
    cwd,
    env,
    idleTimeoutSec,
    maxTimeoutSec,
    graceSec,
    onLog: wrappedOnLog,
  });

  // ── Parse output ───────────────────────────────────────────────────────
  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");

  await ctx.onLog(
    "stdout",
    `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (parsed.sessionId) {
    await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
  }

  // ── Read usage from Hermes session DB ──────────────────────────────────
  // Hermes tracks token counts in SQLite but doesn't print them to stdout.
  // Query the DB for accurate usage data after the subprocess exits.
  // Each profile has its own state.db at <profile_dir>/state.db.
  let hermesHomeForDb: string | undefined;
  if (profileName && profileName !== "default") {
    try {
      hermesHomeForDb = (await ensureProfile(profileName)) ?? undefined;
    } catch {
      // Profile resolution failed — fall through to default path
    }
  }
  const dbUsage = readSessionUsageFromDb(parsed.sessionId || "", hermesHomeForDb);

  // Prefer DB usage over regex-parsed usage (more accurate and complete)
  const finalUsage = dbUsage?.usage || parsed.usage;
  const finalCost = dbUsage?.costUsd ?? parsed.costUsd;

  if (dbUsage?.usage) {
    await ctx.onLog(
      "stdout",
      `[hermes] Usage (from session DB): ${dbUsage.usage.inputTokens} input, ${dbUsage.usage.outputTokens} output${dbUsage.usage.cachedInputTokens ? `, ${dbUsage.usage.cachedInputTokens} cached` : ""}\n`,
    );
  }

  // ── Build result ───────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: resolvedProvider,
    model,
  };

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  }

  if (finalUsage) {
    executionResult.usage = finalUsage;
  }

  if (finalCost !== undefined) {
    executionResult.costUsd = finalCost;
  }

  // Summary from agent response
  if (parsed.response) {
    executionResult.summary = parsed.response.slice(0, 2000);
  }

  // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments)
  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: parsed.sessionId || null,
    usage: finalUsage || null,
    cost_usd: finalCost ?? null,
  };

  // Store session ID for next run (respect memory scope)
  if (persistSession && parsed.sessionId) {
    // Determine outcome for smart resume
    let previousRunOutcome: string;
    const CONTEXT_ERROR_PATTERNS = [
      "context", "max length", "token limit", "too long",
      "prompt exceeds", "BadRequestError",
    ];
    const hadContextError = CONTEXT_ERROR_PATTERNS.some(
      (p) =>
        (parsed.errorMessage || "").toLowerCase().includes(p) ||
        (result.stderr || "").toLowerCase().includes(p),
    );

    if (result.idleKilled) {
      previousRunOutcome = "idle_timeout";
    } else if (result.timedOut) {
      previousRunOutcome = "max_timeout";
    } else if (result.signal === "SIGKILL") {
      previousRunOutcome = "sigkill";
    } else if (result.exitCode !== null && result.exitCode !== 0) {
      previousRunOutcome = "error";
    } else {
      previousRunOutcome = "success";
    }

    executionResult.sessionParams = {
      sessionId: parsed.sessionId,
      previousRunOutcome,
      previousRunExitCode: result.exitCode,
      previousRunSignal: result.signal,
      previousRunTimedOut: result.timedOut,
      previousRunIdleKilled: result.idleKilled,
      previousRunHadContextError: hadContextError,
    };
    executionResult.sessionDisplayId = parsed.sessionId;

    await ctx.onLog(
      "stdout",
      `[hermes] Run outcome: ${previousRunOutcome} (exit=${result.exitCode}, signal=${result.signal}, timedOut=${result.timedOut}, idleKilled=${result.idleKilled}) → stored for next smart resume decision\n`,
    );
  }

  return executionResult;
}
