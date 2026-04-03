# @henkey/hermes-paperclip-adapter

A [Paperclip](https://paperclip.ing) adapter that runs [Hermes Agent](https://github.com/NousResearch/hermes-agent) as a managed employee in a Paperclip company.

Forked from [NousResearch/hermes-paperclip-adapter](https://github.com/NousResearch/hermes-paperclip-adapter) with significant enhancements.

## What's Different From Upstream

| Feature | Upstream (Nous) | This Fork |
|---------|----------------|-----------|
| Timeout strategy | Dumb wall-clock timer | **Activity-based idle timeout + hard max** |
| Session resume | Blind `--resume` always | **Smart resume** — decides based on failure type |
| Token usage | Regex from stdout (unreliable) | SQLite DB read from Hermes session state |
| Per-agent profiles | Not supported | Each agent gets an isolated Hermes profile |
| Agent JWT auth | Not supported | Injects auth token so comments show agent name |
| Stderr handling | All red errors | Reclassifies benign logs (MCP init, INFO) |
| NICE view output | Raw tool commands leak | Cleaned response extraction |
| Cost tracking | Not supported | Per-run cost from DB |
| Delivery targets | Not supported | Telegram, Discord, Slack, email, etc. |
| Memory scoping | Not supported | Session / Persistent / Ephemeral |
| Session tagging | Not supported | `--source tool` to separate from user sessions |
| Plugin loading | Built-in only | External plugin via `adapter-plugins.json` |
| Thinking effort | Not supported | `--reasoning-effort` passthrough |
| Instruction bundles | Not supported | Reads `instructionsFilePath` for managed bundles |

## Key Features

### Activity-Based Idle Timeout

Upstream kills agents with a dumb wall-clock timer — if `timeoutSec=600`, the agent gets SIGKILL after 10 minutes even if it's actively working on a long build or LLM inference call. This wastes work and tokens.

This fork uses a **two-tier timeout strategy**:

1. **Idle timeout** (`idleTimeoutSec`, default 120s) — Kill only if no stdout/stderr activity for N seconds. Every data event resets the timer. An agent doing a 20-minute build with continuous output stays alive. An agent stuck with zero output gets killed quickly.

2. **Hard max timeout** (`maxTimeoutSec`) — Unconditional kill after N seconds regardless of activity. Safety net against runaway processes.

3. **Grace period** (`graceSec`) — After SIGTERM, wait N seconds before SIGKILL so the agent can finish its current operation and report back.

Clear log messages distinguish the two: `[hermes] IDLE TIMEOUT: No output for 120s` vs `[hermes] MAX TIMEOUT: Run exceeded 3600s hard limit`.

### Smart Resume

Upstream always resumes the previous session when one exists. This causes cascading failures — a corrupted session (from SIGKILL, context limit, or max timeout) poisons every subsequent run.

This fork uses a **smart resume strategy** that inspects how the previous run ended:

| Previous run outcome | Resume? | Why |
|----------------------|---------|-----|
| Clean exit (code 0) | Yes | Work likely incomplete, session valid |
| Idle timeout | Yes | Agent was working, just got stuck on one call |
| Transient error (code != 0) | Yes | Worth retrying, session probably fine |
| Max timeout | **No** | Session likely bloated, start fresh |
| SIGKILL (grace expired) | **No** | Agent didn't respond to SIGTERM, session corrupted |
| Context/token limit error | **No** | Session too large, must start fresh |
| Unknown outcome | **No** | Safe default — don't risk a bad session |

The outcome is stored in `sessionParams` after each run and read on the next. The adapter logs the decision: `[hermes] Smart resume: NOT resuming session xyz. Reason: previous run hit max timeout — starting fresh`.

**Configuration:** `resumeStrategy: "smart"` (default), `"always"` (legacy), or `"never"`.

### Session Resume with Before/After IDs

Clicking "Retry" on a failed or timed-out run picks up exactly where it left off — full conversation context, memories, and tool state preserved. Session IDs tracked with Before/After in the UI.

### DB-Backed Usage Metrics

Reads token counts directly from Hermes's SQLite session database (not regex-parsed stdout). Shows input/output/cached tokens and cost in the Paperclip UI. Per-profile DB resolution — each agent profile has its own `state.db`.

### Per-Agent Profiles

Each agent gets an isolated Hermes profile with its own config, memories, skills, and session history. No cross-contamination between agents.

### Other Features

- **30+ native tools** — terminal, file, web, browser, vision, git, code execution, MCP, creative, productivity
- **8 inference providers** — Anthropic, OpenRouter, OpenAI Codex, Nous, Copilot, ZAI, Kimi Coding, MiniMax
- **Skills system** — 80+ loadable skills, both Paperclip-managed and Hermes-native
- **Persistent memory** — Agents remember across sessions
- **Sub-agent delegation** — Parallel sub-tasks
- **Context compression** — Auto-compresses long conversations
- **MCP client** — Connect to any MCP server
- **Comment-driven wakes** — Agents wake to respond to issue comments
- **Delivery targets** — Send run summaries to Telegram, Discord, Slack, etc.
- **Benign stderr reclassification** — MCP init logs and structured timestamps don't show as red errors

### Hermes Agent vs Other Adapters

| Feature | Claude Code | Codex | Hermes Agent |
|---------|------------|-------|-------------|
| Persistent memory | No | No | Yes |
| Native tools | ~5 | ~5 | 30+ |
| Skills system | No | No | Yes — 80+ loadable |
| Session search | No | No | Yes — FTS5 search |
| Sub-agent delegation | No | No | Yes |
| Context compression | No | No | Yes |
| MCP client | No | No | Yes |
| Multi-provider | Anthropic only | OpenAI only | Yes — 8 providers |

## Installation

```bash
npm install @henkey/hermes-paperclip-adapter
```

### Prerequisites

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) installed (`pip install hermes-agent`)
- Python 3.10+
- At least one LLM API key (Anthropic, OpenRouter, OpenAI, etc.)

## Quick Start

1. Go to **Settings > Adapters** in your Paperclip instance (`/instance/settings/adapters`)
2. Click **Install Adapter**
3. Either:
   - Search for `@henkey/hermes-paperclip-adapter` and install from npm, or
   - Choose **Local Path** and point it to this repo
4. Create a Hermes agent in Paperclip with adapter type `hermes_local`
5. Configure the profile, provider/model, and memory scope
6. Assign issues — Hermes picks them up on the next heartbeat

## Configuration Reference

### Core

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | *(auto-detected)* | Model in `provider/model` format |
| `provider` | string | `auto` | API provider: `auto`, `openrouter`, `nous`, `openai-codex`, `zai`, `kimi-coding`, `minimax`, etc. |

### Timeouts (two-tier strategy)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeoutSec` | number | `300` | (Legacy) Falls back to if `maxTimeoutSec` not set |
| `maxTimeoutSec` | number | `300` | Hard kill regardless of activity. Safety net. |
| `idleTimeoutSec` | number | `120` | Kill if no stdout/stderr for N seconds. Resets on activity. |
| `graceSec` | number | `10` | Grace period after SIGTERM before SIGKILL |

**Recommended timeouts by role:**

| Role | `idleTimeoutSec` | `maxTimeoutSec` | `graceSec` |
|------|------------------|-----------------|------------|
| CEO | 120 | 600 | 10 |
| Engineer | 300 | 1800 | 30 |
| DevOps | 600 | 3600 | 60 |
| Designer/Researcher | 180 | 900 | 10 |
| QA/CMO/PM | 120 | 600 | 10 |

### Session & Resume

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `profile` | string | `default` | Hermes profile name (isolated config, memories, skills) |
| `memoryScope` | string | `session` | `session` (resume within agent), `persistent` (survive recreation), `ephemeral` (fresh every run) |
| `resumeStrategy` | string | `smart` | `smart` (decide based on failure), `always` (resume always), `never` (always fresh) |

### Tools

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolsets` | string | *(all)* | Comma-separated: `terminal`, `file`, `web`, `browser`, `vision` |

### Delivery

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `deliveryTarget` | string | `none` | Where to send run summaries: `none`, `telegram`, `discord`, `slack`, `email` |

### Advanced

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hermesCommand` | string | `hermes` | Custom CLI binary path |
| `verbose` | boolean | `false` | Enable verbose output |
| `quiet` | boolean | `true` | Quiet mode (clean output, no banner/spinner) |
| `extraArgs` | string[] | `[]` | Additional CLI arguments |
| `env` | object | `{}` | Extra environment variables |
| `promptTemplate` | string | *(built-in)* | Custom prompt template (not recommended — let Paperclip generate managed bundles instead) |
| `instructionsFilePath` | string | *(none)* | Path to AGENTS.md relative to workspace cwd |
| `paperclipApiUrl` | string | `http://127.0.0.1:3100/api` | Paperclip API base URL |

## Architecture

```
Paperclip                              Hermes Agent
+------------------+                    +------------------+
|  Heartbeat       |                    |                  |
|  Scheduler       |---execute()------>|  hermes chat -q  |
|                  |                    |                  |
|  Issue System    |                    |  30+ Tools       |
|  Comment Wakes   |<--results---------|  Memory System   |
|                  |                    |  Session DB      |
|  Cost Tracking   |<--usage from DB---|  Skills          |
|  Session Resume  |--smart resume---->|  MCP Client      |
|  Idle Timeout    |<--activity--------|  Profile Config  |
|  Max Timeout     |                    |  ~/.hermes/      |
|  Smart Resume    |                    |                  |
|  Skill Sync      |<--snapshot--------|                  |
|  Org Chart       |                    |                  |
+------------------+                    +------------------+
```

The adapter spawns Hermes Agent's CLI in single-query mode (`-q`). Hermes processes the task using its full tool suite, then exits. The adapter:

1. **Decides** whether to resume or start fresh based on previous run outcome (smart resume)
2. **Spawns** Hermes with activity-monitored timeout (two-tier: idle + max)
3. **Captures** stdout/stderr and parses the session ID
4. **Reads** token usage and cost from Hermes's SQLite session database
5. **Classifies** the run outcome and stores it for the next run's smart resume decision
6. **Parses** raw output into structured `TranscriptEntry` objects
7. **Post-processes** Hermes ASCII formatting into clean GFM markdown
8. **Reclassifies** benign stderr (MCP init, structured logs)
9. **Tags** sessions as `tool` source to separate from user sessions
10. **Reports** results back to Paperclip with usage, cost, session state

## Development

```bash
git clone https://github.com/HenkDz/hermes-paperclip-adapter
cd hermes-paperclip-adapter
npm install
npm run build
```

After making changes, rebuild and reload from the Adapters settings page.

## License

MIT

## Links

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — The AI agent this adapter runs
- [Paperclip](https://github.com/paperclipai/paperclip) — The orchestration platform
- [Upstream](https://github.com/NousResearch/hermes-paperclip-adapter) — Original adapter by Nous Research
