import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const workerName = process.env.WORKER_NAME;

if (!workerName) {
  console.log(JSON.stringify({
    decision: "block",
    reason: "WORKER_NAME environment variable is required. Start with: WORKER_NAME=xxx claude --plugin-dir /path/to/plugin"
  }));
  process.exit(0);
}

// Read hook input from stdin
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}

try {
  const data = JSON.parse(input);
  const prompt = data.prompt;
  if (prompt) {
    const workerDir = join(homedir(), ".claude", "mini-goal-workers", workerName);
    mkdirSync(workerDir, { recursive: true });
    const line = JSON.stringify({ type: "user_prompt", prompt, timestamp: new Date().toISOString() });
    appendFileSync(join(workerDir, "history.jsonl"), line + "\n", "utf-8");
  }
} catch {}
