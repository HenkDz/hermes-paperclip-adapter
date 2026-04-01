# Hermes Paperclip Adapter — Development Guide

## Overview

External Paperclip adapter for Hermes Agent. Runs Hermes CLI as a managed employee via the external adapter plugin system. Can be loaded locally via `file:` protocol or published as `@henkey/hermes-paperclip-adapter` on npm.

## Structure

```
src/
├── index.ts              # Root: type, label, models, agentConfigurationDoc, re-exports createServerAdapter
├── shared/
│   └── constants.ts      # Shared constants: providers, reasoning efforts, delivery targets, memory scopes
├── server/
│   ├── index.ts          # createServerAdapter() factory — what plugin-loader imports
│   ├── execute.ts        # Core execution: spawn `hermes chat -q`, profile isolation, session resume
│   ├── detect-model.ts   # Detect configured model from ~/.hermes/config.yaml + profile configs
│   ├── profiles.ts       # Profile management: list, resolve, ensure, auto-create
│   ├── skills.ts         # Skill listing and sync (Hermes skills → Paperclip runtime skills)
│   └── test.ts           # Environment checks: CLI, Python, API keys
├── ui/
│   ├── index.ts          # Re-exports parse-stdout + build-config
│   ├── parse-stdout.ts   # UI-side stdout parser (can import from adapter-utils)
│   └── build-config.ts   # UI form values → adapterConfig object
├── ui-parser.ts          # Self-contained ESM parser for browser eval (ZERO imports)
└── cli/
    ├── index.ts          # Re-exports
    └── format-event.ts   # Terminal output formatting
```

## Build

```bash
npm install
npm run build     # tsc → dist/
npm run typecheck # tsc --noEmit
```

## Package exports (package.json)

```json
{
  "paperclip": { "adapterUiParser": "1.0.0" },
  "exports": {
    ".": "./dist/index.js",
    "./server": "./dist/server/index.js",
    "./ui": "./dist/ui/index.js",
    "./cli": "./dist/cli/index.js",
    "./ui-parser": "./dist/ui-parser.js"
  }
}
```

- `.` — plugin-loader calls `createServerAdapter()` from here
- `./ui-parser` — served by Paperclip at `GET /api/:type/ui-parser.js`, eval'd in browser

## ServerAdapterModule — what's implemented

All implemented in `createServerAdapter()` return object in `src/server/index.ts`:

| Field | Status | Notes |
|-------|--------|-------|
| `type` | done | `"hermes_local"` |
| `execute` | done | Spawns `hermes chat -q`, profile isolation via HERMES_HOME, session resume |
| `testEnvironment` | done | CLI, Python, API keys |
| `detectModel` | done | Reads `~/.hermes/config.yaml` + profile configs, infers provider from model prefix |
| `listSkills` | done | Lists Hermes skills via filesystem scan |
| `syncSkills` | done | Syncs desired skills to Hermes profile |
| `sessionCodec` | done | Validates sessionId only |
| `models` | done | Static list from src/index.ts |
| `getConfigSchema` | done | Profile (select), reasoning effort, memory scope, delivery target |
| `agentConfigurationDoc` | done | Markdown doc for config form |
| `supportsLocalAgentJwt` | done | `true` |

## getConfigSchema — config fields exposed to Paperclip UI

The adapter returns a `getConfigSchema()` method. Paperclip server serves this at `GET /api/adapters/hermes_local/config-schema` (cached 30s). The UI auto-renders these as form fields:

| Key | Type | Options | Default | Notes |
|-----|------|---------|---------|-------|
| `profile` | select | Dynamic (from `~/.hermes/profiles/`) | `"default"` | Each agent gets isolated Hermes profile |
| `reasoningEffort` | select | low, medium, high | `"medium"` | `--reasoning-effort` flag |
| `memoryScope` | select | session, persistent, ephemeral | `"session"` | Controls `--resume` behavior |
| `deliveryTarget` | select | none, telegram, discord, slack, whatsapp, signal | `"none"` | Sets HERMES_DELIVERY_TARGET |

**No fork changes needed** — `SchemaConfigFields` is auto-assigned to external adapters in `paperclip-fork/ui/src/adapters/registry.ts`.

## Plugin system integration points

### Config schema

Paperclip server: `GET /api/adapters/:type/config-schema` → calls `adapter.getConfigSchema()`.
Paperclip UI: `SchemaConfigFields` component auto-assigned to all external adapters.
Schema types from `@paperclipai/adapter-utils`:

```typescript
interface ConfigFieldSchema {
  key: string;
  label: string;
  type: "text" | "select" | "toggle" | "number" | "textarea";
  options?: { label: string; value: string }[];
  default?: unknown;
  hint?: string;
  required?: boolean;
  group?: string;
}
interface AdapterConfigSchema {
  fields: ConfigFieldSchema[];
}
```

### UI parser (ui-parser.ts)

Self-contained ESM module, zero runtime imports. Eval'd in browser via `URL.createObjectURL` + dynamic `import()`.

Exports: `createStdoutParser()` (stateful factory) + `parseStdoutLine` (static alias).

Handles: tool calls (┊ prefix), thinking blocks (💭 prefix), multi-line continuation suppression, tool output, session info.

### Profile isolation

Each Hermes agent runs in an isolated profile via `HERMES_HOME` env var pointing to `~/.hermes/profiles/<name>/`. Profiles are auto-created on first run via `hermes profile create <name> --clone --no-alias`.

## Key constants (shared/constants.ts)

- `VALID_REASONING_EFFORTS`: low, medium, high
- `VALID_DELIVERY_TARGETS`: none, telegram, discord, slack, whatsapp, signal
- `VALID_MEMORY_SCOPES`: session, persistent, ephemeral
- `TOOL_OUTPUT_PREFIX`: `┊`
- `THINKING_PREFIX`: `💭`

## Local development with Paperclip

The Hermes adapter is loaded by both server and UI packages. Both must use the same resolution:

**server/package.json** (already correct):
```json
"hermes-paperclip-adapter": "file:/mnt/e/Projects/AI/paperclip/hermes-paperclip-adapter"
```

**ui/package.json** (must match server):
```json
"hermes-paperclip-adapter": "file:/mnt/e/Projects/AI/paperclip/hermes-paperclip-adapter"
```

If they differ (e.g. one uses `file:` and the other uses `^0.2.0`), pnpm resolves them independently → server uses local code but UI uses stale npm version. Symptoms: server logs correct but run-log shows raw text without tool parsing.
