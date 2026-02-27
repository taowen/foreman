function parseMarkdown(md) {
  const lines = md.split("\n");
  const sections = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.*)/);
    if (match) {
      if (current) sections.push(current);
      current = { level: match[1].length, heading: match[2], content: "" };
    } else if (current) {
      current.content += line + "\n";
    }
  }
  if (current) sections.push(current);
  return {
    sections,
    section(query) {
      const q = query.toLowerCase();
      return sections.find((s) => s.heading.toLowerCase().includes(q));
    },
  };
}

export function createWebFetchHandler(pluginDir, log) {
  return async (data) => {
    const { url, prompt } = data;
    log("tool:web-fetch", `start: url=${url}, prompt=${prompt !== undefined ? JSON.stringify(prompt) : "undefined"}`);

    try {
      const cfResp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/browser-rendering/markdown`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.CF_BROWSER_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url, gotoOptions: { timeout: 60000 } }),
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
        const haikuPrompt = `Write a JavaScript function body (parameters: \`markdown\`, \`parseMarkdown\`) that returns a string.

Scan the markdown for content relevant to the instruction below.
- If you find relevant content: return it as a string (either a literal or via code).
- If there is NO relevant content at all: return "not found"

A \`parseMarkdown(markdown)\` helper is available: returns { sections: [{level, heading, content}], section(query) }.

Instruction: ${prompt}

Markdown content:
---
${markdown}
---

Output ONLY the function body code. No explanation, no markdown fences.`;

        log("tool:web-fetch", `calling Haiku: prompt length=${haikuPrompt.length}, markdown length=${markdown.length}`);

        const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
        const haikuResp = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "claude-haiku-4-5-20251001",
            max_tokens: 4096,
            system: "You are a code generator. Output ONLY valid JavaScript code, no markdown fences, no explanations.",
            messages: [{ role: "user", content: haikuPrompt }],
          }),
        });
        const haikuResult = await haikuResp.json();
        const generatedCode = haikuResult.content?.[0]?.text || "";

        log("tool:web-fetch", `Haiku generatedCode:\n${generatedCode}`);

        const extractFn = new Function("markdown", "parseMarkdown", generatedCode);
        const raw = extractFn(markdown, parseMarkdown);
        const result = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
        log("tool:web-fetch", `extraction result: ${result.length} chars`);
        return { content: [{ type: "text", text: result || "(empty result)" }] };
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
  };
}
