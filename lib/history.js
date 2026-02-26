import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";

export function createHistoryManager(workerDir, log) {
  const historyFile = join(workerDir, "history.jsonl");
  let history = [];

  function loadHistory() {
    mkdirSync(workerDir, { recursive: true });
    try {
      const raw = readFileSync(historyFile, "utf-8").trim();
      if (raw) {
        history = raw.split("\n").map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
      }
    } catch {}
    log("history", `loaded ${history.length} entries from ${historyFile}`);
  }

  function appendToHistory(entry) {
    const fullEntry = { ...entry, timestamp: new Date().toISOString() };
    history.push(fullEntry);
    try {
      appendFileSync(historyFile, JSON.stringify(fullEntry) + "\n", "utf-8");
    } catch {}
    log("history", `appended entry: ${entry.type}`);
  }

  function clearHistory() {
    history = [];
    try { writeFileSync(historyFile, "", "utf-8"); } catch {}
    log("history", "cleared history");
  }

  return {
    get history() { return history; },
    historyFile,
    loadHistory,
    appendToHistory,
    clearHistory,
  };
}
