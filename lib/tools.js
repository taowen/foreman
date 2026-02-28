import { query } from "@anthropic-ai/claude-agent-sdk";
import { createWebSearchHandler } from "./web-search.js";
import { createWebFetchHandler } from "./web-fetch.js";

function buildRecentMiniGoalContext(history, maxPairs = 10) {
  // Exclude the last entry (the current task just appended)
  const src = history.length > 0 ? history.slice(0, -1) : [];
  // Collect recent mini_goal / mini_goal_result entries
  const entries = [];
  for (let i = src.length - 1; i >= 0 && entries.length < maxPairs * 2; i--) {
    const e = src[i];
    if (e.type === "mini_goal" || e.type === "mini_goal_result") {
      entries.unshift(e);
    }
  }
  if (entries.length === 0) return "";

  const parts = ["## Recent history (for context)\n\nThe following mini goals were completed in a previous session:"];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === "mini_goal") {
      const hasResult = entries[i + 1]?.type === "mini_goal_result";
      if (hasResult) {
        parts.push(`### Request: ${e.summary}`);
      } else {
        parts.push(`### Request (not completed): ${e.summary}\n${e.detail}`);
      }
    } else if (e.type === "mini_goal_result") {
      const status = e.error ? "ERROR" : "DONE";
      parts.push(`### Result (${status}): ${e.summary}\n${e.result}`);
    }
  }
  return parts.join("\n\n");
}

export function createToolHandlers({ sessionManager, historyManager, workerDir, pluginDir, log, MAX_SESSION_SIZE, sharedState, onRestart }) {
  const workerName = process.env.WORKER_NAME;

  const handlers = {};

  // Conditionally register web-search
  const hasWebSearch = process.env.SEARCH_API_KEY && process.env.SEARCH_API_URL && process.env.SEARCH_MODEL;
  if (hasWebSearch) {
    handlers["web-search"] = createWebSearchHandler(pluginDir, log);
  } else {
    log("tools", "web-search disabled: missing SEARCH_API_KEY, SEARCH_API_URL, or SEARCH_MODEL");
  }

  // Conditionally register web-fetch
  const hasWebFetch = process.env.CF_ACCOUNT_ID && process.env.CF_BROWSER_TOKEN;
  if (hasWebFetch) {
    handlers["web-fetch"] = createWebFetchHandler(pluginDir, log);
  } else {
    log("tools", "web-fetch disabled: missing CF_ACCOUNT_ID or CF_BROWSER_TOKEN");
  }

  handlers["mini-goal-worker"] = async (data) => {
      const { summary, detail } = data;

      // Record mini goal to history
      historyManager.appendToHistory({ type: "mini_goal", summary, detail });

      // Check main agent JSONL size → restart if too large
      const mainJsonl = sharedState.mainSessionId ? sessionManager.findSessionJsonl(sharedState.mainSessionId) : null;
      if (mainJsonl && mainJsonl.size > MAX_SESSION_SIZE) {
        log("tool:mini-goal", `main agent jsonl too large (${Math.round(mainJsonl.size / 1024)}KB > ${MAX_SESSION_SIZE / 1024}KB), restarting with "continue"`);
        onRestart("continue", "size");
        return { content: [{ type: "text", text: "Context too large, restarting. The incomplete mini-goal will be re-executed after restart." }] };
      }

      // Check worker session size → reset if too large
      let stderrOutput = "";
      try {
        let savedSessionId = sessionManager.readSessionId();
        const mainSize = sharedState.mainSessionId ? sessionManager.findSessionJsonl(sharedState.mainSessionId)?.size : null;
        const workerJsonl = savedSessionId ? sessionManager.findSessionJsonl(savedSessionId) : null;
        const workerSize = workerJsonl?.size ?? null;
        log("tool:mini-goal", `start: ${summary} | main=${mainSize != null ? Math.round(mainSize / 1024) + "KB" : "?"}, worker=${workerSize != null ? Math.round(workerSize / 1024) + "KB" : "none"}${savedSessionId ? ` (session=${savedSessionId.slice(0, 12)}...)` : ""}`);
        if (workerJsonl && workerJsonl.size > MAX_SESSION_SIZE) {
          log("tool:mini-goal", `session exceeded ${MAX_SESSION_SIZE / 1024}KB (was ${Math.round(workerJsonl.size / 1024)}KB), starting new session`);
          sessionManager.deleteSessionId();
          savedSessionId = null;
        }

        // Execute worker via agent-sdk — inject recent history when starting a new session
        let prompt;
        if (!savedSessionId) {
          const recentContext = buildRecentMiniGoalContext(historyManager.history);
          prompt = recentContext
            ? `${recentContext}\n\n---\n\n## Current task: ${summary}\n\n${detail}`
            : `## ${summary}\n\n${detail}`;
          if (recentContext) log("tool:mini-goal", `injected recent history context (${recentContext.length} chars)`);
        } else {
          prompt = `## ${summary}\n\n${detail}`;
        }
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

        log("tool:mini-goal", `query start: resume=${savedSessionId || "none"}`);
        const messages = query({ prompt, options });
        let resultText = "";
        let sessionId = null;
        let msgCount = 0;

        for await (const message of messages) {
          msgCount++;
          log("tool:mini-goal", `msg #${msgCount}: type=${message.type}${message.subtype ? ", subtype=" + message.subtype : ""}`);
          if (message.session_id && !sessionId) {
            sessionId = message.session_id;
            log("tool:mini-goal", "got session_id: " + sessionId.slice(0, 12) + "...");
          } else if (message.session_id) {
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
        log("tool:mini-goal", `stream ended after ${msgCount} messages`);

        if (sessionId) sessionManager.saveSessionId(sessionId);

        const result = resultText || "No result returned";
        log("tool:mini-goal", `done: ${result.slice(0, 500)}`);
        historyManager.appendToHistory({ type: "mini_goal_result", summary, result, error: false });
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        const msg = `mini-goal-worker failed: ${err.message}\n\nstderr:\n${stderrOutput.slice(-2000)}`;
        log("tool:mini-goal", `error: ${err.stack || err.message}`);
        historyManager.appendToHistory({ type: "mini_goal_result", summary, result: msg, error: true });
        return { content: [{ type: "text", text: msg }], isError: true };
      }
  };

  return handlers;
}
