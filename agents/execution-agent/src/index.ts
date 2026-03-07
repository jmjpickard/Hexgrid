interface Env {
  HEXGRID_BASE_URL?: string
  HEXGRID_AGENT_API_KEY?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  OPENAI_MAX_OUTPUT_TOKENS?: string
  MAX_TASKS_PER_RUN?: string
  AI_GATEWAY_BASE_URL?: string
  SYSTEM_PROMPT?: string
  TASK_QUEUE?: Queue<TaskMessage>
}

interface InboxTask {
  task_id: string
  from_hex: string
  description: string
  credits_escrowed: number
  created_at: number
}

interface PollTasksResult {
  tasks: InboxTask[]
  total: number
}

interface TaskMessage {
  task_id: string
  from_hex: string
  description: string
  credits_escrowed: number
  created_at: number
}

interface RunReport {
  status: 'ok' | 'error'
  source: 'manual' | 'scheduled' | 'queue'
  polled: number
  queued: number
  completed: number
  skipped: number
  failures: Array<{ task_id: string; error: string }>
}

const DEFAULT_HEXGRID_BASE_URL = 'https://api.hexgrid.app'
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-5-mini'
const DEFAULT_MAX_TASKS_PER_RUN = 3
const DEFAULT_MAX_OUTPUT_TOKENS = 900
const MAX_RESULT_SUMMARY_CHARS = 4900

const DEFAULT_SYSTEM_PROMPT = [
  'You are Execution Engineer on HexGrid.',
  'Return practical, production-ready output.',
  'Be concise and explicit about assumptions, validation steps, and risks.',
  'Never include markdown fences.',
  'Output must fit in a short task result summary.',
].join(' ')

class HttpRequestError extends Error {
  status: number
  responseBody: string

  constructor(status: number, responseBody: string) {
    super(`HTTP ${status}: ${responseBody}`)
    this.status = status
    this.responseBody = responseBody
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

function nowIso(): string {
  return new Date().toISOString()
}

function normaliseBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  const integer = Math.floor(parsed)
  if (integer < min) return min
  if (integer > max) return max
  return integer
}

function ensureEnv(name: keyof Env, value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`Missing required env var: ${name}`)
  return trimmed
}

function asErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function truncateSummary(text: string): string {
  if (text.length <= MAX_RESULT_SUMMARY_CHARS) return text
  return `${text.slice(0, MAX_RESULT_SUMMARY_CHARS - 48)}\n\n[truncated by execution agent due to length]`
}

function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload ?? '')

  const maybeDirect = (payload as { output_text?: unknown }).output_text
  if (typeof maybeDirect === 'string' && maybeDirect.trim().length > 0) {
    return maybeDirect.trim()
  }

  const maybeOutput = (payload as { output?: unknown }).output
  if (!Array.isArray(maybeOutput)) return JSON.stringify(payload)

  const chunks: string[] = []
  for (const outputItem of maybeOutput) {
    if (!outputItem || typeof outputItem !== 'object') continue
    const content = (outputItem as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.trim().length > 0) {
        chunks.push(text.trim())
      }
    }
  }

  if (chunks.length > 0) return chunks.join('\n\n')
  return JSON.stringify(payload)
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.text()
    throw new HttpRequestError(response.status, body)
  }
  return response.json() as Promise<T>
}

function buildHexgridHeaders(env: Env): HeadersInit {
  const apiKey = ensureEnv('HEXGRID_AGENT_API_KEY', env.HEXGRID_AGENT_API_KEY)
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

function buildHexgridBaseUrl(env: Env): string {
  return normaliseBaseUrl(env.HEXGRID_BASE_URL?.trim() || DEFAULT_HEXGRID_BASE_URL)
}

async function pollInbox(env: Env, limit: number): Promise<InboxTask[]> {
  const baseUrl = buildHexgridBaseUrl(env)
  const headers = buildHexgridHeaders(env)
  const result = await requestJson<PollTasksResult>(
    `${baseUrl}/api/agent/tasks/inbox?limit=${limit}`,
    { method: 'GET', headers },
  )
  return result.tasks
}

async function claimTask(env: Env, taskId: string): Promise<void> {
  const baseUrl = buildHexgridBaseUrl(env)
  const headers = buildHexgridHeaders(env)
  await requestJson(
    `${baseUrl}/api/agent/tasks/claim`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ task_id: taskId }),
    },
  )
}

async function completeTask(env: Env, taskId: string, resultSummary: string): Promise<void> {
  const baseUrl = buildHexgridBaseUrl(env)
  const headers = buildHexgridHeaders(env)
  await requestJson(
    `${baseUrl}/api/agent/tasks/complete`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        task_id: taskId,
        result_summary: truncateSummary(resultSummary),
      }),
    },
  )
}

function buildUserPrompt(task: InboxTask): string {
  return [
    'Solve the task below and return only the result body.',
    'Keep it practical and implementation-oriented.',
    '',
    `Task ID: ${task.task_id}`,
    `Requester: ${task.from_hex}`,
    `Escrowed credits: ${task.credits_escrowed}`,
    '',
    'Task description:',
    task.description,
    '',
    'Response format:',
    '- Outcome',
    '- Plan',
    '- Implementation details',
    '- Verification steps',
    '- Risks or unknowns',
  ].join('\n')
}

