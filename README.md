# Foreman

A Claude Code plugin that separates planning from execution. The main agent acts as a **foreman** — it reads your request, plans the work, and delegates tasks to **subagents** (via Claude Code's built-in Task tool). `claudex.js` sits in the middle as the orchestration layer, providing persistent history across session resets.

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
 └── spawns ──► claude (main agent / foreman)
                  • breaks tasks into subagent calls (Task tool)
                  • system prompt injected via SessionStart hook
                  • auto-restarts on new topic detection or context overflow
                  │
                  ├── Task("mini-goal-worker") ← custom agent (agents/)
                  ├── Task("Explore")          ← built-in agent
                  └── Task(...)                ← other built-in agents
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
node claudex.js [claude args...]

# Or with explicit worker name:
WORKER_NAME=my-project node claudex.js [claude args...]
```

`WORKER_NAME` identifies the worker session and defaults to the current directory name. Set it explicitly to share history across different directories or to use a custom name.

## How It Works

### Subagent-based execution

The main agent's system prompt instructs it to delegate work via Claude Code's Task tool. A custom `mini-goal-worker` agent (defined in `agents/mini-goal-worker.md`) handles focused units of work, while built-in agents like `Explore` handle codebase exploration. Subagent start/stop events are recorded to `history.jsonl` via hooks, preserving descriptions and results across session resets.

### Automatic context management

Before each subagent call, the `subagent-pretool` hook checks the main agent's session JSONL size. If it exceeds 600KB, claudex triggers a restart with a "continue" prompt. The new session's system prompt includes compressed history so the agent can pick up where it left off.

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
| Recent (last 10+) | Full detail including subagent calls/results, plans, and assistant responses |

The history section is placed at the **top** of the system prompt, with workflow rules at the bottom (closer to the conversation for stronger influence on the model).

## HTTP Endpoints

| Endpoint | Caller | Purpose |
|:---|:---|:---|
| `POST /hook/session-start` | hook.js | Stores main session ID, returns system prompt |
| `POST /hook/user-prompt-submit` | hook.js | Runs topic detection, records prompt, triggers restart if new topic |
| `POST /hook/exit-plan-mode` | hook.js | Records accepted plan to history |
| `POST /hook/subagent-pretool` | hook.js | Records Task tool call to history, checks session size |
| `POST /hook/subagent-stop` | hook.js | Records subagent stop + result to history |
| `POST /hook/stop` | hook.js | Records assistant response |
| `POST /tool/web-search` | mcp-server.js | Proxies web search via external API |
| `POST /tool/web-fetch` | mcp-server.js | Fetches URL as markdown via Cloudflare Browser Rendering |
| `POST /clear-history` | slash command | Resets history |

## MCP Tools

| Tool | Description |
|:---|:---|
| `web-search` | Web search via Grok model. Requires `SEARCH_API_KEY`, `SEARCH_API_URL`, `SEARCH_MODEL` in `.env`. |
| `web-fetch` | Fetches URL as markdown via Cloudflare Browser Rendering. Requires `CF_ACCOUNT_ID` and `CF_BROWSER_TOKEN` in `.env`. |

## Custom Agents

| Agent | Description |
|:---|:---|
| `mini-goal-worker` | Executes a mini goal — a small, focused unit of work with one logical objective. |

Defined in `agents/mini-goal-worker.md`. Auto-discovered by Claude Code from the plugin directory.

## Slash Commands

- `/clear-worker-history` — Clears the current worker's history

## File Structure

```
foreman/
├── claudex.js                      # Launcher + HTTP server + restart logic
├── agents/
│   └── mini-goal-worker.md         # Custom subagent definition
├── lib/
│   ├── hooks.js                    # Hook handlers (session-start, subagent-pretool, etc.)
│   ├── tools.js                    # MCP tool handlers (web-search, web-fetch)
│   ├── web-search.js               # Web search via external API
│   ├── web-fetch.js                # URL fetch + LLM-based content extraction
│   ├── prompt.js                   # System prompt builder (3-tier history compression)
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

Per-worker data is stored at `~/.claude/mini-goal-workers/<WORKER_NAME>/` (defaults to cwd basename):

| File | Purpose |
|:---|:---|
| `history.jsonl` | Full interaction log |
| `recent-history.json` | Short-term history for topic detection |
| `last-system-prompt.log` | Last generated system prompt (debug) |

## License

MIT
