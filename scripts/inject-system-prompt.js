import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const workerName = process.env.WORKER_NAME;

if (!workerName) {
  console.log(`The WORKER_NAME environment variable is missing. Tell the user they need to set it before starting. Example: WORKER_NAME=xxx claude --plugin-dir /path/to/plugin`);
  process.exit(0);
}

// --- Build chat history from history.jsonl ---
const workerDir = join(homedir(), ".claude", "mini-goal-workers", workerName);
const historyFile = join(workerDir, "history.jsonl");

let historySection = "";
try {
  const raw = readFileSync(historyFile, "utf-8").trim();
  if (raw) {
    const entries = raw.split("\n").map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    if (entries.length > 0) {
      const total = entries.length;

      // Find the latest user_prompt position from the end
      let lastUserPromptFromEnd = 0;
      for (let i = total - 1; i >= 0; i--) {
        if (entries[i].type === "user_prompt") {
          lastUserPromptFromEnd = total - i;
          break;
        }
      }

      // Recent tier must include the latest user_prompt, minimum 20
      const RECENT_COUNT = Math.max(20, lastUserPromptFromEnd);
      const MIDDLE_COUNT = 30;

      const recentStart = Math.max(0, total - RECENT_COUNT);
      const middleStart = Math.max(0, recentStart - MIDDLE_COUNT);

      const parts = [];

      // Old: just mention the file
      if (middleStart > 0) {
        parts.push(`[... ${middleStart} earlier entries omitted. Full history: ${historyFile} ...]`);
      }

      // Middle: user_prompt + results only, skip mini_goal detail
      for (let i = middleStart; i < recentStart; i++) {
        const e = entries[i];
        if (e.type === "user_prompt") {
          parts.push(`[USER] ${e.prompt}`);
        } else if (e.type === "assistant_result") {
          parts.push(`[ASSISTANT] ${e.message}`);
        } else if (e.type === "mini_goal_result") {
          const status = e.error ? "ERROR" : "DONE";
          parts.push(`[MINI_GOAL ${status}] ${e.summary}: ${e.result}`);
        }
        // skip mini_goal entries in middle tier
      }

      // Recent: full detail
      for (let i = recentStart; i < total; i++) {
        const e = entries[i];
        if (e.type === "user_prompt") {
          parts.push(`[USER] ${e.prompt}`);
        } else if (e.type === "assistant_result") {
          parts.push(`[ASSISTANT] ${e.message}`);
        } else if (e.type === "mini_goal") {
          parts.push(`[MINI_GOAL] ${e.summary}`);
        } else if (e.type === "mini_goal_result") {
          const status = e.error ? "ERROR" : "DONE";
          parts.push(`[MINI_GOAL ${status}] ${e.summary}: ${e.result}`);
        }
      }

      historySection = `\n## Chat history (restored from ${historyFile})\n\n${parts.join("\n\n")}\n`;
    }
  }
} catch {}

// --- Output system prompt ---
console.log(`IMPORTANT WORKFLOW RULE:

You MUST NOT use Edit, Write, or NotebookEdit tools directly to modify files.
Instead, break your task into mini goals and delegate each one to the "mini-goal-worker" MCP tool.

When you need to look up real-time information (current docs, APIs, error messages, latest versions, etc.), use the "search" MCP tool instead of WebFetch or WebSearch.

The mini-goal-worker takes two parameters:
- summary: A one-line short description of what to do
- detail: A longer description with file paths, background context, and expected outcome

## Mini goal guidelines

A mini goal should NOT be too fine-grained (e.g. a single file edit).
A mini goal should be a cohesive set of related changes that together accomplish one logical objective.

Examples of good mini goals:
- "Add input validation to the user registration form, including both frontend validation and the corresponding backend checks"
- "Refactor the database connection module to use connection pooling, updating all callers"
- "Add unit tests for the authentication service covering login, logout, and token refresh"

Examples of bad mini goals (too granular):
- "Add a null check on line 42 of user.js"
- "Change the variable name from x to count in utils.js"

## File path references

Always use "@/absolute/path/to/file" (with @ prefix and absolute path) to reference files in mini goal descriptions.
Do NOT use relative paths like "./src/foo.js" or vague references like "the config file".

Good: Modify @/home/user/project/src/auth/login.ts to add rate limiting
Bad: Modify the login file to add rate limiting

## Context management

The mini-goal-worker maintains a continuous session across calls. You only need to provide incremental context for each new mini goal — no need to repeat background information already sent in earlier goals.

However, the worker's context will automatically reset when its session grows too large. When this happens, you will receive a CONTEXT_RESET error. In that case:
- Resend the task with FULL context: relevant file paths, background information, and expected outcome
- Do not assume the worker remembers anything from before the reset
- After the reset, subsequent mini goals can return to incremental context until the next reset
${historySection}`);
