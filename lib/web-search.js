import { join } from "path";

export function createWebSearchHandler(pluginDir, log) {
  return async (data) => {
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
  };
}
