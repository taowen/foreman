import { readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export function createSessionManager(workerDir, log) {
  const sessionFile = join(workerDir, "session-id");
  let cachedJsonlPath = null;

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
    cachedJsonlPath = null;
    log("session", `saved session id: ${id}`);
  }

  function deleteSessionId() {
    try { unlinkSync(sessionFile); } catch {}
    cachedJsonlPath = null;
    log("session", "deleted session id");
  }

  function findSessionJsonl(sessionId) {
    if (cachedJsonlPath) {
      try {
        const stat = statSync(cachedJsonlPath);
        if (stat.isFile()) return { path: cachedJsonlPath, size: stat.size };
      } catch {}
      cachedJsonlPath = null;
    }
    const projectsDir = join(homedir(), ".claude", "projects");
    try {
      for (const dir of readdirSync(projectsDir)) {
        const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
        try {
          const stat = statSync(candidate);
          if (stat.isFile()) {
            cachedJsonlPath = candidate;
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
