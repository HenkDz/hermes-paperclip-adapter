/**
 * Shared constants for the Hermes Agent adapter.
 */

/** Adapter type identifier registered with Paperclip. */
export const ADAPTER_TYPE = "hermes_local";

/** Human-readable label shown in the Paperclip UI. */
export const ADAPTER_LABEL = "Hermes Agent";

/** Default CLI binary name. */
export const HERMES_CLI = "hermes";

/** Default timeout for a single execution run (seconds). */
export const DEFAULT_TIMEOUT_SEC = 300;

/** Grace period after SIGTERM before SIGKILL (seconds). */
export const DEFAULT_GRACE_SEC = 10;

/** Default model to use if none specified. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4";

/**
 * Valid --provider choices for the hermes CLI.
 * Must stay in sync with `hermes chat --help`.
 */
export const VALID_PROVIDERS = [
  "auto",
  "openrouter",
  "nous",
  "openai-codex",
  "copilot",
  "copilot-acp",
  "anthropic",
  "huggingface",
  "zai",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "kilocode",
] as const;

/**
 * Model-name prefix → provider hint mapping.
 * Used when no explicit provider is configured and we need to infer
 * the correct provider from the model string alone.
 *
 * Keys are lowercased prefix patterns; values must be valid provider names.
 * Longer prefixes are matched first (order matters).
 */
export const MODEL_PREFIX_PROVIDER_HINTS: [string, string][] = [
  // OpenAI-native models
  ["gpt-4", "openai-codex"],
  ["gpt-5", "copilot"],
  ["o1-", "openai-codex"],
  ["o3-", "openai-codex"],
  ["o4-", "openai-codex"],
  // Anthropic models
  ["claude", "anthropic"],
  // Google models (via openrouter or direct)
  ["gemini", "auto"],
  // Nous models
  ["hermes-", "nous"],
  // Z.AI / GLM models
  ["glm-", "zai"],
  // Kimi / Moonshot
  ["moonshot", "kimi-coding"],
  ["kimi", "kimi-coding"],
  // MiniMax
  ["minimax", "minimax"],
  // DeepSeek
  ["deepseek", "auto"],
  // Meta Llama
  ["llama", "auto"],
  // Qwen
  ["qwen", "auto"],
  // Mistral
  ["mistral", "auto"],
  // HuggingFace models (org/model format)
  ["huggingface/", "huggingface"],
];

/** Regex to extract session ID from Hermes CLI output. */
export const SESSION_ID_REGEX = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
export const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
export const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

/** Prefix used by Hermes for tool output lines. */
export const TOOL_OUTPUT_PREFIX = "┊";

/** Prefix for Hermes thinking blocks. */
export const THINKING_PREFIX = "💭";

// ── Profile constants ──────────────────────────────────────────────────────

/** Directory under HERMES_HOME where non-default profiles live. */
export const PROFILES_DIR = "profiles";

/** Auto-clone from the active profile when creating a new one for an agent. */
export const PROFILE_AUTO_CLONE = true;

// ── Reasoning effort levels ────────────────────────────────────────────────

/**
 * Valid reasoning effort levels for providers that support it.
 * Passed via `--reasoning-effort <level>` to the Hermes CLI.
 *
 * Not all models support reasoning effort — Hermes ignores it silently
 * for models that don't. The UI should show it as optional.
 */
export const VALID_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof VALID_REASONING_EFFORTS)[number];

/** Default reasoning effort when none specified. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

// ── Delivery targets ───────────────────────────────────────────────────────

/**
 * Valid delivery targets for run results.
 * When set, Hermes sends the run summary to the specified channel.
 */
export const VALID_DELIVERY_TARGETS = ["none", "telegram", "discord", "slack", "whatsapp", "signal"] as const;
export type DeliveryTarget = (typeof VALID_DELIVERY_TARGETS)[number];

/** Default: no delivery, results stay in Paperclip UI only. */
export const DEFAULT_DELIVERY_TARGET: DeliveryTarget = "none";

// ── Memory scope ───────────────────────────────────────────────────────────

/**
 * Memory persistence scope for the agent.
 *
 * - "session": Resume across heartbeats within the same Paperclip agent
 *   (default — uses Hermes --resume flag)
 * - "persistent": Resume across all runs, even if the agent is recreated
 *   (uses Hermes profile with its own memories directory)
 * - "ephemeral": No session resume, fresh start every heartbeat
 */
export const VALID_MEMORY_SCOPES = ["session", "persistent", "ephemeral"] as const;
export type MemoryScope = (typeof VALID_MEMORY_SCOPES)[number];

/** Default memory scope. */
export const DEFAULT_MEMORY_SCOPE: MemoryScope = "session";