async function runInference(task: InboxTask, env: Env): Promise<string> {
  const openAiApiKey = ensureEnv('OPENAI_API_KEY', env.OPENAI_API_KEY)
  const openAiBaseUrl = normaliseBaseUrl(env.AI_GATEWAY_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL)
  const model = env.OPENAI_MODEL?.trim() || DEFAULT_MODEL
  const maxOutputTokens = boundedInt(env.OPENAI_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, 256, 4000)
  const systemPrompt = env.SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT

  const payload = await requestJson<unknown>(`${openAiBaseUrl}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model,
      max_output_tokens: maxOutputTokens,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: systemPrompt }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: buildUserPrompt(task) }],
        },
      ],
    }),
  })

  const body = extractResponseText(payload).trim()
  return truncateSummary(
    [
      `Execution Agent Result`,
      `Task ID: ${task.task_id}`,
      `Generated: ${nowIso()}`,
      `Model: ${model}`,
      '',
      body.length > 0 ? body : 'No model output returned.',
    ].join('\n'),
  )
}

function buildFailureSummary(task: InboxTask, err: unknown): string {
  return truncateSummary(
    [
      'Execution Agent Result',
      `Task ID: ${task.task_id}`,
      `Generated: ${nowIso()}`,
      '',
      'Outcome: Failed to produce a full result.',
      `Error: ${asErrorMessage(err)}`,
      '',
      'Suggested follow-up:',
      '- Retry task after checking model/network configuration.',
      '- If repeated, route to human review.',
    ].join('\n'),
  )
}

async function processTask(task: InboxTask, env: Env): Promise<'completed' | 'skipped'> {
  try {
    await claimTask(env, task.task_id)
  } catch (err) {
    if (err instanceof HttpRequestError && (err.status === 400 || err.status === 404 || err.status === 409)) {
      console.log(`Skipping task ${task.task_id} (claim rejected): ${err.responseBody}`)
      return 'skipped'
    }
    throw err
  }

  let resultSummary: string
  try {
    resultSummary = await runInference(task, env)
  } catch (err) {
    console.error(`Inference failed for task ${task.task_id}:`, asErrorMessage(err))
    resultSummary = buildFailureSummary(task, err)
  }

  await completeTask(env, task.task_id, resultSummary)
  return 'completed'
}

async function runCycle(
  env: Env,
  source: RunReport['source'],
  overrideLimit?: number,
): Promise<RunReport> {
  const limit = overrideLimit
    ? boundedInt(String(overrideLimit), DEFAULT_MAX_TASKS_PER_RUN, 1, 25)
    : boundedInt(env.MAX_TASKS_PER_RUN, DEFAULT_MAX_TASKS_PER_RUN, 1, 25)

  const report: RunReport = {
    status: 'ok',
    source,
    polled: 0,
    queued: 0,
    completed: 0,
    skipped: 0,
    failures: [],
  }

  const tasks = await pollInbox(env, limit)
  report.polled = tasks.length

  if (tasks.length === 0) return report

  if (env.TASK_QUEUE) {
    for (const task of tasks) {
      await env.TASK_QUEUE.send(task)
    }
    report.queued = tasks.length
    return report
  }

  for (const task of tasks) {
    try {
      const outcome = await processTask(task, env)
      if (outcome === 'completed') report.completed += 1
      if (outcome === 'skipped') report.skipped += 1
    } catch (err) {
      report.status = 'error'
      report.failures.push({ task_id: task.task_id, error: asErrorMessage(err) })
      console.error(`Task ${task.task_id} failed:`, asErrorMessage(err))
    }
  }

  return report
}

function readLimitOverrideFromUrl(url: URL): number | undefined {
  const raw = url.searchParams.get('limit')
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return undefined
  return parsed
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({
        status: 'ok',
        service: 'hexgrid-execution-agent',
        timestamp: nowIso(),
      })
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      try {
        const limitOverride = readLimitOverrideFromUrl(url)
        const report = await runCycle(env, 'manual', limitOverride)
        return jsonResponse(report)
      } catch (err) {
        return jsonResponse({ error: asErrorMessage(err) }, 500)
      }
    }

    return jsonResponse(
      { error: 'Not found', hint: 'Use GET /health or POST /run' },
      404,
    )
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCycle(env, 'scheduled')
        .then(report => console.log('Scheduled run report:', JSON.stringify(report)))
        .catch(err => console.error('Scheduled run failed:', asErrorMessage(err))),
    )
  },

  async queue(batch: MessageBatch<TaskMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const task = message.body
      try {
        const outcome = await processTask(task, env)
        if (outcome === 'completed') {
          console.log(`Queue completed task ${task.task_id}`)
        } else {
          console.log(`Queue skipped task ${task.task_id}`)
        }
        message.ack()
      } catch (err) {
        console.error(`Queue processing failed for task ${task.task_id}:`, asErrorMessage(err))
        message.retry()
      }
    }
  },
}
