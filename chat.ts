import "dotenv/config";
import Dedalus from "dedalus";

const client = new Dedalus({
  xAPIKey: process.env.DEDALUS_API_KEY,
  baseURL: process.env.DEDALUS_BASE_URL ?? "https://dcs.dedaluslabs.ai",
});

const MACHINE_ID = process.argv[2];
const message = process.argv.slice(3).join(" ") || "Hello! What are you?";
if (!MACHINE_ID) {
  console.error('Usage: npx tsx chat.ts <machine-id> "your message"');
  process.exit(1);
}

const LLM_MODEL = process.env.LLM_MODEL ?? "anthropic/claude-sonnet-4-6";
const TERMINAL = new Set(["succeeded", "failed", "expired", "cancelled"]);

async function exec(cmd: string, timeoutMs = 180000): Promise<string> {
  let result = await client.machines.executions.create({
    machine_id: MACHINE_ID,
    command: ["/bin/bash", "-c", cmd],
    timeout_ms: timeoutMs,
  });

  let delay = 100;
  while (!TERMINAL.has(result.status)) {
    const r = result as { retry_after_ms?: number };
    const wait = result.status === "wake_in_progress" ? (r.retry_after_ms ?? 0) : delay;
    await new Promise((res) => setTimeout(res, wait));
    delay = Math.min(delay * 2, 2000);
    result = await client.machines.executions.retrieve({
      machine_id: MACHINE_ID,
      execution_id: result.execution_id,
    });
  }

  const output = await client.machines.executions.output({
    machine_id: MACHINE_ID,
    execution_id: result.execution_id,
  });
  if (result.status !== "succeeded") {
    const err = result as { error_message?: string };
    throw new Error(`${result.status}: ${err.error_message ?? output.stderr ?? output.stdout ?? "(no detail)"}`);
  }
  return (output.stdout ?? "").trim();
}

const ws = await client.machines.retrieve({ machine_id: MACHINE_ID });
if (ws.status.phase !== "running" && ws.status.phase !== "sleeping") {
  console.error(`Machine is ${ws.status.phase}, expected running or sleeping.`);
  process.exit(1);
}

const body = JSON.stringify({
  model: "openclaw/default",
  messages: [{ role: "user", content: message }],
});
const escaped = body.replace(/'/g, "'\\''");
const stdout = await exec(
  `curl -sS http://127.0.0.1:18789/v1/chat/completions ` +
    `-H 'Content-Type: application/json' ` +
    `-H 'x-openclaw-model: ${LLM_MODEL}' ` +
    `-d '${escaped}'`,
);

const parsed = JSON.parse(stdout);
if (parsed.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
console.log(parsed.choices[0].message.content);
