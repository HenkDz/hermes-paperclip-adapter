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

// ── Provider & Model catalog ─────────────────────────────────────────────

/**
 * Human-readable provider labels for the config UI.
 * Keys must match VALID_PROVIDERS entries.
 */
export const PROVIDER_LABELS: Record<string, string> = {
  auto: "Auto (from profile config)",
  openrouter: "OpenRouter",
  nous: "Nous Portal",
  openai_codex: "OpenAI Codex",
  copilot: "GitHub Copilot",
  "copilot-acp": "GitHub Copilot ACP",
  anthropic: "Anthropic",
  huggingface: "Hugging Face",
  zai: "Z.AI / GLM",
  kimi_coding: "Kimi / Moonshot",
  minimax: "MiniMax",
  minimax_cn: "MiniMax (China)",
  kilocode: "Kilo Code",
  alibaba: "Alibaba Cloud",
  opencode_zen: "OpenCode Zen",
  opencode_go: "OpenCode Go",
  ai_gateway: "AI Gateway",
  deepseek: "DeepSeek",
  custom: "Custom endpoint",
};

/**
 * Static model catalog per provider.
 * Used for the combobox dropdown when a provider is selected.
 * Models can also be typed freely (custom values).
 */
export const PROVIDER_MODELS: Record<string, string[]> = {
  openrouter: [
    "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
    "openai/gpt-5.4-pro",
    "openai/gpt-5.4-nano",
    "openai/gpt-5.3-codex",
    "google/gemini-3-pro-preview",
    "google/gemini-3-flash-preview",
    "google/gemini-3.1-pro-preview",
    "google/gemini-3.1-flash-lite-preview",
    "qwen/qwen3.5-plus-02-15",
    "qwen/qwen3.5-35b-a3b",
    "z-ai/glm-5",
    "z-ai/glm-5-turbo",
    "moonshotai/kimi-k2.5",
    "minimax/minimax-m2.7",
    "minimax/minimax-m2.5",
    "x-ai/grok-4.20-beta",
    "deepseek/deepseek-v3.2",
    "nvidia/nemotron-3-super-120b-a12b",
  ],
  nous: [
    "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5.4",
    "openai/gpt-5.3-codex",
    "google/gemini-3-pro-preview",
    "z-ai/glm-5",
    "z-ai/glm-5-turbo",
    "moonshotai/kimi-k2.5",
  ],
  "openai-codex": [
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
  ],
  copilot: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5-mini",
    "gpt-5.3-codex",
    "gpt-4.1",
    "gpt-4o",
    "claude-opus-4.6",
    "claude-sonnet-4.6",
    "claude-sonnet-4.5",
    "claude-haiku-4.5",
  ],
  "copilot-acp": ["copilot-acp"],
  zai: ["glm-5", "glm-5-turbo", "glm-4.7", "glm-4.5", "glm-4.5-flash"],
  "kimi-coding": [
    "kimi-for-coding",
    "kimi-k2.5",
    "kimi-k2-thinking",
    "kimi-k2-thinking-turbo",
    "kimi-k2-turbo-preview",
  ],
  minimax: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.1"],
  "minimax-cn": ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.1"],
  anthropic: [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-20250514",
    "claude-sonnet-4-20250514",
    "claude-haiku-4-5-20251001",
  ],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  kilocode: [
    "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-5.4",
    "google/gemini-3-pro-preview",
    "google/gemini-3-flash-preview",
  ],
  alibaba: [
    "qwen3.5-plus",
    "qwen3-coder-plus",
    "qwen3-coder-next",
    "glm-5",
    "glm-4.7",
    "kimi-k2.5",
    "MiniMax-M2.5",
  ],
  huggingface: [
    "Qwen/Qwen3.5-397B-A17B",
    "Qwen/Qwen3.5-35B-A3B",
    "deepseek-ai/DeepSeek-V3.2",
    "moonshotai/Kimi-K2.5",
    "MiniMaxAI/MiniMax-M2.5",
    "zai-org/GLM-5",
    "moonshotai/Kimi-K2-Thinking",
  ],
  "opencode-zen": [
    "gpt-5.4-pro",
    "gpt-5.4",
    "gpt-5.3-codex",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "gemini-3.1-pro",
    "minimax-m2.7",
    "glm-5",
    "kimi-k2.5",
  ],
  "opencode-go": ["glm-5", "kimi-k2.5", "minimax-m2.7"],
  "ai-gateway": [
    "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-5",
    "google/gemini-3-pro-preview",
    "google/gemini-3-flash",
    "deepseek/deepseek-v3.2",
  ],
};

