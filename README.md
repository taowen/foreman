# Foreman

A Claude Code plugin that separates planning from execution. The main agent acts as a **foreman** — it reads your request, plans the work, and delegates cohesive **mini goals** to a persistent worker. `claudex.js` sits in the middle as the orchestration layer, with logic split across modular `lib/` modules.

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
 │                 • auto-restarts on new topic detection
 │
 └── spawns ──► worker (via claude-agent-sdk)
                   • persistent session across calls
                   • full file editing permissions
                   • silently resets when context exceeds 500KB
```

All hooks and MCP tools are thin HTTP proxies — the real logic lives in `lib/`.

## Setup

```bash
git clone https://github.com/taowen/foreman.git
cd foreman
npm install
cp .env.example .env
# Edit .env: SEARCH_API_KEY (web search), CF_ACCOUNT_ID + CF_BROWSER_TOKEN (web fetch)
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

Both the worker and main agent have a 500KB session size limit. Before executing a mini-goal, claudex checks:

1. **Main agent JSONL** — If > 500KB, triggers a restart with a "continue" prompt. The incomplete mini-goal will be visible in the new session's system prompt as `[MINI_GOAL incomplete]`.
2. **Worker session JSONL** — If > 500KB, silently starts a new worker session. Recent mini-goal history (up to 10 pairs) is injected into the new session for context.

### Auto-restart on new topic

When the user sends a message, `topic-detector.js` calls a lightweight LLM to decide if the message is a new topic unrelated to the recent conversation. If yes:

1. Recent history is cleared
2. The user's prompt is recorded to history
3. Claude is killed and relaunched with the new prompt injected via `--`
4. The restarted session uses a minimal system prompt (all history collapsed to `[... N entries omitted ...]`)
5. A `justRestarted` flag skips topic detection on the first message after restart

### History compression

Interactions are logged to `history.jsonl` and restored into the system prompt on session start with 3-tier compression:

| Tier | Content |
|:---|:---|
| Old (omitted) | Entry count only |
| Middle | User prompts + assistant responses |
| Recent (last 20+) | Full detail including mini-goal summaries, plans, and subagent activity |

The history section is placed at the **top** of the system prompt, with workflow rules at the bottom (closer to the conversation for stronger influence on the model).

Completed mini-goals show only the summary. Incomplete mini-goals (no result entry following) show summary + full detail marked as `[MINI_GOAL incomplete]`.

## HTTP Endpoints

| Endpoint | Caller | Purpose |
|:---|:---|:---|
| `POST /hook/session-start` | hook.js | Stores main session ID, returns system prompt |
| `POST /hook/user-prompt-submit` | hook.js | Runs topic detection, records prompt, triggers restart if new topic |
| `POST /hook/exit-plan-mode` | hook.js | Records accepted plan to history |
| `POST /hook/subagent-pretool` | hook.js | Records Task tool call to history |
| `POST /hook/subagent-stop` | hook.js | Records subagent stop + result to history |
| `POST /hook/stop` | hook.js | Records assistant response |
| `POST /tool/mini-goal-worker` | mcp-server.js | Checks sizes, executes worker, returns result |
| `POST /tool/web-search` | mcp-server.js | Proxies web search via external API |
| `POST /tool/web-fetch` | mcp-server.js | Fetches URL as markdown via Cloudflare Browser Rendering |
| `POST /clear-history` | slash command | Resets history and worker session |

## MCP Tools

| Tool | Description |
|:---|:---|
| `mini-goal-worker` | Delegates a mini goal to the persistent worker. Takes `summary` and `detail`. |
| `web-search` | Web search via Grok model (whatai.cc). Requires `SEARCH_API_KEY` in `.env`. |
| `web-fetch` | Fetches URL as markdown via Cloudflare Browser Rendering. Requires `CF_ACCOUNT_ID` and `CF_BROWSER_TOKEN` in `.env`. |

## Slash Commands

- `/clear-worker-history` — Clears the current worker's history and session

## File Structure

```
foreman/
├── claudex.js                      # Launcher + HTTP server + restart logic
├── lib/
│   ├── hooks.js                    # Hook handlers (session-start, user-prompt-submit, etc.)
│   ├── tools.js                    # MCP tool handlers (mini-goal-worker, web-search, web-fetch)
│   ├── prompt.js                   # System prompt builder (3-tier history, justRestarted flag)
│   ├── topic-detector.js           # LLM-based new topic detection
│   ├── recent-history.js           # Short-term history for topic detection
│   ├── history.js                  # history.jsonl management
│   ├── session.js                  # Session ID + JSONL lookup
│   └── logger.js                   # Logging
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
| `recent-history.json` | Short-term history for topic detection |
| `last-system-prompt.log` | Last generated system prompt (debug) |

## License

MIT
