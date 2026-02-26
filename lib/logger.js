import { appendFileSync } from "fs";
import { join } from "path";

export function createLogger(workerDir) {
  const logFile = join(workerDir, "claudex.log");
  return function log(category, message) {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] [${category}] ${message}\n`);
    } catch {}
  };
}
