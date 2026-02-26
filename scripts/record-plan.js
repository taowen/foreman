import { mkdirSync, writeFileSync } from "fs";
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
  const plan = data.tool_input?.plan;
  if (plan) {
    const workerDir = join(homedir(), ".claude", "mini-goal-workers", workerName);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, "pending-plan.json"),
      JSON.stringify({ plan, timestamp: Date.now() }),
      "utf-8"
    );
  }
} catch {}
