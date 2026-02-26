import { writeFileSync } from "fs";
import { join } from "path";

export function createHookHandlers({ historyManager, promptBuilder, workerDir, log }) {
  return {
    "session-start": async (_data) => {
      log("hook", "session-start");
      const prompt = promptBuilder.buildSystemPrompt();
      try { writeFileSync(join(workerDir, "LAST_SYSTEM_PROMPT.log"), prompt); } catch {}
      return { status: 200, headers: { "Content-Type": "text/plain" }, body: prompt };
    },

    "user-prompt-submit": async (data) => {
      log("hook", `user-prompt-submit: ${data.prompt ? data.prompt.slice(0, 200) : "(no prompt)"}`);
      if (data.prompt) {
        historyManager.appendToHistory({ type: "user_prompt", prompt: data.prompt });
      }
      return { status: 200 };
    },

    "exit-plan-mode": async (data) => {
      const plan = data.tool_input?.plan;
      log("hook", `exit-plan-mode: ${plan ? plan.slice(0, 200) : "(no plan)"}`);
      if (plan) {
        historyManager.appendToHistory({ type: "plan_accepted", plan });
      }
      return { status: 200 };
    },

    "subagent-pretool": async (data) => {
      const input = data.tool_input || {};
      let prompt = input.prompt;
      if (prompt && prompt.length > 20000) {
        prompt = undefined;
      }
      log("hook", `subagent-pretool: ${input.subagent_type} / ${input.description}`);
      historyManager.appendToHistory({ type: "subagent_start", subagent_type: input.subagent_type, description: input.description, prompt });
      return { status: 200 };
    },

    "subagent-stop": async (data) => {
      log("hook", `subagent-stop: ${data.agent_type || "(no agent_type)"}`);
      if (data.agent_type) {
        let msg = data.last_assistant_message;
        if (msg && msg.length > 20000) {
          msg = undefined;
        }
        historyManager.appendToHistory({ type: "subagent_stop", agent_id: data.agent_id, agent_type: data.agent_type, last_assistant_message: msg });
      }
      return { status: 200 };
    },

    "stop": async (data) => {
      log("hook", `stop: message length=${data.last_assistant_message?.length || 0}`);
      if (data.last_assistant_message && data.last_assistant_message.length <= 20000) {
        historyManager.appendToHistory({ type: "assistant_result", message: data.last_assistant_message });
      }
      return { status: 200 };
    },
  };
}
