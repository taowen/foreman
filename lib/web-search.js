export function createWebSearchHandler(pluginDir, log) {
  return async (data) => {
    const searchQuery = data.query;
    log("tool:web-search", `start: ${searchQuery}`);

    try {
      const resp = await fetch(process.env.SEARCH_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.SEARCH_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.SEARCH_MODEL,
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
