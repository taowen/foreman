import { join } from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";

export function createToolHandlers({ sessionManager, historyManager, workerDir, pluginDir, log, MAX_SESSION_SIZE }) {
  const workerName = process.env.WORKER_NAME;

  return {
    "mini-goal-worker": async (data) => {
      const { summary, detail } = data;
      log("tool:mini-goal", `start: ${summary}`);

      // Record mini goal to history
      historyManager.appendToHistory({ type: "mini_goal", summary, detail });

      // Check worker session size → reset if too large
      let stderrOutput = "";
      try {
        const savedSessionId = sessionManager.readSessionId();
        if (savedSessionId) {
          const jsonl = sessionManager.findSessionJsonl(savedSessionId);
          log("tool:mini-goal", `session check: id=${savedSessionId}, size=${jsonl ? jsonl.size : "not found"}`);
          if (jsonl && jsonl.size > MAX_SESSION_SIZE) {
            sessionManager.deleteSessionId();
            const msg = `CONTEXT_RESET: The mini-goal-worker "${workerName}" session exceeded ${MAX_SESSION_SIZE / 1024}KB (was ${Math.round(jsonl.size / 1024)}KB) and has been automatically reset. Please resend this task with full context information (relevant file paths, background, and expected outcome) so the worker can start fresh.`;
            log("tool:mini-goal", `session reset: ${msg}`);
            historyManager.appendToHistory({ type: "mini_goal_result", summary, result: msg, error: true });
            return { content: [{ type: "text", text: msg }], isError: true };
          }
        } else {
          log("tool:mini-goal", "no existing session");
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

        log("tool:mini-goal", `query start: resume=${savedSessionId || "none"}`);
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

        if (sessionId) sessionManager.saveSessionId(sessionId);

        const result = resultText || "No result returned";
        log("tool:mini-goal", `query result: ${result.slice(0, 500)}`);
        historyManager.appendToHistory({ type: "mini_goal_result", summary, result, error: false });
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        const msg = `mini-goal-worker failed: ${err.message}\n\nstderr:\n${stderrOutput.slice(-2000)}`;
        log("tool:mini-goal", `error: ${err.stack || err.message}`);
        historyManager.appendToHistory({ type: "mini_goal_result", summary, result: msg, error: true });
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    },

    "web-search": async (data) => {
      const searchQuery = data.query;
      log("tool:web-search", `start: ${searchQuery}`);

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
        const result = await resp.json();
        if (result.error) {
          log("tool:web-search", `API error: ${result.error.message}`);
          return {
            content: [{ type: "text", text: `Search API error: ${result.error.message}` }],
            isError: true,
          };
        }
        const outputMsg = result.output?.find((o) => o.type === "message");
        const textContent = outputMsg?.content?.find((c) => c.type === "output_text");
        const resultText = textContent?.text || JSON.stringify(result.output);
        log("tool:web-search", `result: ${resultText.length} chars`);
        return { content: [{ type: "text", text: resultText }] };
      } catch (err) {
        log("tool:web-search", `error: ${err.stack || err.message}`);
        return {
          content: [{ type: "text", text: `Search failed: ${err.message}` }],
          isError: true,
        };
      }
    },

    "web-fetch": async (data) => {
      const { url, prompt } = data;
      log("tool:web-fetch", `start: url=${url}, prompt=${prompt !== undefined ? JSON.stringify(prompt) : "undefined"}`);

      if (!process.env.CF_ACCOUNT_ID || !process.env.CF_BROWSER_TOKEN) {
        return {
          content: [{ type: "text", text: `CF_ACCOUNT_ID and CF_BROWSER_TOKEN are not set. Define them in ${join(pluginDir, ".env")}.` }],
          isError: true,
        };
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
          log("tool:web-fetch", `CF error: ${JSON.stringify(cfResult.errors || cfResult)}`);
          return {
            content: [{ type: "text", text: `Cloudflare Browser Rendering error: ${JSON.stringify(cfResult.errors || cfResult)}` }],
            isError: true,
          };
        }
        const markdown = cfResult.result || "";
        log("tool:web-fetch", `fetched markdown: ${markdown.length} chars`);

        // If no prompt, return raw markdown as before
        if (!prompt) {
          return { content: [{ type: "text", text: markdown || "(empty page)" }] };
        }

        // Use Haiku to generate a JS extraction function based on the prompt
        try {
          const haikuPrompt = `Write a JavaScript function body that takes a single parameter \`markdown\` (a string) and returns a transformed string.

The transformation instruction is: ${prompt}

Here is the markdown content:
---
${markdown}
---

Output ONLY the function body code. No explanation, no markdown fences, no \`function\` keyword. Just the code that goes inside the function body.`;

          log("tool:web-fetch", `calling Haiku: prompt length=${haikuPrompt.length}, markdown length=${markdown.length}`);

          const haikuOptions = {
            model: "haiku",
            systemPrompt: "You are a code generator. Output ONLY valid JavaScript code, no markdown fences, no explanations.",
            maxTurns: 1,
          };

          const haikuMessages = query({ prompt: haikuPrompt, options: haikuOptions });
          let generatedCode = "";
          for await (const message of haikuMessages) {
            if (message.type === "result" && message.subtype === "success") {
              generatedCode = message.result;
            }
          }

          log("tool:web-fetch", `Haiku generatedCode:\n${generatedCode}`);

          const extractFn = new Function("markdown", generatedCode);
          const result = extractFn(markdown);
          log("tool:web-fetch", `extraction result: ${String(result).length} chars`);
          return { content: [{ type: "text", text: String(result) || "(empty result)" }] };
        } catch (extractErr) {
          log("tool:web-fetch", `extraction error: ${extractErr.stack || extractErr.message}`);
          // Fall back to raw markdown with error note
          return { content: [{ type: "text", text: `[Extraction failed: ${extractErr.message}. Returning raw markdown.]\n\n${markdown || "(empty page)"}` }] };
        }
      } catch (err) {
        log("tool:web-fetch", `fetch error: ${err.stack || err.message}`);
        return {
          content: [{ type: "text", text: `Web fetch failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  };
}
