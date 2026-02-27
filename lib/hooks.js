import { writeFileSync } from "fs";
import { join } from "path";

export function createHookHandlers({ historyManager, recentHistory, promptBuilder, workerDir, log, topicDetector, sharedState, onRestart }) {
  return {
    "session-start": async (data) => {
      log("hook", `session-start data keys: ${Object.keys(data || {}).join(", ")}`);
      if (data?.session_id) {
        sharedState.mainSessionId = data.session_id;
        log("hook", `stored mainSessionId: ${data.session_id}`);
      } else if (data?.sessionId) {
        sharedState.mainSessionId = data.sessionId;
        log("hook", `stored mainSessionId: ${data.sessionId}`);
      }
      const prompt = promptBuilder.buildSystemPrompt();
      try { writeFileSync(join(workerDir, "last-system-prompt.log"), prompt); } catch {}
      return { status: 200, headers: { "Content-Type": "text/plain" }, body: prompt };
    },

    "user-prompt-submit": async (data) => {
      log("hook", `user-prompt-submit: ${data.prompt ? data.prompt.slice(0, 200) : "(no prompt)"}`);
      if (data.prompt) {
        let isNewTopic = false;
        if (promptBuilder.isJustRestarted()) {
          promptBuilder.clearJustRestarted();
          log("hook", "skipped topic detection: just restarted");
        } else {
          try {
            isNewTopic = await topicDetector.detectTopicChange(data.prompt);
            if (isNewTopic) {
              recentHistory.clear();
            }
          } catch {}
        }
        historyManager.appendToHistory({ type: "user_prompt", prompt: data.prompt });
        recentHistory.append({ type: "user_prompt", prompt: data.prompt });
        if (isNewTopic && onRestart) {
          onRestart(data.prompt);
        }
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
        const msg = data.last_assistant_message.length > 300 ? data.last_assistant_message.slice(0, 300) + "..." : data.last_assistant_message;
        recentHistory.append({ type: "assistant_result", message: msg });
      }
      return { status: 200 };
    },
  };
}
