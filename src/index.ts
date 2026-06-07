/**
 * Hermes Agent adapter for Paperclip.
 *
 * Runs Hermes Agent (https://github.com/NousResearch/hermes-agent)
 * as a managed employee in a Paperclip company. Hermes Agent is a
 * full-featured AI agent with 30+ native tools, persistent memory,
 * skills, session persistence, and MCP support.
 *
 * @packageDocumentation
 */

import { ADAPTER_TYPE, ADAPTER_LABEL, PROVIDER_MODELS, PROVIDER_LABELS } from "./shared/constants.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

/**
 * Models available through Hermes Agent.
 *
 * Auto-populated from the PROVIDER_MODELS catalog in constants.ts.
 * Shows the full model tree grouped by provider.
 * Users can also type any model manually (Hermes accepts any model).
 */
export const models: { id: string; label: string }[] = (() => {
  const result: { id: string; label: string }[] = [];

  for (const [provider, modelIds] of Object.entries(PROVIDER_MODELS)) {
    const providerLabel = PROVIDER_LABELS[provider] ?? provider;
    for (const modelId of modelIds) {
      result.push({
        id: modelId,
        label: `${modelId} (${providerLabel})`,
      });
    }
  }

  return result;
})();

/**
 * Documentation shown in the Paperclip UI when configuring a Hermes agent.
 */
export const agentConfigurationDoc = `# Hermes Agent Configuration

Adapter: hermes_local
Registration: external plugin (loaded via adapter plugin system, not hardcoded)

Hermes Agent is a full-featured AI agent by Nous Research with 30+ native
tools, persistent memory, session persistence, skills, and MCP support.

## Prerequisites

- Python 3.10+ installed
- Hermes Agent installed: \`pip install hermes-agent\`
- At least one LLM API key configured in ~/.hermes/.env

## Profile (Hermes-specific)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| profile | string | (default) | Hermes profile name for isolated agent identity. Creates an isolated instance with its own config, API keys, memory, sessions, and skills. Auto-created from active profile on first run if it doesn't exist. |

Profiles give each Paperclip agent a fully isolated Hermes instance:
- Separate API keys and model preferences
- Separate SOUL.md (personality, domain expertise)
- Separate memory and sessions (no cross-contamination)
- Separate skills and MCP server connections
- Separate cron jobs

Leave blank to use the default profile.

## Core Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | (Hermes configured default) | Optional explicit model in provider/model format. Leave blank to use Hermes's configured default model. |
| provider | string | (auto) | API provider: auto, openrouter, nous, openai-codex, zai, kimi-coding, minimax, minimax-cn. Usually not needed — Hermes auto-detects from model name. |
| reasoningEffort | string | medium | Reasoning effort level: low, medium, high. Silently ignored by models that don't support it. Higher = more thorough but slower and more expensive. |
| timeoutSec | number | 300 | Execution timeout in seconds |
| graceSec | number | 10 | Grace period after SIGTERM before SIGKILL |

## Delivery

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| deliveryTarget | string | none | Where to send run results. Options: none, telegram, discord, slack, whatsapp, signal. Requires Hermes gateway to be running and configured for the target platform. |

## Memory & Session

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| memoryScope | string | session | Memory persistence: "session" (resume across heartbeats), "persistent" (full isolation via profile with own memories dir), "ephemeral" (fresh start every run). |
| persistSession | boolean | true | (Deprecated — use memoryScope instead) Resume sessions across heartbeats. |

## Tool Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| toolsets | string | (all) | Comma-separated toolsets to enable (e.g. "terminal,file,web") |

## Advanced

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| quiet | boolean | true | Keep Hermes in quiet mode (\`-Q\`). Recommended for normal Paperclip runs so transcripts and run summaries stay clean. |
| maxTurnsPerRun | number | 0 | Optional Hermes \`--max-turns\` value. 0 keeps the Hermes profile/default setting. |
| hermesCommand | string | hermes | Path to hermes CLI binary |
| verbose | boolean | false | Enable verbose output |
| extraArgs | string[] | [] | Additional CLI arguments |
| env | object | {} | Extra environment variables |
| promptTemplate | string | (default) | Custom prompt template with {{variable}} placeholders |

## Available Template Variables

- \`{{agentId}}\` — Paperclip agent ID
- \`{{agentName}}\` — Agent display name
- \`{{companyId}}\` — Paperclip company ID
- \`{{companyName}}\` — Company display name
- \`{{runId}}\` — Current heartbeat run ID
- \`{{taskId}}\` — Current task/issue ID (if assigned)
- \`{{taskTitle}}\` — Task title (if assigned)
- \`{{taskBody}}\` — Task description (if assigned)
| projectName | string | (if scoped to a project) |
`;

// Re-export createServerAdapter for Paperclip's plugin-loader convention.
// The plugin-loader imports from the package root, which resolves to this file.
export { createServerAdapter } from "./server/index.js";
