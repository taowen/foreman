import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const workerName = process.env.WORKER_NAME;
if (!workerName) process.exit(0);

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}

try {
  const data = JSON.parse(input);
  const message = data.last_assistant_message;
  if (message) {
    const workerDir = join(homedir(), ".claude", "mini-goal-workers", workerName);
    mkdirSync(workerDir, { recursive: true });
    const line = JSON.stringify({ type: "assistant_result", message, timestamp: new Date().toISOString() });
    appendFileSync(join(workerDir, "history.jsonl"), line + "\n", "utf-8");
  }
} catch (err) {
  process.stderr.write(`record-stop error: ${err.message}\n`);
}
