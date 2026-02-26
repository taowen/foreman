# Foreman

A Claude Code plugin that separates planning from execution. The main agent acts as a **foreman** — it reads your request, plans the work, and delegates cohesive **mini goals** to a persistent worker. `claudex.js` sits in the middle as the orchestration layer, managing all state in memory.

## Architecture

```
User
 │
 ▼
claudex.js ─── HTTP server (127.0.0.1:<random port>)
 │                 ├── /hook/*        ← hook.js (unified dispatcher)
 │                 ├── /tool/*        ← mcp-server.js (thin proxy)
 │                 └── /clear-history ← slash command
 │
 ├── spawns ──► claude (main agent / foreman)
 │                 • forbidden from editing files directly
 │                 • breaks tasks into mini goals
 │                 • system prompt injected via SessionStart hook
 │
 └── spawns ──► worker (via claude-agent-sdk)
                   • persistent session across calls
                   • full file editing permissions
                   • auto-resets when context exceeds 400KB
```

All hooks and MCP tools are thin HTTP proxies — the real logic lives in `claudex.js`.

## Setup

```bash
git clone https://github.com/anthropics/foreman.git
cd foreman
npm install
cp .env.example .env
# Edit .env and add your SEARCH_API_KEY (for web search)
```

## Usage

```bash
WORKER_NAME=my-project node claudex.js [claude args...]
```

`WORKER_NAME` identifies the worker session. Use the same name across sessions to preserve history and worker context.

## How It Works

### Planner-executor separation

The main agent's system prompt forbids direct file edits (`Edit`, `Write`, `NotebookEdit`). Instead, it must call the `mini-goal-worker` MCP tool with a `summary` and `detail`. claudex receives the request, spawns (or resumes) a worker via the Claude Agent SDK, and returns the result.

### Automatic context management

Both the main agent and the worker have 400KB session size limits:

- **Main agent**: claudex checks the session JSONL size on every `Stop` event and before each mini-goal. If exceeded, it kills claude and respawns with a fresh session. Pending mini-goals are automatically resumed via system prompt injection.
- **Worker**: claudex checks the worker's session JSONL before execution. If exceeded, it deletes the session ID and returns a `CONTEXT_RESET` error. The main agent must resend full context.

### History compression

Interactions are logged to `history.jsonl` and restored into the system prompt on session start with 3-tier compression:

| Tier | Content |
|:---|:---|
| Old (omitted) | Entry count only |
| Middle | User prompts + assistant responses + mini-goal results |
| Recent (last 20+) | Full detail including mini-goal descriptions and plans |

## HTTP Endpoints

| Endpoint | Caller | Purpose |
|:---|:---|:---|
| `POST /hook/session-start` | hook.js | Returns system prompt (rules + history + resume info) |
| `POST /hook/user-prompt-submit` | hook.js | Records user prompt to history |
| `POST /hook/exit-plan-mode` | hook.js | Records accepted plan to history |
| `POST /hook/stop` | hook.js | Records assistant response, checks session size |
| `POST /tool/mini-goal-worker` | mcp-server.js | Checks sizes, executes worker, returns result |
| `POST /tool/web-search` | mcp-server.js | Proxies web search via external API |
| `POST /tool/web-fetch` | mcp-server.js | Fetches URL content via Claude Haiku with web_fetch |
| `POST /clear-history` | slash command | Resets history and worker session |

## MCP Tools

| Tool | Description |
|:---|:---|
| `mini-goal-worker` | Delegates a mini goal to the persistent worker. Takes `summary` and `detail`. |
| `web-search` | Web search for real-time information. Requires `SEARCH_API_KEY` in `.env`. |
| `web-fetch` | Fetch a URL and analyze its content. Uses Claude Haiku with web_fetch tool. Requires `SEARCH_API_KEY`. |

## Slash Commands

- `/clear-worker-history` — Clears the current worker's history and session

## File Structure

```
foreman/
├── claudex.js                      # Central launcher + HTTP server (all logic)
├── .claude-plugin/plugin.json      # Plugin manifest
├── .mcp.json                       # MCP server config
├── hooks/hooks.json                # Hook registrations (all → hook.js)
├── commands/clear-worker-history.md
├── prompts/system-prompt.md        # Template with {{HISTORY_SECTION}} {{RESUME_SECTION}}
├── scripts/
│   ├── hook.js                     # Unified hook dispatcher (HTTP proxy)
│   └── mcp-server.js               # MCP tool proxy (HTTP proxy)
├── .env.example
├── package.json
└── .gitignore
```

## Worker Data

Per-worker data is stored at `~/.claude/mini-goal-workers/<WORKER_NAME>/`:

| File | Purpose |
|:---|:---|
| `session-id` | Worker's Claude Code session ID for resuming |
| `history.jsonl` | Full interaction log |

## License

MIT
