import { readFileSync } from "fs";
import { join } from "path";

export function createPromptBuilder(pluginDir, historyManager, log) {
  const promptTemplate = readFileSync(join(pluginDir, "prompts", "system-prompt.md"), "utf-8");
  let justRestarted = null; // null | "topic" | "size"

  function setJustRestarted(reason) {
    justRestarted = reason;
  }

  function buildSystemPrompt() {
    let resumeSection = "";

    // History section (3-tier compression)
    let historySection = "";
    const history = historyManager.history;
    const historyFile = historyManager.historyFile;
    const total = history.length;
    if (total > 0) {
      const parts = [];

      if (justRestarted === "topic") {
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
        const MIDDLE_COUNT = 15;
        const recentStart = Math.max(0, total - RECENT_COUNT);
        const middleStart = Math.max(0, recentStart - MIDDLE_COUNT);

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
          else if (e.type === "mini_goal") {
            const hasResult = history[i + 1]?.type === "mini_goal_result";
            if (hasResult) {
              parts.push(`[MINI_GOAL] ${e.summary}`);
            } else {
              parts.push(`⚠️ INCOMPLETE MINI GOAL — needs to be re-dispatched:\nSummary: ${e.summary}\nDetail: ${e.detail}\n→ You should re-dispatch this mini goal using the mini-goal-worker tool to continue the unfinished work.`);
            }
          }
          else if (e.type === "mini_goal_result") {
            const status = e.error ? "ERROR" : "DONE";
            parts.push(`[MINI_GOAL ${status}] ${e.summary}: ${e.result}`);
          }
          else if (e.type === "plan_accepted") parts.push(`[PLAN] ${e.plan}`);
          else if (e.type === "subagent_start") parts.push(`[SUBAGENT_START ${e.subagent_type}] ${e.description}: ${e.prompt}`);
          else if (e.type === "subagent_stop") parts.push(`[SUBAGENT_STOP ${e.agent_type}] ${e.last_assistant_message}`);
        }
      }

      historySection = `\n## Chat history (restored from ${historyFile})\n\n${parts.join("\n\n")}\n`;
    }

    const result = promptTemplate
      .replace("{{HISTORY_SECTION}}", historySection)
      .replace("{{RESUME_SECTION}}", resumeSection);

    log("prompt", `built system prompt: ${result.length} chars, ${history.length} history entries`);
    return result;
  }

  function isJustRestarted() {
    return !!justRestarted;
  }

  function clearJustRestarted() {
    justRestarted = null;
  }

  return { buildSystemPrompt, setJustRestarted, isJustRestarted, clearJustRestarted };
}
