import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

export function createRecentHistory(workerDir, historyManager, log) {
  const filePath = join(workerDir, "recent-history.json");
  const MAX_ENTRIES = 40; // 20 pairs
  let entries = [];

  function rebuild() {
    const all = historyManager.history;
    entries = [];
    for (const e of all) {
      if (e.type === "user_prompt") {
        entries.push({ type: "user_prompt", prompt: e.prompt });
      } else if (e.type === "assistant_result") {
        const msg = e.message && e.message.length > 300 ? e.message.slice(0, 300) + "..." : e.message;
        entries.push({ type: "assistant_result", message: msg });
      }
    }
    entries = entries.slice(-MAX_ENTRIES);
    try { writeFileSync(filePath, JSON.stringify(entries)); } catch {}
    log("recent-history", `rebuilt from history: ${entries.length} entries`);
  }

  function loadOrRebuild() {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length > MAX_ENTRIES) {
        rebuild();
        return;
      }
      entries = parsed;
      log("recent-history", `loaded ${entries.length} entries`);
    } catch {
      rebuild();
    }
  }

  function append(entry) {
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
      rebuild();
    } else {
      try { writeFileSync(filePath, JSON.stringify(entries)); } catch {}
    }
    log("recent-history", `appended ${entry.type}, total=${entries.length}`);
  }

  function getEntries() {
    return entries;
  }

  function clear() {
    entries = [];
    try { writeFileSync(filePath, "[]"); } catch {}
    log("recent-history", "cleared");
  }

  loadOrRebuild();

  return { append, getEntries, clear };
}
