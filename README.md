# Foreman

A Claude Code plugin that turns the main agent into a task planner. Instead of editing files directly, the agent breaks work into **mini goals** and delegates each one to a persistent worker powered by the Claude Agent SDK.

## How it works

```
User prompt → Main agent (planner) → mini-goal-worker (executor) → Result
```

- The main agent reads your request, plans the work, and splits it into cohesive mini goals
- Each mini goal is executed by a separate Claude Code instance via the Agent SDK
- The worker maintains a persistent session across calls — no need to repeat context
- When the worker's session grows too large (>400KB), it auto-resets and asks for full context
- All interactions are logged to `~/.claude/mini-goal-workers/<WORKER_NAME>/history.jsonl`

## Setup

```bash
git clone https://github.com/taowen/foreman.git
cd foreman
npm install
cp .env.example .env
# Edit .env and add your SEARCH_API_KEY
```

## Usage

```bash
WORKER_NAME=my-project claude --plugin-dir /path/to/foreman
```

`WORKER_NAME` is required. It identifies the worker session — you can exit and re-enter anytime with the same name to restore chat history.

## MCP Tools

| Tool | Description |
|:---|:---|
| `mini-goal-worker` | Delegates a mini goal to a persistent Claude Code worker. Takes `summary` (one-line) and `detail` (full description with file paths). |
| `search` | Web search for real-time information (docs, APIs, error messages, etc.). Requires `SEARCH_API_KEY` in `.env`. |

## Hooks

| Event | Script | Purpose |
|:---|:---|:---|
| `SessionStart` | `inject-system-prompt.js` | Injects workflow rules and restores chat history from `history.jsonl` |
| `UserPromptSubmit` | `check-worker-name.js` | Blocks input if `WORKER_NAME` is not set |
| `Stop` | `record-stop.js` | Records the assistant's final response to `history.jsonl` |

## Slash Commands

- `/clear-worker-history` — Clears the current worker's history and session files

## File Structure

```
foreman/
├── .claude-plugin/plugin.json    # Plugin manifest
├── .mcp.json                     # MCP server config
├── hooks/hooks.json              # Hook registrations
├── commands/clear-worker-history.md
├── scripts/
│   ├── inject-system-prompt.js   # SessionStart: rules + history
│   ├── check-worker-name.js      # UserPromptSubmit: env check
│   ├── record-stop.js            # Stop: log assistant response
│   └── mcp-server.js             # MCP server (mini-goal-worker + search)
├── .env.example
└── .gitignore
```

## Worker Data

Per-worker data is stored at `~/.claude/mini-goal-workers/<WORKER_NAME>/`:

| File | Purpose |
|:---|:---|
| `session-id` | Claude Code session ID for resuming the worker |
| `history.jsonl` | Full interaction log (user prompts, assistant results, mini goals, mini goal results) |

## License

MIT
