import { createWebSearchHandler } from "./web-search.js";
import { createWebFetchHandler } from "./web-fetch.js";

export function createToolHandlers({ historyManager, pluginDir, log }) {
  const handlers = {};

  // Conditionally register web-search
  const hasWebSearch = process.env.SEARCH_API_KEY && process.env.SEARCH_API_URL && process.env.SEARCH_MODEL;
  if (hasWebSearch) {
    handlers["web-search"] = createWebSearchHandler(pluginDir, log);
  } else {
    log("tools", "web-search disabled: missing SEARCH_API_KEY, SEARCH_API_URL, or SEARCH_MODEL");
  }

  // Conditionally register web-fetch
  const hasWebFetch = process.env.CF_ACCOUNT_ID && process.env.CF_BROWSER_TOKEN;
  if (hasWebFetch) {
    handlers["web-fetch"] = createWebFetchHandler(pluginDir, log);
  } else {
    log("tools", "web-fetch disabled: missing CF_ACCOUNT_ID or CF_BROWSER_TOKEN");
  }

  return handlers;
}
