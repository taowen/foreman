import { readFileSync } from "fs";
import { join } from "path";

export function createPromptBuilder(pluginDir, historyManager, log) {
  const promptTemplate = readFileSync(join(pluginDir, "prompts", "system-prompt.md"), "utf-8");

  function formatAskUserQuestion(e) {
    const lines = [];
    const questions = e.questions || [];
    const answers = e.answers || {};
    for (const q of questions) {
      lines.push(`[ASSISTANT asked] ${q}`);
    }
    // actual structure: answers = { questions: [...], answers: { "question text": "answer" } }
    const answerMap = answers.answers?.answers || answers.answers || answers;
    if (answerMap && typeof answerMap === "object" && !Array.isArray(answerMap)) {
      for (const [k, v] of Object.entries(answerMap)) {
        if (k !== "annotations" && k !== "questions" && typeof v === "string") {
          lines.push(`[USER answered] ${v}`);
        }
      }
    }
    return lines.join("\n");
  }

  function buildSystemPrompt({ minimal = false } = {}) {
    let resumeSection = "";

    // History section (3-tier compression)
    let historySection = "";
    const history = historyManager.history;
    const historyFile = historyManager.historyFile;
    const total = history.length;
    if (total > 0) {
      const parts = [];

      if (minimal) {
        parts.push(`[... ${total} earlier entries omitted. Full history: ${historyFile} ...]`);
      } else {
        let lastUserPromptFromEnd = 0;
        for (let i = total - 1; i >= 0; i--) {
          if (history[i].type === "user_prompt") {
            lastUserPromptFromEnd = total - i;
            break;
          }
        }

        const RECENT_COUNT = Math.max(10, lastUserPromptFromEnd);
        const MIDDLE_COUNT = 30;
        const recentStart = Math.max(0, total - RECENT_COUNT);
        const middleStart = Math.max(0, recentStart - MIDDLE_COUNT);

        if (middleStart > 0) {
          parts.push(`[... ${middleStart} earlier entries omitted. Full history: ${historyFile} ...]`);
        }

        for (let i = middleStart; i < recentStart; i++) {
          const e = history[i];
          if (e.type === "user_prompt") parts.push(`[USER] ${e.prompt}`);
          else if (e.type === "assistant_result") parts.push(`[ASSISTANT] ${e.message}`);
          else if (e.type === "ask_user_question") parts.push(formatAskUserQuestion(e));
        }

        for (let i = recentStart; i < total; i++) {
          const e = history[i];
          if (e.type === "user_prompt") parts.push(`[USER] ${e.prompt}`);
          else if (e.type === "assistant_result") parts.push(`[ASSISTANT] ${e.message}`);
          else if (e.type === "plan_accepted") parts.push(`[PLAN] ${e.plan}`);
          else if (e.type === "subagent_start") parts.push(`[SUBAGENT_START ${e.subagent_type}] ${e.description}: ${e.prompt}`);
          else if (e.type === "subagent_stop") parts.push(`[SUBAGENT_STOP ${e.agent_type}] ${e.last_assistant_message}`);
          else if (e.type === "ask_user_question") parts.push(formatAskUserQuestion(e));
        }
      }

      historySection = `\n## Chat history (restored from ${historyFile})\n\n${parts.join("\n\n")}\n`;
    }

    // Build web tools section conditionally
    let webToolsSection = "";
    const hasWebSearch = process.env.SEARCH_API_KEY && process.env.SEARCH_API_URL && process.env.SEARCH_MODEL;
    const hasWebFetch = process.env.CF_ACCOUNT_ID && process.env.CF_BROWSER_TOKEN;
    if (hasWebSearch || hasWebFetch) {
      const parts = [];
      if (hasWebSearch) parts.push('use the "web-search" MCP tool for real-time information (current docs, APIs, error messages, latest versions, etc.) instead of WebFetch or WebSearch');
      if (hasWebFetch) parts.push('use the "web-fetch" MCP tool to fetch and extract content from URLs (text/HTML only — for downloading files or binary content, use curl first; only fall back to web-fetch if curl cannot retrieve the content)');
      webToolsSection = `When you need to look up information: ${parts.join("; ")}.\n\n`;
      webToolsSection += `How web-fetch works: it uses Cloudflare Browser Rendering to load the page in a headless browser (which executes JavaScript and renders SPAs), converts the rendered page to markdown, then uses Haiku to extract relevant content based on the user's prompt. This means it can handle JS-rendered pages that curl cannot, but it is slower and only returns text content. Prefer curl for simple/static pages and file downloads; use web-fetch for JS-heavy sites or when curl gets blocked/returns incomplete content.\n\n`;
      webToolsSection += `For GitHub source code: do NOT use web-fetch or web-search to read GitHub repository code. Instead, use the "deepwiki" MCP tool (ask_question) to ask questions about a repo, or clone the repo locally and read the files directly. web-fetch/web-search are for general web pages, documentation sites, and real-time information — not for browsing GitHub source code.\n\n`;
    }

    const result = promptTemplate
      .replace("{{HISTORY_SECTION}}", historySection)
      .replace("{{RESUME_SECTION}}", resumeSection)
      .replace("{{WEB_TOOLS_SECTION}}", webToolsSection);

    log("prompt", `built system prompt: ${result.length} chars, ${history.length} history entries`);
    return result;
  }

  return { buildSystemPrompt };
}
