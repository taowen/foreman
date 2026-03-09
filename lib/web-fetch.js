import https from "node:https";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpsProxyAgent } from "https-proxy-agent";

function parseMarkdown(md) {
  const lines = md.split("\n");
  const sections = [];
  let current = null;
  let inCodeFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      if (current) current.content += line + "\n";
      continue;
    }
    if (inCodeFence) {
      if (current) current.content += line + "\n";
      continue;
    }
    const match = line.match(/^(#{1,6})\s+(.*)/);
    if (match) {
      let heading = match[2].trim();
      if (!heading) {
        // Empty heading: look ahead up to 5 lines for the real heading text
        for (let j = i + 1; j < lines.length && j <= i + 5; j++) {
          const ahead = lines[j].trim();
          if (!ahead) continue;
          if (/^\[.*\]\(#/.test(ahead)) continue;
          heading = ahead;
          break;
        }
      }
      if (current) sections.push(current);
      current = { level: match[1].length, heading, content: "" };
    } else if (current) {
      current.content += line + "\n";
    }
  }
  if (current) sections.push(current);
  return {
    sections,
    section(query) {
      const q = query.replace(/^#+\s*/, "").toLowerCase();
      return sections.find((s) => s.heading.toLowerCase().includes(q)) || { heading: "", content: "" };
    },
  };
}

async function callHaiku(systemPrompt, messages, log) {
  const haikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "claude-haiku-4-5-20251001";
  const isBedrock = haikuModel.startsWith("arn:") || haikuModel.startsWith("us.") || haikuModel.startsWith("eu.");
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

  if (isBedrock) {
    const clientConfig = { region: process.env.AWS_REGION || "us-west-2" };
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
        max_tokens: 8192,
        system: systemPrompt,
        messages,
      }),
    });
    const bedrockResp = await client.send(command);
    const bedrockResult = JSON.parse(new TextDecoder().decode(bedrockResp.body));
    return { text: bedrockResult.content?.[0]?.text || "", error: null };
  } else {
    const baseUrl = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
    const apiUrl = `${baseUrl}/v1/messages`;
    const reqBody = JSON.stringify({
      model: haikuModel,
      max_tokens: 8192,
      system: systemPrompt,
      messages,
    });
    const { status, text: respText } = await new Promise((resolve, reject) => {
      const parsedUrl = new URL(apiUrl);
      const options = {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
      };
      if (proxyUrl) {
        options.agent = new HttpsProxyAgent(proxyUrl);
      }
      const req = https.request(parsedUrl, options, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => resolve({ status: res.statusCode, text: data }));
      });
      req.on("error", reject);
      req.write(reqBody);
      req.end();
    });
    let result;
    try {
      result = JSON.parse(respText);
    } catch (parseErr) {
      log("tool:web-fetch", `Haiku response not JSON (status ${status}): ${respText.slice(0, 200)}`);
      return { text: "", error: `Haiku API error (non-JSON response)` };
    }
    if (result.error) {
      log("tool:web-fetch", `Haiku API error: ${JSON.stringify(result.error)}`);
      return { text: "", error: result.error.message || JSON.stringify(result.error) };
    }
    return { text: result.content?.[0]?.text || "", error: null };
  }
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
        // Pre-extract headings so Haiku can see them at a glance without scanning huge markdown
        const parsed = parseMarkdown(markdown);
        const headingList = parsed.sections.map(s => `- (h${s.level}) ${s.heading}`).join("\n");
        log("tool:web-fetch", `pre-extracted ${parsed.sections.length} headings from markdown`);

        // For large markdown, truncate what we send to Haiku to save tokens.
        const MAX_PROMPT_MD = 50 * 1024;
        const markdownForPrompt = markdown.length > MAX_PROMPT_MD
          ? markdown.slice(0, MAX_PROMPT_MD) + `\n\n... [truncated, ${markdown.length - MAX_PROMPT_MD} more chars. Full markdown is available at runtime via the \`markdown\` parameter] ...`
          : markdown;

        const haikuPrompt = `You are filtering a web page for the user. Your job is to write a JavaScript function that extracts the relevant parts.

IMPORTANT: Do NOT guess or assume heading names. You MUST use ONLY the exact headings listed below. If the markdown has no clear structure, use string matching (indexOf, includes, regex) on the actual text.

Available: \`markdown\` (string), \`parseMarkdown(markdown)\` returns { sections: [{level, heading, content}], section(query) returns a section object }. NOTE: \`heading\` is plain text WITHOUT "#" marks (e.g. "Hook events", not "## Hook events"). \`section(query)\` uses substring matching on the plain text heading.

Write the body of a JavaScript function \`extract(markdown, parseMarkdown)\` that returns a string with the filtered content.

User wants: ${prompt}

Here are ALL the headings that actually exist in the markdown (use ONLY these exact names):
${headingList || "(no headings found)"}

Markdown to filter:
---
${markdownForPrompt}
---`;

        const assistantPrefill = "function extract(markdown, parseMarkdown) {";
        log("tool:web-fetch", `round 1: calling Haiku for code generation, prompt length=${haikuPrompt.length}`);

        const codeResp = await callHaiku(
          "You are a code generator. Output ONLY valid JavaScript code. No markdown fences, no explanations. Use EXACT strings from the provided markdown, never guess or fabricate heading names.",
          [
            { role: "user", content: haikuPrompt },
            { role: "assistant", content: assistantPrefill },
          ],
          log,
        );

        if (codeResp.error) {
          return { content: [{ type: "text", text: `[Haiku API error: ${codeResp.error}. Returning raw markdown.]\n\n${markdown || "(empty page)"}` }] };
        }

        let generatedCode = (assistantPrefill + codeResp.text).trim();
        log("tool:web-fetch", `Haiku generatedCode:\n${generatedCode}`);

        if (!generatedCode || generatedCode === assistantPrefill.trim()) {
          log("tool:web-fetch", `Haiku returned empty code, falling back to raw markdown`);
          return { content: [{ type: "text", text: markdown || "(empty page)" }] };
        }

        const wrapperFn = new Function("markdown", "parseMarkdown", generatedCode + "\nreturn extract(markdown, parseMarkdown);");
        const raw = wrapperFn(markdown, parseMarkdown);
        let result = raw == null ? "" : (typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
        log("tool:web-fetch", `round 1 extraction result: ${result.length} chars`);

        // If result is still too large (>30KB), do a second round where Haiku directly outputs filtered content
        const MAX_RESULT = 30 * 1024;
        if (result.length > MAX_RESULT) {
          log("tool:web-fetch", `round 2: result too large (${result.length} chars > ${MAX_RESULT}), calling Haiku for direct extraction`);
          const round2Resp = await callHaiku(
            "You are a content extractor. Read the provided web page content and output ONLY the parts that are relevant to the user's request. Output the relevant content directly as markdown. Be thorough but exclude navigation, sidebars, footers, and other irrelevant sections. Do NOT output code or explanations.",
            [
              {
                role: "user",
                content: `Extract the relevant content from this web page.\n\nUser wants: ${prompt}\n\n---\n${result}\n---`,
              },
            ],
            log,
          );
          if (!round2Resp.error && round2Resp.text) {
            log("tool:web-fetch", `round 2 extraction result: ${round2Resp.text.length} chars`);
            result = round2Resp.text;
          } else {
            log("tool:web-fetch", `round 2 failed: ${round2Resp.error || "empty response"}, using round 1 result`);
          }
        }

        return { content: [{ type: "text", text: result || markdown || "(empty page)" }] };
      } catch (extractErr) {
        log("tool:web-fetch", `extraction error: ${extractErr.stack || extractErr.message}`);
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
