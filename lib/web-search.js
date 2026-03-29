export function createWebSearchHandler(pluginDir, log) {
  return async (data) => {
    const searchQuery = data.query;
    log("tool:web-search", `start: ${searchQuery}`);

    try {
      const model = process.env.SEARCH_MODEL || "gemini-3-flash-preview";
      const baseUrl = (process.env.SEARCH_API_URL || "https://api.whatai.cc").replace(/\/+$/, "");
      const apiUrl = `${baseUrl}/v1beta/models/${model}:generateContent`;

      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.SEARCH_API_KEY}`,
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: "You MUST use google search to find current information before answering. Never answer from memory or training data alone." }],
          },
          contents: [
            { parts: [{ text: searchQuery }] },
          ],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0 },
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

      const candidate = result.candidates?.[0];
      if (!candidate) {
        log("tool:web-search", "no candidates in response");
        return {
          content: [{ type: "text", text: "Search failed: no response from model" }],
          isError: true,
        };
      }

      // Check grounding metadata to verify search was used
      const grounding = candidate.groundingMetadata;
      const searchQueries = grounding?.webSearchQueries || [];
      const groundingChunks = grounding?.groundingChunks || [];
      log("tool:web-search", `grounding: queries=${searchQueries.length}, sources=${groundingChunks.length}`);

      if (searchQueries.length === 0 && groundingChunks.length === 0) {
        log("tool:web-search", "warning: no grounding metadata, result may not be based on search");
      }

      // Extract text from response
      const textParts = (candidate.content?.parts || [])
        .filter((p) => p.text)
        .map((p) => p.text);
      const resultText = textParts.join("\n") || JSON.stringify(result);

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
