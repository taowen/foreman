#!/usr/bin/env node
import { spawn } from "child_process";
import { createServer } from "http";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

import { createLogger } from "./lib/logger.js";
import { createSessionManager } from "./lib/session.js";
import { createHistoryManager } from "./lib/history.js";
import { createPromptBuilder } from "./lib/prompt.js";
import { createHookHandlers } from "./lib/hooks.js";
import { createToolHandlers } from "./lib/tools.js";
import { createTopicDetector } from "./lib/topic-detector.js";
import { createRecentHistory } from "./lib/recent-history.js";

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

const workerName = process.env.WORKER_NAME || basename(process.cwd());

const workerDir = join(homedir(), ".claude", "mini-goal-workers", workerName);
const userArgs = process.argv.slice(2);
const MAX_SESSION_SIZE = 600 * 1024; // 600KB

// --- Initialize modules (phase 1: no dependency on loaded history) ---
const log = createLogger(workerDir);
const sessionManager = createSessionManager(workerDir, log);
const historyManager = createHistoryManager(workerDir, log);
const promptBuilder = createPromptBuilder(pluginDir, historyManager, log);
const sharedState = { mainSessionId: null };
const onRestart = (prompt, reason) => {
  pendingRestart = { prompt, reason };
  setTimeout(() => { if (child) child.kill("SIGTERM"); }, 200);
};
const toolHandlers = createToolHandlers({ sessionManager, historyManager, workerDir, pluginDir, log, MAX_SESSION_SIZE, sharedState, onRestart });

// Phase 2 modules (depend on loaded history) are initialized at startup below
let recentHistory, topicDetector, hookHandlers;

// --- State ---
let child = null;
let pendingRestart = null; // { prompt: string }
let serverPort = null;

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
    log("server", `${req.method} ${req.url}`);

    // --- Hook routes ---
    if (req.method === "POST" && req.url?.startsWith("/hook/")) {
      const name = req.url.slice("/hook/".length);
      const handler = hookHandlers[name];
      if (!handler) {
        res.writeHead(404);
        res.end();
        return;
      }
      const data = await parseBody(req);
      const result = await handler(data);
      res.writeHead(result.status, result.headers || {});
      res.end(result.body || "");
      return;
    }

    // --- Tool routes ---
    if (req.method === "POST" && req.url?.startsWith("/tool/")) {
      const name = req.url.slice("/tool/".length);
      const handler = toolHandlers[name];
      if (!handler) {
        res.writeHead(404);
        res.end();
        return;
      }
      const data = await parseBody(req);
      const result = await handler(data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // --- Clear history ---
    if (req.method === "POST" && req.url === "/clear-history") {
      historyManager.clearHistory();
      sessionManager.deleteSessionId();
      recentHistory.clear();
      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (err) {
    log("server", `error: ${err.stack || err.message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// --- Launch claude ---
function launchClaude(port, initialPrompt) {
  mkdirSync(workerDir, { recursive: true });
  log("server", `launching claude on port ${port}${initialPrompt ? ` with prompt: ${initialPrompt.slice(0, 100)}` : ""}`);

  const args = ["--plugin-dir", pluginDir, "--dangerously-skip-permissions", "--debug", "--disallowed-tools", "WebSearch,WebFetch", ...userArgs];
  if (initialPrompt) {
    args.push("--", initialPrompt);
  }

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
    if (pendingRestart) {
      const { prompt, reason } = pendingRestart;
      pendingRestart = null;
      sharedState.justRestarted = reason || "topic";
      launchClaude(port, prompt);
    } else {
      log("server", `claude exited with code ${code}`);
      httpServer.close();
      process.exit(code || 0);
    }
  });
}

// --- Start ---
log("server", "starting...");
historyManager.loadHistory();
recentHistory = createRecentHistory(workerDir, historyManager, log);
topicDetector = createTopicDetector(recentHistory, log);
hookHandlers = createHookHandlers({ historyManager, recentHistory, promptBuilder, workerDir, log, topicDetector, sharedState, onRestart });
httpServer.listen(0, "127.0.0.1", () => {
  serverPort = httpServer.address().port;
  log("server", `listening on 127.0.0.1:${serverPort}`);
  console.log(`[claudex] Listening on 127.0.0.1:${serverPort}`);
  launchClaude(serverPort);
});
