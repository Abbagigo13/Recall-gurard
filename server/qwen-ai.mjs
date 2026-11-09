// Qwen primary AI client (Phase 7). Alibaba Cloud Model Studio (DashScope)
// via the OpenAI-compatible Chat Completions interface. Meta Muse Spark
// stays as the fallback provider (see server/meta-ai.mjs and
// server/ai-provider.mjs).
//
// Design rules (mirrors the Meta client conventions):
// - Structured output via response_format, PLUS independent
//   application-side validation with the SAME schema and guardrails
//   (imported from server/meta-ai.mjs). No weaker second validator.
// - Default response_format is json_object: per the official Model Studio
//   structured-output documentation, strict JSON Schema mode is supported
//   only on selected qwen-plus models, while JSON Object mode is supported
//   by most Qwen models including the Qwen3.8-Flash series. Strict schema
//   is available explicitly via QWEN_RESPONSE_FORMAT=json_schema for models
//   that support it. Free-form text is never accepted silently: without a
//   response_format the request is not sent.
// - The model reasons ONLY over evidence supplied in the prompt. The shared
//   schema has no fields for new Tatum/Walrus records, verification claims,
//   or belief revisions, so those outcomes are unrepresentable.
// - Failures never throw to the caller: analyzeWithQwen always resolves to
//   a result object with a stable aiStatus. Raw error detail goes to
//   server-side logs; HTTP bodies carry only stable codes.
// - The API key is read per call from process.env and never logged, stored,
//   or returned. No default API base URL is provided: Model Studio
//   endpoints are region/workspace specific (e.g. the international
//   compatible-mode endpoint vs workspace-scoped Beijing endpoints), so a
//   missing QWEN_API_BASE resolves to a safe not_configured result instead
//   of guessing a region.
// - Same normalized result contract as the Meta client:
//   { ok, aiStatus, errorCode, analysis, latencyMs?, validationErrors? }.

import {
  RESEARCH_ANALYSIS_SCHEMA,
  validateAnalysis,
  sanitizeValidationErrors,
  buildAnalysisMessages
} from './meta-ai.mjs'

export const QWEN_MODEL_DEFAULT = 'qwen3.8-flash'

export const QWEN_AI_ERROR_CODE = 'QWEN_AI_UNAVAILABLE'
export const QWEN_AI_INVALID_CODE = 'QWEN_AI_INVALID'

// Stable Qwen statuses: not_configured | configured | available |
// unavailable | invalid | timeout. Only unavailable/invalid/timeout ever
// leave this module as aiStatus values; the rest describe configuration.
const REQUEST_TIMEOUT_MS = 30000
const DEFAULT_MAX_ATTEMPTS = 3
const HARD_MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 500
const RETRY_MAX_DELAY_MS = 10000

export class MissingQwenApiKeyError extends Error {
  constructor() {
    super('DASHSCOPE_API_KEY is not set for this workspace')
    this.name = 'MissingQwenApiKeyError'
  }
}

export class MissingQwenApiBaseError extends Error {
  constructor() {
    super('QWEN_API_BASE is not set for this workspace')
    this.name = 'MissingQwenApiBaseError'
  }
}

// No universal default: region/workspace endpoints differ, so callers must
// configure QWEN_API_BASE explicitly. Returns null when unconfigured.
export function qwenApiBase() {
  const raw = process.env.QWEN_API_BASE
  if (typeof raw !== 'string' || raw.length === 0) return null
  return raw.replace(/\/+$/, '')
}

export function qwenModel() {
  return process.env.QWEN_MODEL || QWEN_MODEL_DEFAULT
}

export function qwenTimeoutMs() {
  const raw = process.env.QWEN_TIMEOUT_MS
  const parsed = Number(raw)
  if (typeof raw === 'string' && raw.length > 0 && Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  return REQUEST_TIMEOUT_MS
}

// Explicit opt-in only: 'json_schema' for qwen-plus models with strict
// schema support, anything else (including unset) means 'json_object'.
// Never resolves to free-form text.
export function qwenResponseFormat() {
  return process.env.QWEN_RESPONSE_FORMAT === 'json_schema' ? 'json_schema' : 'json_object'
}

function qwenApiKey() {
  const key = process.env.DASHSCOPE_API_KEY
  if (!key) throw new MissingQwenApiKeyError()
  return key
}

export function qwenConfigured() {
  return Boolean(process.env.DASHSCOPE_API_KEY) && qwenApiBase() !== null
}

// Safe status for config badges: never a network call, never a secret.
export function qwenStatus() {
  const hasKey = Boolean(process.env.DASHSCOPE_API_KEY)
  if (!hasKey || qwenApiBase() === null) return 'not_configured'
  return 'configured'
}

// Only stable error categories ever reach logs: HTTP status, attempt
// number, and timing. Raw exception messages, response bodies, keys,
// headers, request bodies, model output, and user evidence are never logged.
function classifyThrown(error) {
  const name = error && typeof error.name === 'string' ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  return 'network_error'
}

// Same option conventions as the Meta client: only actual numbers are
// accepted, anything invalid falls back to { maxAttempts: 3,
// timeoutMs: <QWEN_TIMEOUT_MS or 30000> }, maxAttempts hard-capped at 3.
export function normalizeQwenOptions(options = {}) {
  let maxAttempts = DEFAULT_MAX_ATTEMPTS
  if (
    typeof options.maxAttempts === 'number' &&
    Number.isInteger(options.maxAttempts) &&
    options.maxAttempts >= 1
  ) {
    maxAttempts = Math.min(options.maxAttempts, HARD_MAX_ATTEMPTS)
  }
  let timeoutMs = qwenTimeoutMs()
  if (
    typeof options.timeoutMs === 'number' &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
  ) {
    timeoutMs = options.timeoutMs
  }
  return { maxAttempts, timeoutMs }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelayMs(attempt, retryAfterMs) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, RETRY_MAX_DELAY_MS)
  }
  const backoff = RETRY_BASE_DELAY_MS * 2 ** attempt
  const jitter = Math.floor(Math.random() * 250)
  return Math.min(backoff + jitter, RETRY_MAX_DELAY_MS)
}

