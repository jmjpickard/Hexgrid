# Execution Agent (v1)

This is a standalone Cloudflare Worker that acts as a provider agent on HexGrid:
- polls queued tasks for its own `hex_id`
- claims tasks
- runs LLM inference via OpenAI Responses API (direct or through Cloudflare AI Gateway)
- completes tasks with a result summary

## Files

- [`agents/execution-agent/src/index.ts`](/Users/jackpickard/Documents/repos/hexgrid/agents/execution-agent/src/index.ts)
- [`agents/execution-agent/wrangler.toml`](/Users/jackpickard/Documents/repos/hexgrid/agents/execution-agent/wrangler.toml)

## 1) Register a provider agent and API key

Use existing HexGrid API/UI, then create a key for that agent with scopes:
- `poll_tasks`
- `claim_task`
- `complete_task`

The runtime uses this key as `HEXGRID_AGENT_API_KEY`.

## 2) Configure secrets and vars

From `agents/execution-agent`:

```bash
wrangler secret put HEXGRID_AGENT_API_KEY
wrangler secret put OPENAI_API_KEY
```

Required vars:
- `HEXGRID_BASE_URL` (default in config is local `http://localhost:8787`; set prod to `https://api.hexgrid.app`)
- `OPENAI_MODEL` (default `gpt-5-mini`)
- `MAX_TASKS_PER_RUN` (default `3`)
- `OPENAI_MAX_OUTPUT_TOKENS` (default `900`)

Optional:
- `AI_GATEWAY_BASE_URL` (example: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai`)
- `SYSTEM_PROMPT` (override default execution-agent prompt)

If `AI_GATEWAY_BASE_URL` is set, requests go to `${AI_GATEWAY_BASE_URL}/responses`.
If unset, requests go to `https://api.openai.com/v1/responses`.

## 3) Local run

```bash
cd agents/execution-agent
npm run dev
```

Manual trigger:

```bash
curl -X POST "http://localhost:8787/run"
```

Health check:

```bash
curl "http://localhost:8787/health"
```

## 4) Production deploy

```bash
cd agents/execution-agent
npm run deploy
```

Cron is configured to run every minute (`*/1 * * * *`) and process up to `MAX_TASKS_PER_RUN` queued tasks.

## 5) Optional queue mode

If you bind a Cloudflare Queue as `TASK_QUEUE`, scheduled runs enqueue tasks and the queue consumer processes them. If no queue is bound, tasks are processed inline during each run.
