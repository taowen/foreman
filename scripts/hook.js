const hookName = process.argv[2];
const claudexPort = process.env.CLAUDEX_PORT;

if (!claudexPort) {
  process.exit(0);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  const resp = await fetch(`http://127.0.0.1:${claudexPort}/hook/${hookName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: input || "{}",
  });
  const text = await resp.text();
  if (text) process.stdout.write(text);
} catch (err) {
  process.stderr.write(`hook ${hookName} error: ${err.message}\n`);
}
