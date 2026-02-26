import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const claudexPort = process.env.CLAUDEX_PORT;

async function callClaudex(path, data) {
  if (!claudexPort) throw new Error("CLAUDEX_PORT not set");
  const resp = await fetch(`http://127.0.0.1:${claudexPort}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return resp.json();
}

const server = new McpServer({ name: "foreman", version: "1.0.0" });

server.tool(
  "mini-goal-worker",
  {
    summary: z.string().describe("One-line short summary of the mini goal"),
    detail: z.string().describe("Detailed description with file paths (@/absolute/path), background context, and expected outcome"),
  },
  async ({ summary, detail }) => callClaudex("/tool/mini-goal-worker", { summary, detail })
);

server.tool(
  "web-search",
  {
    query: z.string().describe("Search the web for real-time information. Use this when you need current facts, documentation, API references, error messages, or anything not in your training data."),
  },
  async ({ query }) => callClaudex("/tool/web-search", { query })
);

server.tool(
  "web-fetch",
  {
    url: z.string().describe("The URL to fetch and return as markdown"),
  },
  async ({ url }) => callClaudex("/tool/web-fetch", { url })
);

const transport = new StdioServerTransport();
await server.connect(transport);
