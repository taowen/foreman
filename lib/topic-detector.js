import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";

export function createTopicDetector(recentHistory, log) {
  async function detectTopicChange(newPrompt) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL;
    const model = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;

    if (!apiKey) {
      log("topic-detect", "skipped: no ANTHROPIC_API_KEY");
      return null;
    }

    try {
      // Build conversation context from recent history
      const entries = recentHistory.getEntries();
      const contextEntries = [];
      for (const e of entries) {
        if (e.type === "user_prompt") {
          contextEntries.push(`User: ${e.prompt}`);
        } else if (e.type === "assistant_result") {
          contextEntries.push(`Assistant: ${e.message}`);
        }
      }

      if (contextEntries.length === 0) {
        log("topic-detect", "skipped: no conversation history (first message)");
        return null;
      }

      const historyText = contextEntries.join("\n");

      // Gemini requires minimum 1024 tokens for caching (~4 chars/token heuristic)
      const useCache = historyText.length > 4000;

      const systemBlock = { type: "text", text: "Decide: does the recent conversation provide useful context for answering the new message?\n\n- N = The new message builds on, refers to, or needs context from the recent conversation to be answered properly.\n- Y = The recent conversation provides NO useful context for the new message. Answering it requires completely different knowledge.\n\nExamples:\n- History: 南昌今天天气 → New: 昨天发布了什么 → Y (weather context doesn't help answer a release question)\n- History: code refactoring → New: 南昌今天天气 → Y (code context doesn't help answer a weather question)\n- History: code refactoring → New: 把那个文件名也改一下 → N (refers back to the code being discussed)\n- History: fixing a bug → New: 再跑一下测试 → N (testing the same bug fix)\n- History: project A → New: 帮我写个完全不同的脚本 → Y (unrelated script, no context needed)\n\nOutput ONLY Y or N, nothing else." };
      const historyBlock = { type: "text", text: `<history>\n${historyText}\n</history>` };
      if (useCache) {
        systemBlock.cache_control = { type: "ephemeral" };
        historyBlock.cache_control = { type: "ephemeral" };
      }

      const apiUrl = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
      const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
      const reqBody = JSON.stringify({
        model,
        max_tokens: 10,
        messages: [
          {
            role: "system",
            content: useCache ? [systemBlock] : systemBlock.text,
          },
          {
            role: "user",
            content: useCache ? [
              historyBlock,
              { type: "text", text: `<new_message>\n${newPrompt}\n</new_message>` },
            ] : `${historyBlock.text}\n\n<new_message>\n${newPrompt}\n</new_message>`,
          },
        ],
      });
      const { text: respText } = await new Promise((resolve, reject) => {
        const parsedUrl = new URL(apiUrl);
        const options = {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
        };
        if (proxyUrl) {
          options.agent = new HttpsProxyAgent(proxyUrl);
        }
        const req = https.request(parsedUrl, options, (res) => {
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => resolve({ text: data }));
        });
        req.on("error", reject);
        req.write(reqBody);
        req.end();
      });

      const result = JSON.parse(respText);
      const answer = result.choices?.[0]?.message?.content?.trim();
      const isNewTopic = answer === "Y";
      const usage = result.usage || {};
      const cached = usage.prompt_tokens_details?.cached_tokens;

      log("topic-detect", `prompt="${newPrompt.slice(0, 100)}" result=${answer} isNewTopic=${isNewTopic} usage: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}${cached != null ? ` cached=${cached}` : ""}`);

      return isNewTopic;
    } catch (err) {
      log("topic-detect", `error: ${err.stack || err.message}`);
      return null;
    }
  }

  return { detectTopicChange };
}
