import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpsProxyAgent } from "https-proxy-agent";

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
        const haikuPrompt = `Write the body of a JavaScript function \`extract(markdown, parseMarkdown)\` that extracts content from the given markdown based on the instruction below.
Available: \`markdown\` (string), \`parseMarkdown(markdown)\` returns { sections: [{level, heading, content}], section(query) returns a section object }.
The function should return a string with the extracted content. If no relevant content is found, return "not found".

Instruction: ${prompt}

Markdown:
---
${markdown}
---`;

        // Prefill assistant response with a clear function signature so Haiku generates a proper function body
        const assistantPrefill = "function extract(markdown, parseMarkdown) {";

        log("tool:web-fetch", `calling Haiku: prompt length=${haikuPrompt.length}, markdown length=${markdown.length}`);

        const haikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "claude-haiku-4-5-20251001";
        const isBedrock = haikuModel.startsWith("arn:") || haikuModel.startsWith("us.") || haikuModel.startsWith("eu.");
        let generatedCode = "";
        const messages = [
          { role: "user", content: haikuPrompt },
          { role: "assistant", content: assistantPrefill },
        ];

        if (isBedrock) {
          // Use AWS Bedrock API
          const clientConfig = { region: process.env.AWS_REGION || "us-west-2" };
          const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
          if (proxyUrl) {
            clientConfig.requestHandler = new NodeHttpHandler({
              httpsAgent: new HttpsProxyAgent(proxyUrl),
            });
          }
          const client = new BedrockRuntimeClient(clientConfig);
          const command = new InvokeModelCommand({
            modelId: haikuModel,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
              anthropic_version: "bedrock-2023-05-31",
              max_tokens: 4096,
              system: "You are a code generator. Output ONLY valid JavaScript code. No markdown fences, no explanations, no comments.",
              messages,
            }),
          });
          const bedrockResp = await client.send(command);
          const bedrockResult = JSON.parse(new TextDecoder().decode(bedrockResp.body));
          generatedCode = bedrockResult.content?.[0]?.text || "";
        } else {
          // Use Anthropic REST API
          const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
          const haikuResp = await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "x-api-key": process.env.ANTHROPIC_API_KEY,
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: haikuModel,
              max_tokens: 4096,
              system: "You are a code generator. Output ONLY valid JavaScript code. No markdown fences, no explanations, no comments.",
              messages,
            }),
          });
          const haikuText = await haikuResp.text();
          let haikuResult;
          try {
            haikuResult = JSON.parse(haikuText);
          } catch (parseErr) {
            log("tool:web-fetch", `Haiku response not JSON (status ${haikuResp.status}): ${haikuText.slice(0, 200)}`);
            return { content: [{ type: "text", text: `[Haiku API error. Returning raw markdown.]\n\n${markdown || "(empty page)"}` }] };
          }
          if (haikuResult.error) {
            log("tool:web-fetch", `Haiku API error: ${JSON.stringify(haikuResult.error)}`);
            return { content: [{ type: "text", text: `[Haiku API error: ${haikuResult.error.message || JSON.stringify(haikuResult.error)}. Returning raw markdown.]\n\n${markdown || "(empty page)"}` }] };
          }
          generatedCode = haikuResult.content?.[0]?.text || "";
        }

        // Prepend the prefill to reconstruct the full code
        generatedCode = (assistantPrefill + generatedCode).trim();
        log("tool:web-fetch", `Haiku generatedCode:\n${generatedCode}`);

        if (!generatedCode || generatedCode === assistantPrefill.trim()) {
          log("tool:web-fetch", `Haiku returned empty code, falling back to raw markdown`);
          return { content: [{ type: "text", text: `[Haiku returned empty extraction code. Returning raw markdown.]\n\n${markdown || "(empty page)"}` }] };
        }

        // generatedCode is now a full function declaration: "function extract(markdown, parseMarkdown) {\n...}"
        // Wrap it so new Function defines extract() then calls it
        const wrapperFn = new Function("markdown", "parseMarkdown", generatedCode + "\nreturn extract(markdown, parseMarkdown);");
        const raw = wrapperFn(markdown, parseMarkdown);
        const result = raw == null ? "" : (typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
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
