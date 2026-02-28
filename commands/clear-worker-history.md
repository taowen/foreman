---
name: clear-worker-history
description: Clear the current worker's history.jsonl file
user_invocable: true
auto_invoke: false
---

Clear the current worker's history state.

If CLAUDEX_PORT is set (running under claudex), run:
```
curl -s -X POST http://127.0.0.1:$CLAUDEX_PORT/clear-history
```

If CLAUDEX_PORT is not set, delete the file manually:
```
rm -f ~/.claude/mini-goal-workers/$WORKER_NAME/history.jsonl
```

After clearing, confirm to the user what was cleared.

If WORKER_NAME is not set, tell the user they need to set it.
