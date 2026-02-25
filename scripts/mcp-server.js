import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(__dirname, "..");

// Load .env from plugin root
try {
  const envContent = readFileSync(join(pluginDir, ".env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
} catch {}

function appendHistory(entry) {
  if (!workerDir) return;
  mkdirSync(workerDir, { recursive: true });
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
  appendFileSync(join(workerDir, "history.jsonl"), line + "\n", "utf-8");
}

const MAX_SESSION_SIZE = 400 * 1024; // 400KB

const workerName = process.env.WORKER_NAME;
const workerDir = workerName
  ? join(homedir(), ".claude", "mini-goal-workers", workerName)
  : null;
const sessionFile = workerDir ? join(workerDir, "session-id") : null;
let cachedJsonlPath = null;

function readSessionId() {
  try {
    return readFileSync(sessionFile, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function saveSessionId(id) {
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(sessionFile, id, "utf-8");
  cachedJsonlPath = null;
}

function deleteSessionId() {
  try { unlinkSync(sessionFile); } catch {}
  cachedJsonlPath = null;
}

function findSessionJsonl(sessionId) {
  // try cached path first
  if (cachedJsonlPath) {
    try {
      const stat = statSync(cachedJsonlPath);
      if (stat.isFile()) return { path: cachedJsonlPath, size: stat.size };
    } catch {}
    cachedJsonlPath = null;
  }

  // scan all project dirs
  const projectsDir = join(homedir(), ".claude", "projects");
  try {
    for (const dir of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
      try {
        const stat = statSync(candidate);
        if (stat.isFile()) {
          cachedJsonlPath = candidate;
          return { path: candidate, size: stat.size };
        }
      } catch {}
    }
  } catch {}
  return null;
}

const server = new McpServer({
  name: "foreman",
  version: "1.0.0",
});

server.tool(
  "mini-goal-worker",
  {
    summary: z.string().describe("One-line short summary of the mini goal"),
    detail: z.string().describe("Detailed description with file paths (@/absolute/path), background context, and expected outcome"),
  },
  async ({ summary, detail }) => {
    appendHistory({ type: "mini_goal", summary, detail });

    let stderrOutput = "";
    try {
      const savedSessionId = workerDir ? readSessionId() : null;

      // Check session file size before resuming
      if (savedSessionId) {
        const jsonl = findSessionJsonl(savedSessionId);
        if (jsonl && jsonl.size > MAX_SESSION_SIZE) {
          deleteSessionId();
          const msg = `CONTEXT_RESET: The mini-goal-worker "${workerName}" session exceeded ${MAX_SESSION_SIZE / 1024}KB (was ${Math.round(jsonl.size / 1024)}KB) and has been automatically reset. Please resend this task with full context information (relevant file paths, background, and expected outcome) so the worker can start fresh.`;
          appendHistory({ type: "mini_goal_result", summary, result: msg, error: true });
          return { content: [{ type: "text", text: msg }], isError: true };
        }
      }

      const prompt = `## ${summary}\n\n${detail}`;
      const options = {
        systemPrompt: { type: "preset", preset: "claude_code" },
        tools: { type: "preset", preset: "claude_code" },
        disallowedTools: ["AskUserQuestion", "WebFetch", "WebSearch"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 50,
        stderr: (data) => { stderrOutput += data; },
      };

      if (savedSessionId) {
        options.resume = savedSessionId;
      }

      const messages = query({ prompt, options });

      let resultText = "";
      let sessionId = null;

      for await (const message of messages) {
        if (message.session_id) {
          sessionId = message.session_id;
        }
        if (message.type === "result") {
          if (message.subtype === "success") {
            resultText = message.result;
          } else {
            resultText = `Error: ${message.errors?.join(", ") ?? "unknown error"}`;
          }
        }
      }

      if (sessionId && workerDir) {
        saveSessionId(sessionId);
      }

      appendHistory({ type: "mini_goal_result", summary, result: resultText || "No result returned", error: false });

      return {
        content: [{ type: "text", text: resultText || "No result returned" }],
      };
    } catch (err) {
      const msg = `mini-goal-worker failed: ${err.message}\n\nstderr:\n${stderrOutput.slice(-2000)}`;
      appendHistory({ type: "mini_goal_result", summary, result: msg, error: true });
      return {
        content: [{ type: "text", text: msg }],
        isError: true,
      };
    }
  }
);

server.tool(
  "search",
  { query: z.string().describe("A search query in natural language") },
  async ({ query: searchQuery }) => {
    if (!process.env.SEARCH_API_KEY) {
      return {
        content: [{ type: "text", text: `SEARCH_API_KEY is not set. Define it in ${join(pluginDir, ".env")}. See .env.example for reference.` }],
        isError: true,
      };
    }
    try {
      const resp = await fetch("https://api.whatai.cc/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.SEARCH_API_KEY}`,
        },
        body: JSON.stringify({
          model: "grok-4-fast-non-reasoning",
          input: [{ role: "user", content: searchQuery }],
          tools: [{ type: "web_search" }],
        }),
      });

      const data = await resp.json();

      if (data.error) {
        return {
          content: [{ type: "text", text: `Search API error: ${data.error.message}` }],
          isError: true,
        };
      }

      // Extract the text output from the response
      const outputMsg = data.output?.find((o) => o.type === "message");
      const textContent = outputMsg?.content?.find((c) => c.type === "output_text");
      const resultText = textContent?.text || JSON.stringify(data.output);

      return {
        content: [{ type: "text", text: resultText }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Search failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
