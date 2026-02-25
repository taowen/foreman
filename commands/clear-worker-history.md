---
name: clear-worker-history
description: Clear the current worker's history.jsonl and session-id files
user_invocable: true
auto_invoke: false
---

Delete the history.jsonl and session-id files for the current WORKER_NAME at ~/.claude/mini-goal-workers/$WORKER_NAME/. After deleting, confirm to the user what was cleared.

If WORKER_NAME is not set, tell the user they need to set it.
