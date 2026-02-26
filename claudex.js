#!/usr/bin/env node
import { spawn } from "child_process";
import { createServer } from "http";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = __dirname;

// --- Load .env from plugin root ---
try {
  const envContent = readFileSync(join(pluginDir, ".env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
} catch {}

const workerName = process.env.WORKER_NAME;
if (!workerName) {
  console.error("Error: WORKER_NAME environment variable is required.");
  console.error("Usage: WORKER_NAME=xxx node claudex.js [claude args...]");
  process.exit(1);
}

const workerDir = join(homedir(), ".claude", "mini-goal-workers", workerName);
const historyFile = join(workerDir, "history.jsonl");
const userArgs = process.argv.slice(2);
const MAX_SESSION_SIZE = 400 * 1024; // 400KB
const sessionFile = join(workerDir, "session-id");
let cachedJsonlPath = null;

// --- Worker session management ---
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
  if (cachedJsonlPath) {
    try {
      const stat = statSync(cachedJsonlPath);
      if (stat.isFile()) return { path: cachedJsonlPath, size: stat.size };
    } catch {}
    cachedJsonlPath = null;
  }
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

// --- State ---
let child = null;
let history = [];

// --- History management ---
function loadHistory() {
  mkdirSync(workerDir, { recursive: true });
  try {
    const raw = readFileSync(historyFile, "utf-8").trim();
    if (raw) {
      history = raw.split("\n").map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    }
  } catch {}
}

function appendToHistory(entry) {
  const fullEntry = { ...entry, timestamp: new Date().toISOString() };
  history.push(fullEntry);
  try {
    appendFileSync(historyFile, JSON.stringify(fullEntry) + "\n", "utf-8");
  } catch {}
}

// --- System prompt template ---
const promptTemplate = readFileSync(join(pluginDir, "prompts", "system-prompt.md"), "utf-8");

// --- Build system prompt ---
function buildSystemPrompt() {
  let resumeSection = "";

  // History section (3-tier compression)
  let historySection = "";
  const total = history.length;
  if (total > 0) {
    let lastUserPromptFromEnd = 0;
    for (let i = total - 1; i >= 0; i--) {
      if (history[i].type === "user_prompt") {
        lastUserPromptFromEnd = total - i;
        break;
      }
    }

    const RECENT_COUNT = Math.max(20, lastUserPromptFromEnd);
    const MIDDLE_COUNT = 30;
    const recentStart = Math.max(0, total - RECENT_COUNT);
    const middleStart = Math.max(0, recentStart - MIDDLE_COUNT);
    const parts = [];

    if (middleStart > 0) {
      parts.push(`[... ${middleStart} earlier entries omitted. Full history: ${historyFile} ...]`);
    }

    for (let i = middleStart; i < recentStart; i++) {
      const e = history[i];
      if (e.type === "user_prompt") parts.push(`[USER] ${e.prompt}`);
      else if (e.type === "assistant_result") parts.push(`[ASSISTANT] ${e.message}`);
    }

    for (let i = recentStart; i < total; i++) {
      const e = history[i];
      if (e.type === "user_prompt") parts.push(`[USER] ${e.prompt}`);
      else if (e.type === "assistant_result") parts.push(`[ASSISTANT] ${e.message}`);
      else if (e.type === "mini_goal") parts.push(`[MINI_GOAL] ${e.summary}`);
      else if (e.type === "mini_goal_result") {
        const status = e.error ? "ERROR" : "DONE";
        parts.push(`[MINI_GOAL ${status}] ${e.summary}: ${e.result}`);
      }
      else if (e.type === "plan_accepted") parts.push(`[PLAN] ${e.plan}`);
      else if (e.type === "subagent_start") parts.push(`[SUBAGENT_START ${e.subagent_type}] ${e.description}: ${e.prompt}`);
      else if (e.type === "subagent_stop") parts.push(`[SUBAGENT_STOP ${e.agent_type}] ${e.last_assistant_message}`);
    }

    historySection = `\n## Chat history (restored from ${historyFile})\n\n${parts.join("\n\n")}\n`;
  }

  return promptTemplate
    .replace("{{HISTORY_SECTION}}", historySection)
    .replace("{{RESUME_SECTION}}", resumeSection);
}

// --- HTTP Server ---
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

const httpServer = createServer(async (req, res) => {
  try {
    // --- Hook: SessionStart ---
    if (req.method === "POST" && req.url === "/hook/session-start") {
      const prompt = buildSystemPrompt();
      try { writeFileSync(join(workerDir, "LAST_SYSTEM_PROMPT.log"), prompt); } catch {}
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(prompt);
      return;
    }

    // --- Hook: UserPromptSubmit ---
    if (req.method === "POST" && req.url === "/hook/user-prompt-submit") {
      const data = await parseBody(req);
      if (data.prompt) {
        appendToHistory({ type: "user_prompt", prompt: data.prompt });
      }
      // No output = allow the prompt (WORKER_NAME is always set under claudex)
      res.writeHead(200);
      res.end();
      return;
    }

    // --- Hook: ExitPlanMode ---
    if (req.method === "POST" && req.url === "/hook/exit-plan-mode") {
      const data = await parseBody(req);
      const plan = data.tool_input?.plan;
      if (plan) {
        appendToHistory({ type: "plan_accepted", plan });
      }
      res.writeHead(200);
      res.end();
      return;
    }

    // --- Hook: SubagentPretool (PreToolUse Task) ---
    if (req.method === "POST" && req.url === "/hook/subagent-pretool") {
      const data = await parseBody(req);
      const input = data.tool_input || {};
      let prompt = input.prompt;
      if (prompt && prompt.length > 20000) {
        prompt = undefined;
      }
      appendToHistory({ type: "subagent_start", subagent_type: input.subagent_type, description: input.description, prompt });
      res.writeHead(200);
      res.end();
      return;
    }

    // --- Hook: SubagentStop ---
    if (req.method === "POST" && req.url === "/hook/subagent-stop") {
      const data = await parseBody(req);
      if (data.agent_type) {
        let msg = data.last_assistant_message;
        if (msg && msg.length > 20000) {
          msg = undefined;
        }
        appendToHistory({ type: "subagent_stop", agent_id: data.agent_id, agent_type: data.agent_type, last_assistant_message: msg });
      }
      res.writeHead(200);
      res.end();
      return;
    }

    // --- Hook: Stop ---
    if (req.method === "POST" && req.url === "/hook/stop") {
      const data = await parseBody(req);
      if (data.last_assistant_message && data.last_assistant_message.length <= 20000) {
        appendToHistory({ type: "assistant_result", message: data.last_assistant_message });
      }
      res.writeHead(200);
      res.end();
      return;
    }

    // --- Tool: mini-goal-worker ---
    if (req.method === "POST" && req.url === "/tool/mini-goal-worker") {
      const data = await parseBody(req);
      const { summary, detail } = data;

      // Record mini goal to history
      appendToHistory({ type: "mini_goal", summary, detail });

      // Check worker session size → reset if too large
      let stderrOutput = "";
      try {
        const savedSessionId = readSessionId();
        if (savedSessionId) {
          const jsonl = findSessionJsonl(savedSessionId);
          if (jsonl && jsonl.size > MAX_SESSION_SIZE) {
            deleteSessionId();
            const msg = `CONTEXT_RESET: The mini-goal-worker "${workerName}" session exceeded ${MAX_SESSION_SIZE / 1024}KB (was ${Math.round(jsonl.size / 1024)}KB) and has been automatically reset. Please resend this task with full context information (relevant file paths, background, and expected outcome) so the worker can start fresh.`;
            appendToHistory({ type: "mini_goal_result", summary, result: msg, error: true });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ content: [{ type: "text", text: msg }], isError: true }));
            return;
          }
        }

        // Execute worker via agent-sdk
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
          if (message.session_id) sessionId = message.session_id;
          if (message.type === "result") {
            if (message.subtype === "success") {
              resultText = message.result;
            } else {
              resultText = `Error: ${message.errors?.join(", ") ?? "unknown error"}`;
            }
          }
        }

        if (sessionId) saveSessionId(sessionId);

        const result = resultText || "No result returned";
        appendToHistory({ type: "mini_goal_result", summary, result, error: false });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: result }] }));
        return;
      } catch (err) {
        const msg = `mini-goal-worker failed: ${err.message}\n\nstderr:\n${stderrOutput.slice(-2000)}`;
        appendToHistory({ type: "mini_goal_result", summary, result: msg, error: true });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: msg }], isError: true }));
        return;
      }
    }

    // --- Tool: web-search ---
    if (req.method === "POST" && req.url === "/tool/web-search") {
      const data = await parseBody(req);
      const searchQuery = data.query;

      if (!process.env.SEARCH_API_KEY) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          content: [{ type: "text", text: `SEARCH_API_KEY is not set. Define it in ${join(pluginDir, ".env")}. See .env.example for reference.` }],
          isError: true,
        }));
        return;
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
        const result = await resp.json();
        if (result.error) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            content: [{ type: "text", text: `Search API error: ${result.error.message}` }],
            isError: true,
          }));
          return;
        }
        const outputMsg = result.output?.find((o) => o.type === "message");
        const textContent = outputMsg?.content?.find((c) => c.type === "output_text");
        const resultText = textContent?.text || JSON.stringify(result.output);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: resultText }] }));
        return;
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          content: [{ type: "text", text: `Search failed: ${err.message}` }],
          isError: true,
        }));
        return;
      }
    }

    // --- Tool: web-fetch ---
    if (req.method === "POST" && req.url === "/tool/web-fetch") {
      const data = await parseBody(req);
      const { url } = data;

      if (!process.env.CF_ACCOUNT_ID || !process.env.CF_BROWSER_TOKEN) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          content: [{ type: "text", text: `CF_ACCOUNT_ID and CF_BROWSER_TOKEN are not set. Define them in ${join(pluginDir, ".env")}.` }],
          isError: true,
        }));
        return;
      }

      try {
        const cfResp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/browser-rendering/markdown`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.CF_BROWSER_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url }),
        });
        const cfResult = await cfResp.json();
        if (!cfResult.success) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            content: [{ type: "text", text: `Cloudflare Browser Rendering error: ${JSON.stringify(cfResult.errors || cfResult)}` }],
            isError: true,
          }));
          return;
        }
        const markdown = cfResult.result || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: markdown || "(empty page)" }] }));
        return;
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          content: [{ type: "text", text: `Web fetch failed: ${err.message}` }],
          isError: true,
        }));
        return;
      }
    }

    // --- Clear history ---
    if (req.method === "POST" && req.url === "/clear-history") {
      history = [];
      try { writeFileSync(historyFile, "", "utf-8"); } catch {}
      deleteSessionId();
      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// --- Launch claude ---
function launchClaude(port) {
  mkdirSync(workerDir, { recursive: true });

  const args = ["--plugin-dir", pluginDir, "--dangerously-skip-permissions", "--debug", "--disallowed-tools", "WebSearch,WebFetch", ...userArgs];

  child = spawn("claude", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      WORKER_NAME: workerName,
      CLAUDEX_PORT: String(port),
      CLAUDE_PLUGIN_ROOT: pluginDir,
    },
  });

  child.on("exit", (code) => {
    httpServer.close();
    process.exit(code || 0);
  });
}

// --- Start ---
loadHistory();
httpServer.listen(0, "127.0.0.1", () => {
  const port = httpServer.address().port;
  console.log(`[claudex] Listening on 127.0.0.1:${port}`);
  launchClaude(port);
});