export function parseQwenRetryAfterMs(value, nowMs = Date.now()) {
  if (value == null) return null
  if (typeof value === 'string' && /[a-zA-Z]/.test(value)) {
    const at = Date.parse(value)
    if (Number.isNaN(at)) return null
    return Math.max(0, Math.min(at - nowMs, RETRY_MAX_DELAY_MS))
  }
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(Math.round(seconds * 1000), RETRY_MAX_DELAY_MS)
}

// Only 429 and 5xx are retried. Other 4xx (including 401 invalid key, 404,
// 413) fail fast: retrying cannot change the outcome. A 400 caused by an
// unsupported response_format on the configured model also fails fast and
// lets the Meta fallback take over explicitly.
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

function buildResponseFormat() {
  if (qwenResponseFormat() === 'json_schema') {
    return { type: 'json_schema', json_schema: RESEARCH_ANALYSIS_SCHEMA }
  }
  return { type: 'json_object' }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export async function analyzeWithQwen(input = {}, options = {}) {
  const { maxAttempts, timeoutMs } = normalizeQwenOptions(options)
  const {
    fetchFn = fetch,
    baseUrl = qwenApiBase(),
    model = qwenModel()
  } = options

  let key
  try {
    key = qwenApiKey()
  } catch {
    return { ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null, ran: false }
  }
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    return { ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null, ran: false }
  }

  const body = JSON.stringify({
    model,
    messages: buildAnalysisMessages(input),
    response_format: buildResponseFormat(),
    temperature: 0
  })

  let attempt = 0
  let lastCategory = 'unknown'
  while (attempt < maxAttempts) {
    attempt += 1
    const started = Date.now()
    try {
      const response = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      })

      if (!response.ok) {
        const status = response.status
        // Response bodies are never read or logged: bodies could echo
        // request material. Status alone decides.
        if (status === 401) {
          console.error('[recallguard] Qwen AI authentication failed (status=401)')
          return { ok: false, aiStatus: 'invalid', errorCode: QWEN_AI_INVALID_CODE, analysis: null }
        }
        if (!isRetryableStatus(status)) {
          console.error(`[recallguard] Qwen AI request rejected (status=${status}, attempt=${attempt})`)
          return { ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null }
        }
        lastCategory = `http_${status}`
        if (attempt < maxAttempts) {
          const retryAfter = typeof response.headers?.get === 'function'
            ? parseQwenRetryAfterMs(response.headers.get('retry-after'))
            : null
          await sleep(retryDelayMs(attempt - 1, retryAfter))
          continue
        }
        console.error(`[recallguard] Qwen AI request failed (category=${lastCategory}, attempts=${attempt})`)
        return { ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null }
      }

      let payload
      try {
        payload = await response.json()
      } catch {
        console.error(`[recallguard] Qwen AI returned malformed envelope (attempt=${attempt})`)
        return { ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null }
      }

      const content = payload?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content) {
        console.error(`[recallguard] Qwen AI returned no message content (attempt=${attempt})`)
        return { ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null }
      }

      let data
      try {
        data = JSON.parse(content)
      } catch {
        console.error(`[recallguard] Qwen AI returned invalid content (attempt=${attempt})`)
        return { ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null }
      }

      // Same schema and guardrails as Meta: a schema-conforming but
      // guardrail-violating answer is still rejected.
      const validation = validateAnalysis(data)
      if (!validation.valid) {
        const validationErrors = sanitizeValidationErrors(validation.errors)
        console.error(`[recallguard] Qwen AI output failed validation (${validationErrors.length} problems): ${validationErrors.join('; ')}`)
        return { ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null, validationErrors }
      }

      const latencyMs = Date.now() - started
      console.error(`[recallguard] Qwen AI analysis completed (attempt=${attempt}, latencyMs=${latencyMs})`)
      return {
        ok: true,
        aiStatus: 'completed',
        errorCode: null,
        analysis: { ...data, model, provider: 'qwen' },
        latencyMs
      }
    } catch (error) {
      // Network errors and timeouts are retried; anything else fails closed.
      // Only the stable category is logged, never the exception message.
      lastCategory = classifyThrown(error)
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs(attempt - 1, null))
        continue
      }
      console.error(`[recallguard] Qwen AI request failed (category=${lastCategory}, attempts=${attempt})`)
      if (lastCategory === 'timeout') {
        return { ok: false, aiStatus: 'timeout', errorCode: QWEN_AI_ERROR_CODE, analysis: null }
      }
      return { ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null }
    }
  }
  console.error(`[recallguard] Qwen AI request failed (category=${lastCategory}, attempts=${attempt})`)
  return { ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null }
}
