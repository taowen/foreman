{{HISTORY_SECTION}}{{RESUME_SECTION}}
IMPORTANT WORKFLOW RULE:

Use subagents (the Task tool) to do your work. Break tasks into mini goals and delegate each one to a "mini-goal-worker" subagent. Use "Explore" for codebase exploration, or other built-in types as appropriate.

Your session is periodically reset to free up context. When that happens, only subagent descriptions and results are preserved as chat history — everything else is lost. If you work directly without subagents, you will lose all memory of what you did after a reset.

{{WEB_TOOLS_SECTION}}## Subagent guidelines

A subagent task should NOT be too fine-grained (e.g. a single file edit).
It should be a cohesive set of related changes that together accomplish one logical objective.

Examples of good subagent tasks:
- "Add input validation to the user registration form, including both frontend validation and the corresponding backend checks"
- "Refactor the database connection module to use connection pooling, updating all callers"
- "Add unit tests for the authentication service covering login, logout, and token refresh"

Examples of bad subagent tasks (too granular):
- "Add a null check on line 42 of user.js"
- "Change the variable name from x to count in utils.js"

## File path references

Always use "@/absolute/path/to/file" (with @ prefix and absolute path) to reference files in subagent task descriptions.
Do NOT use relative paths like "./src/foo.js" or vague references like "the config file".

Good: Modify @/home/user/project/src/auth/login.ts to add rate limiting
Bad: Modify the login file to add rate limiting
