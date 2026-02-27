import { readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export function createSessionManager(workerDir, log) {
  const sessionFile = join(workerDir, "session-id");
  let cachedJsonl = null; // { sessionId, path }

  function readSessionId() {
    try {
      const id = readFileSync(sessionFile, "utf-8").trim() || null;
      log("session", `read session id: ${id}`);
      return id;
    } catch {
      log("session", "no session id found");
      return null;
    }
  }

  function saveSessionId(id) {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(sessionFile, id, "utf-8");
    cachedJsonl = null;
    log("session", `saved session id: ${id}`);
  }

  function deleteSessionId() {
    try { unlinkSync(sessionFile); } catch {}
    cachedJsonl = null;
    log("session", "deleted session id");
  }

  function findSessionJsonl(sessionId) {
    if (cachedJsonl && cachedJsonl.sessionId === sessionId) {
      try {
        const stat = statSync(cachedJsonl.path);
        if (stat.isFile()) return { path: cachedJsonl.path, size: stat.size };
      } catch {}
      cachedJsonl = null;
    }
    const projectsDir = join(homedir(), ".claude", "projects");
    try {
      for (const dir of readdirSync(projectsDir)) {
        const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
        try {
          const stat = statSync(candidate);
          if (stat.isFile()) {
            cachedJsonl = { sessionId, path: candidate };
            log("session", `found session jsonl: ${candidate} (${stat.size} bytes)`);
            return { path: candidate, size: stat.size };
          }
        } catch {}
      }
    } catch {}
    log("session", `session jsonl not found for: ${sessionId}`);
    return null;
  }

  return { readSessionId, saveSessionId, deleteSessionId, findSessionJsonl };
}
