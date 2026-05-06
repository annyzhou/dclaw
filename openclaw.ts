import "dotenv/config";
import Dedalus from "dedalus";

const client = new Dedalus({
  xAPIKey: process.env.DEDALUS_API_KEY,
  baseURL: process.env.DEDALUS_BASE_URL ?? "https://dcs.dedaluslabs.ai",
});

const LLM_MODEL = process.env.LLM_MODEL ?? "anthropic/claude-sonnet-4-6";
const LLM_API_KEY = process.env.LLM_API_KEY;
if (!process.env.DEDALUS_API_KEY || !LLM_API_KEY) {
  console.error("Missing DEDALUS_API_KEY or LLM_API_KEY in .env");
  process.exit(1);
}

const TERMINAL = new Set(["succeeded", "failed", "expired", "cancelled"]);

async function exec(
  mid: string,
  cmd: string,
  label: string,
  timeoutMs = 180000,
): Promise<string> {
  console.log(`> ${label}`);
  let result = await client.machines.executions.create({
    machine_id: mid,
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
      machine_id: mid,
      execution_id: result.execution_id,
    });
  }

  const output = await client.machines.executions.output({
    machine_id: mid,
    execution_id: result.execution_id,
  });
  if (result.status !== "succeeded") {
    const err = result as { error_message?: string };
    throw new Error(`${label}: ${result.status}: ${err.error_message ?? output.stderr ?? output.stdout ?? "(no detail)"}`);
  }
  return (output.stdout ?? "").trim();
}

// 1. Create the machine (~30s to running).
console.log("Creating machine...");
const machine = await client.machines.create({
  vcpu: 2,
  memory_mib: 4096,
  storage_gib: 10,
});
const mid = machine.machine_id;
process.stdout.write(`Machine: ${mid}`);
{
  let ws = await client.machines.retrieve({ machine_id: mid });
  while (ws.status.phase !== "running") {
    if (ws.status.phase === "failed") throw new Error(`Machine failed: ${ws.status.reason}`);
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 2000));
    ws = await client.machines.retrieve({ machine_id: mid });
  }
  console.log(" running.\n");
}

// 2. Install Node + OpenClaw and configure the gateway. One long exec keeps the
//    machine awake; splitting these would let it sleep mid-setup.
//    LLM_API_KEY is mirrored into ANTHROPIC_API_KEY and OPENAI_API_KEY so the
//    gateway picks up whichever provider matches LLM_MODEL.
const SETUP = `set -e
command -v node >/dev/null || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 && apt-get install -y nodejs >/dev/null 2>&1)
node --version
mkdir -p /home/machine/.npm-global /home/machine/.npm-cache /home/machine/.tmp /home/machine/.openclaw
NPM_CONFIG_PREFIX=/home/machine/.npm-global \
  NPM_CONFIG_CACHE=/home/machine/.npm-cache \
  TMPDIR=/home/machine/.tmp \
  npm install -g openclaw@latest --no-audit --no-fund --loglevel=error 2>&1 | tail -3
export PATH=/home/machine/.npm-global/bin:$PATH
export HOME=/home/machine
export OPENCLAW_STATE_DIR=/home/machine/.openclaw
export OPENCLAW_NO_RESPAWN=1
openclaw --version
openclaw config set gateway.mode local
openclaw config set gateway.http.endpoints.chatCompletions.enabled true
openclaw config set gateway.bind loopback
openclaw config set gateway.auth.mode none
openclaw config set env.vars.ANTHROPIC_API_KEY "${LLM_API_KEY}"
openclaw config set env.vars.OPENAI_API_KEY "${LLM_API_KEY}"
echo done`;
await exec(mid, SETUP, "Install Node + OpenClaw and configure", 900000);

// 3. Launch the gateway, detached. Probe the port (not pgrep) to detect "already
//    running" -- pgrep -f can match the previous probe's argv.
const ENV = [
  "export PATH=/home/machine/.npm-global/bin:$PATH",
  "export HOME=/home/machine",
  "export OPENCLAW_STATE_DIR=/home/machine/.openclaw",
  "export OPENCLAW_NO_RESPAWN=1",
].join(" && ");
await exec(
  mid,
  `${ENV} && (ss -tln | awk '{print $4}' | grep -q ':18789$' && echo 'already running') || ` +
    `(setsid bash -c '${ENV} && exec openclaw gateway run > /home/machine/.openclaw/gateway.log 2>&1' </dev/null &>/dev/null & disown && sleep 14 && echo 'launched')`,
  "Start gateway",
);
await exec(mid, "ss -tln | grep -q ':18789' && echo OK || (cat /home/machine/.openclaw/gateway.log; echo NOT_LISTENING; exit 1)", "Verify port 18789");

// 4. One chat round to prove the gateway works end-to-end.
const message = "Hello! In one short sentence: what are you?";
const body = JSON.stringify({
  model: "openclaw/default",
  messages: [{ role: "user", content: message }],
});
const escaped = body.replace(/'/g, "'\\''");
const stdout = await exec(
  mid,
  `curl -sS http://127.0.0.1:18789/v1/chat/completions ` +
    `-H 'Content-Type: application/json' ` +
    `-H 'x-openclaw-model: ${LLM_MODEL}' ` +
    `-d '${escaped}'`,
  `POST /v1/chat/completions (model: ${LLM_MODEL})`,
);

const parsed = JSON.parse(stdout);
if (parsed.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));

console.log(`\nyou>       ${message}`);
console.log(`assistant> ${parsed.choices[0].message.content}`);

console.log(`\n========================================`);
console.log(`  Machine:  ${mid}`);
console.log(`  Send another message: npx tsx chat.ts ${mid} "your message"`);
console.log(`========================================`);
