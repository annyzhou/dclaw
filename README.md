# Run OpenClaw on a Dedalus Machine

A cookbook example: spin up a [Dedalus Machine](https://www.dedaluslabs.ai/) (Ubuntu microVM),
install [OpenClaw](https://docs.openclaw.ai), and chat with it from your terminal.

The script is provider-agnostic — point it at any LLM that OpenClaw supports (Anthropic,
OpenAI, etc.) by setting `LLM_MODEL` and `LLM_API_KEY`.

## Prereqs

- Node.js 20+
- A Dedalus API key — sign up at <https://www.dedaluslabs.ai/>
- An LLM provider API key (Anthropic, OpenAI, …)

## Quickstart

```bash
cp .env.example .env       # fill in DEDALUS_API_KEY, LLM_MODEL, LLM_API_KEY
npm install
npx tsx openclaw.ts        # creates a machine, installs OpenClaw, sends one chat
```

Expected end-to-end runtime: **~3 minutes** (machine provision ~30s, `npm install -g openclaw` ~2min, one chat round ~5s).

The script ends by printing the assistant's reply and the machine ID. To send another message to the same machine:

```bash
npx tsx chat.ts <machine-id> "what's 2 + 2?"
```

## Choosing a model

`LLM_MODEL` is sent to the gateway as the `x-openclaw-model` header, so any model
OpenClaw routes to works. Examples:

| Provider  | `LLM_MODEL`                       | `LLM_API_KEY`           |
|-----------|-----------------------------------|-------------------------|
| Anthropic | `anthropic/claude-sonnet-4-6`     | `sk-ant-...`            |
| OpenAI    | `openai/gpt-4o`                   | `sk-...`                |

Any provider OpenClaw lists at <https://docs.openclaw.ai> works the same way.

## Machine sizing

| Resource | Default  | Why                                                |
|----------|----------|----------------------------------------------------|
| vCPU     | 2        | One core for the gateway, one for the agent turn   |
| Memory   | 4096 MiB | Gateway idles ~300 MiB; agent turns spike higher   |
| Storage  | 10 GiB   | Persistent volume mounted at `/home/machine`       |

These are the values this example runs at. Smaller machines may work, but `npm install -g openclaw`
on a cold machine is memory-hungry; if you go below 4 GiB, watch for OOM during install.

## What `openclaw.ts` does

1. **Create the machine** with `client.machines.create({ vcpu, memory_mib, storage_gib })`
   and wait for `phase === "running"`.
2. **Install Node.js 22 + OpenClaw** under `/home/machine/.npm-global` (the persistent volume).
3. **Configure the gateway** — `gateway.mode=local`, enable `/v1/chat/completions`, bind
   to loopback, no auth, mirror `LLM_API_KEY` into both `ANTHROPIC_API_KEY` and
   `OPENAI_API_KEY` env vars.
4. **Start the gateway** detached on port 18789.
5. **Send one chat message** — POST to `/v1/chat/completions` over the execution API
   and print the reply.

## Notes on security

The example binds the gateway to **loopback only** (`gateway.bind=loopback`) and disables
auth (`gateway.auth.mode=none`). All chat traffic flows through the Dedalus execution API,
which already authenticates via your `DEDALUS_API_KEY`.

To expose the gateway to the public internet via a Dedalus preview tunnel, add token auth
first — see <https://docs.openclaw.ai/web> for `gateway.auth.mode=token` and
`controlUi.allowedOrigins`.

## Files

```
.env.example      DEDALUS_API_KEY, LLM_MODEL, LLM_API_KEY
openclaw.ts       end-to-end: create machine + install + configure + one chat round
chat.ts           send one message to an existing machine
package.json
```
