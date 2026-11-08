// Meta-only AI client (Phase 4, Step 2). Muse Spark via the Meta Model API
// Chat Completions endpoint. No other provider is referenced here.
//
// Design rules:
// - Structured output via response_format JSON Schema (strict), PLUS
//   independent application-side validation. A schema-conforming but
//   guardrail-violating answer is still rejected.
// - The model reasons ONLY over evidence supplied in the prompt. The schema
//   has no fields for new Tatum/Walrus records, verification claims, or
//   belief revisions, so those outcomes are unrepresentable by construction.
// - Failures never throw to the caller: analyzeResearch always resolves to
//   a result object with a stable aiStatus. Raw error detail goes to
//   server-side logs; HTTP bodies carry only stable codes.
// - The API key is read per call from process.env and never logged, stored,
//   or returned.

export const META_API_BASE_DEFAULT = 'https://api.meta.ai/v1'
export const META_MODEL_DEFAULT = 'muse-spark-1.3'

export const META_AI_ERROR_CODE = 'META_AI_UNAVAILABLE'
export const META_AI_INVALID_CODE = 'META_AI_INVALID'

const REQUEST_TIMEOUT_MS = 30000
const DEFAULT_MAX_ATTEMPTS = 3
const HARD_MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 500
const RETRY_MAX_DELAY_MS = 10000

export class MissingMetaApiKeyError extends Error {
  constructor() {
    super('META_API_KEY is not set for this workspace')
    this.name = 'MissingMetaApiKeyError'
  }
}

export function metaApiBase() {
  return (process.env.META_API_BASE || META_API_BASE_DEFAULT).replace(/\/+$/, '')
}

export function metaModel() {
  return process.env.META_MODEL || META_MODEL_DEFAULT
}

function metaApiKey() {
  const key = process.env.META_API_KEY
  if (!key) throw new MissingMetaApiKeyError()
  return key
}

// Only stable error categories ever reach logs: HTTP status, attempt
// number, and timing. Raw exception messages, response bodies, keys,
// headers, request bodies, model output, and user evidence are never logged.
function classifyThrown(error) {
  const name = error && typeof error.name === 'string' ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  return 'network_error'
}

// Caller-supplied retry/timeout options are strictly validated: only
// actual numbers are accepted — strings, booleans, null, and other types
// are never coerced. Anything invalid falls back to { maxAttempts: 3,
// timeoutMs: 30000 }, and maxAttempts is additionally hard-capped at 3 no
// matter what the caller passes.
export function normalizeMetaOptions(options = {}) {
  let maxAttempts = DEFAULT_MAX_ATTEMPTS
  if (
    typeof options.maxAttempts === 'number' &&
    Number.isInteger(options.maxAttempts) &&
    options.maxAttempts >= 1
  ) {
    maxAttempts = Math.min(options.maxAttempts, HARD_MAX_ATTEMPTS)
  }
  let timeoutMs = REQUEST_TIMEOUT_MS
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

export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value == null) return null
  // HTTP-date form ("Wed, 21 Oct 2015 07:28:00 GMT"): wait until then.
  if (typeof value === 'string' && /[a-zA-Z]/.test(value)) {
    const at = Date.parse(value)
    if (Number.isNaN(at)) return null
    return Math.max(0, Math.min(at - nowMs, RETRY_MAX_DELAY_MS))
  }
  // Numeric form: delay seconds (fractional values accepted).
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(Math.round(seconds * 1000), RETRY_MAX_DELAY_MS)
}

// Only 429 and 5xx are retried. 4xx (including 401 invalid key, 402, 404,
// 413) fail fast: retrying cannot change the outcome.
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

// ---------------------------------------------------------------------------
// Structured output schema + application-side validation
// ---------------------------------------------------------------------------

export const RESEARCH_ANALYSIS_SCHEMA = {
  name: 'recallguard_research_analysis',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      subQuestions: { type: 'array', items: { type: 'string' } },
      interpretation: { type: 'string' },
      contradictions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            claim: { type: 'string' },
            against: { type: 'string' },
            severity: { type: 'string', enum: ['low', 'medium', 'high'] }
          },
          required: ['claim', 'against', 'severity']
        }
      },
      uncertainties: { type: 'array', items: { type: 'string' } },
      evidenceGaps: { type: 'array', items: { type: 'string' } },
      confidenceNote: { type: 'string' }
    },
    required: [
      'subQuestions',
      'interpretation',
      'contradictions',
      'uncertainties',
      'evidenceGaps',
      'confidenceNote'
    ]
  }
}

// Phrases that must never appear as AFFIRMATIVE or AMBIGUOUS claims. The
// schema already makes verification claims and revisions unrepresentable;
// this is the second, independent net in case decoding ever drifts.
//
// Fail-closed by design: a banned phrase is allowed only under a narrow,
// confidently-shaped denial (direct operator attachment, or a be-verb
// denial predicate with no operators in the clause). Anything the templates
// cannot confidently recognize as a denial — affirmations, double negatives
// ("not impossible", "not ... never", "not unverified"), cross-sentence or
// cross-clause flips, novel paraphrases — is rejected and the deterministic
// path is used instead. The deterministic verifier stays the sole authority
// for verification and revision.
//
// Limitations (no semantic understanding is claimed): this is pattern
// matching over word order, not comprehension. Over-strict rejections
// ("should not supersede", multi-clause denials split by commas) discard a
// good analysis rather than risk a bad one; under-recognition is bounded to
// the listed phrases and cannot fabricate evidence or commit revisions.
const BANNED_PHRASES = [
  /cryptograph/i,
  /independently verified/i,
  /\bverified fact\b/i,
  /\bsupersede/i,
  /\bbelief revision\b/i,
  // Bare verification words ("was verified", "verification complete") are
  // triggers too: without this, an affirmation with no other marker would
  // pass vacuously. Denial forms ("unverified") trigger as well and are
  // then allowed only under the predicate-denial template below.
  /\bverifi\w*\b/i,
  /\bunverifi\w*\b/i,
  // Affirmative proof claims, enumerated explicitly with word boundaries:
  // "prove", "proves", "proven", "proved", "proof". A broad "prov" prefix
  // would also match unrelated words ("provide", "provider", "provision").
  // Mid-word forms ("unproven", "disproven") do not trigger here; the
  // denial templates below decide them fail-closed.
  /\b(?:prove|proves|proven|proved|proof)\b/i
]

// Logical operators that can license a directly attached denial. Content
// words like "without", "missing", or "unverified" are deliberately NOT
// operators: they describe evidence state but do not compose, so stacked or
// distant markers ("not impossible", "not ... never", "not true that ...")
// still fail closed instead of passing on a loose negation.
const NEGATION_OPERATORS =
  /\b(not|n't|never|no|neither|nor|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|couldn't|shouldn't|wouldn't)\b/i

// Direct denial: an operator governs the verification predicate within a
// few words ("not cryptographically verified", "cannot be independently
// verified", "no verified fact"). The verifi-word itself must not be a
// denial adjective, closing the "not unverified" loophole.
const DIRECT_DENIAL_TEMPLATE =
  /\b(not|n't|never|no|neither|nor|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|couldn't|shouldn't|wouldn't)\b((?:\s+\w+){0,4}?)\s+(cryptographically\s+|independently\s+)?((?<!un)verifi\w*|(?<!un|dis)(?:prove|proves|proven|proved|proof)|verified\s+fact|proven\s+fact)\b/i

const DIRECT_DENIAL_ADJECTIVES = new Set(['unverified', 'unproven', 'unconfirmed', 'disproven'])

// Post-posed denial: the claim word is the subject of a be-verb denial
// adjective ("proof is missing", "verification is unverified"). Valid only
// with no operators in the clause, so "not true that proof is missing"
// still fails closed.
const PREDICATE_DENIAL_TEMPLATE =
  /\b(cryptograph\w*|proof|evidence|verifi\w*)\b.{0,40}?\b(is|are|was|were|be|been|being|remains?|stays?)\s+(unverified|unproven|unconfirmed|missing|absent)\b/i

function countOperators(sentence) {
  const matches = sentence.match(new RegExp(NEGATION_OPERATORS.source, 'gi'))
  return matches ? matches.length : 0
}

function directDenial(sentence) {
  const match = sentence.match(DIRECT_DENIAL_TEMPLATE)
  if (!match) return false
  const word = (match[4] || '').toLowerCase().split(/\s+/).pop()
  if (DIRECT_DENIAL_ADJECTIVES.has(word)) return false
  return countOperators(sentence) === 1
}

function predicateDenial(sentence) {
  if (countOperators(sentence) !== 0) return false
  return PREDICATE_DENIAL_TEMPLATE.test(sentence)
}

// Post-posed denial: the claim word is directly negated by a trailing
// "nothing" or "none" ("proves nothing"). Valid only with no operators in
// the clause, so a flipped clause still fails closed.
const POST_NEGATION_TEMPLATE =
  /\b((?<!un)verifi\w*|(?<!un|dis)(?:prove|proves|proven|proved|proof)|verified\s+fact|proven\s+fact)\b\s+(nothing|none)\b/i

function postDenial(sentence) {
  if (countOperators(sentence) !== 0) return false
  return POST_NEGATION_TEMPLATE.test(sentence)
}

// A sentence containing a banned phrase is clear only under one of the
// three narrow denial templates above. Anything else — affirmations,
// double negatives ("not impossible", "not ... never"), cross-clause
// flips, novel paraphrases — is a violation. This heuristic performs no
// semantic understanding; it fails closed by construction.
function sentenceViolation(sentence) {
  const triggered = BANNED_PHRASES.some((pattern) => pattern.test(sentence))
  if (!triggered) return null
  if (directDenial(sentence) || predicateDenial(sentence) || postDenial(sentence)) return null
  return 'affirmative or ambiguous verification/revision claim'
}

// Returns the offending field name and a stable reason (both from our own
// code), or null. Never returns model text.
function findGuardrailViolation(fields) {
  for (const [field, value] of fields) {
    if (typeof value !== 'string') continue
    const sentences = value.split(/[.!?;\n,]+/)
    for (const sentence of sentences) {
      const hit = sentenceViolation(sentence)
      if (hit) return { field, pattern: hit }
    }
  }
  return null
}

const ANALYSIS_FIELDS = [
  'subQuestions',
  'interpretation',
  'contradictions',
  'uncertainties',
  'evidenceGaps',
  'confidenceNote'
]

const CONTRADICTION_FIELDS = ['claim', 'against', 'severity']

// Independent of Meta's server-side schema enforcement: every required
// field, every array element type, and every contradiction object is checked
// here, so a conforming-but-hostile payload still fails closed.
export function validateAnalysis(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['analysis must be a JSON object'] }
  }
  const errors = []
  for (const key of ANALYSIS_FIELDS) {
    if (!(key in data)) errors.push(`missing field: ${key}`)
  }
  const extraTop = Object.keys(data).filter((key) => !ANALYSIS_FIELDS.includes(key))
  if (extraTop.length > 0) {
    errors.push(`unexpected top-level properties: ${extraTop.sort().join(',')}`)
  }
  if (!Array.isArray(data.subQuestions)) {
    errors.push('subQuestions must be an array')
  } else if (!data.subQuestions.every((item) => typeof item === 'string')) {
    errors.push('subQuestions must be an array of strings')
  }
  if (typeof data.interpretation !== 'string') errors.push('interpretation must be a string')
  if (!Array.isArray(data.contradictions)) {
    errors.push('contradictions must be an array')
  } else {
    for (const [index, item] of data.contradictions.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`contradictions[${index}] must be an object`)
        continue
      }
      const extra = Object.keys(item).filter((key) => !CONTRADICTION_FIELDS.includes(key))
      if (extra.length > 0) {
        errors.push(`contradictions[${index}] has unexpected properties: ${extra.sort().join(',')}`)
      }
      if (typeof item.claim !== 'string') errors.push(`contradictions[${index}].claim must be a string`)
      if (typeof item.against !== 'string') errors.push(`contradictions[${index}].against must be a string`)
      if (!['low', 'medium', 'high'].includes(item.severity)) {
        errors.push(`contradictions[${index}].severity must be low, medium, or high`)
      }
    }
  }
  if (!Array.isArray(data.uncertainties)) {
    errors.push('uncertainties must be an array')
  } else if (!data.uncertainties.every((item) => typeof item === 'string')) {
    errors.push('uncertainties must be an array of strings')
  }
  if (!Array.isArray(data.evidenceGaps)) {
    errors.push('evidenceGaps must be an array')
  } else if (!data.evidenceGaps.every((item) => typeof item === 'string')) {
    errors.push('evidenceGaps must be an array of strings')
  }
  if (typeof data.confidenceNote !== 'string') errors.push('confidenceNote must be a string')

  if (errors.length === 0) {
    const fields = [
      ['interpretation', data.interpretation],
      ['confidenceNote', data.confidenceNote],
      ...data.subQuestions.map((text, index) => [`subQuestions[${index}]`, text]),
      ...data.contradictions.flatMap((item, index) => [
        [`contradictions[${index}].claim`, item.claim],
        [`contradictions[${index}].against`, item.against]
      ]),
      ...data.uncertainties.map((text, index) => [`uncertainties[${index}]`, text]),
      ...data.evidenceGaps.map((text, index) => [`evidenceGaps[${index}]`, text])
    ]
    const violation = findGuardrailViolation(fields)
    if (violation) {
      errors.push(`guardrail violation in ${violation.field}`)
    }
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors }
}

// Strip anything a model could have supplied from validation errors before
// they reach logs or audit records. Every message above uses our own field
// paths and rule names except the unexpected-properties messages, which
// echo model-chosen key names — those are reduced to a category and count.
// Unknown shapes fail closed to a fixed message rather than passing through.
export function sanitizeValidationErrors(errors) {
  if (!Array.isArray(errors)) return []
  return errors.map((message) => {
    if (typeof message !== 'string') return 'validation failed (detail withheld)'
    const unexpectedTop = message.match(/^unexpected top-level properties: (.*)$/)
    if (unexpectedTop) {
      const count = unexpectedTop[1].split(',').filter((name) => name.length > 0).length
      return `unexpected top-level properties (${count} names withheld)`
    }
    const unexpectedNested = message.match(/^(contradictions\[\d+\] has unexpected properties): (.*)$/)
    if (unexpectedNested) {
      const count = unexpectedNested[2].split(',').filter((name) => name.length > 0).length
      return `${unexpectedNested[1]} (${count} names withheld)`
    }
    return message
  })
}

// ---------------------------------------------------------------------------
// Prompt construction (Meta-only; evidence passed in, never invented)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are RecallGuard, a research assistant analyzing blockchain evidence.',
  'Rules you must follow:',
  '1. Reason ONLY over the evidence provided in the user message. Never invent Tatum records, Walrus blobs, checkpoints, digests, or any other evidence.',
  '2. Never claim anything is cryptographically verified, proven, or independently verified. Retrieval is not verification.',
  '3. Never direct belief revisions, memory supersession, or epistemic commitments. Surface contradictions and uncertainties; the deterministic verifier decides.',
  '4. State what is uncertain and what evidence is missing.',
  '5. Respond with JSON matching the requested schema and nothing else.'
].join('\n')

export function buildAnalysisMessages({ question, capability, onChainSuiData, recalledMemories, evidenceComparison }) {
  const evidence = {
    question,
    capability,
    onChainSuiData: onChainSuiData ?? null,
    recalledMemories: (recalledMemories ?? []).map((memory) => ({
      id: memory.id,
      title: memory.title,
      provenance: memory.provenance
    })),
    evidenceComparison: evidenceComparison ?? null
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Analyze this research session. Evidence follows as JSON:\n${JSON.stringify(evidence)}`
    }
  ]
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export async function analyzeResearch(input = {}, options = {}) {
  const { maxAttempts, timeoutMs } = normalizeMetaOptions(options)
  const {
    fetchFn = fetch,
    baseUrl = metaApiBase(),
    model = metaModel()
  } = options

  let key
  try {
    key = metaApiKey()
  } catch {
    return { ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null, ran: false }
  }

  const body = JSON.stringify({
    model,
    messages: buildAnalysisMessages(input),
    response_format: { type: 'json_schema', json_schema: RESEARCH_ANALYSIS_SCHEMA },
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
        // Response bodies are never read or logged: 404s may even be empty,
        // and bodies could echo request material. Status alone decides.
        if (status === 401) {
          console.error('[recallguard] Meta AI authentication failed (status=401)')
          return { ok: false, aiStatus: 'invalid', errorCode: META_AI_INVALID_CODE, analysis: null }
        }
        if (!isRetryableStatus(status)) {
          console.error(`[recallguard] Meta AI request rejected (status=${status}, attempt=${attempt})`)
          return { ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null }
        }
        lastCategory = `http_${status}`
        if (attempt < maxAttempts) {
          const retryAfter = typeof response.headers?.get === 'function'
            ? parseRetryAfterMs(response.headers.get('retry-after'))
            : null
          await sleep(retryDelayMs(attempt - 1, retryAfter))
          continue
        }
        console.error(`[recallguard] Meta AI request failed (category=${lastCategory}, attempts=${attempt})`)
        return { ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null }
      }

      let payload
      try {
        payload = await response.json()
      } catch {
        console.error(`[recallguard] Meta AI returned malformed envelope (attempt=${attempt})`)
        return { ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null }
      }

      const content = payload?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content) {
        console.error(`[recallguard] Meta AI returned no message content (attempt=${attempt})`)
        return { ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null }
      }

      let data
      try {
        data = JSON.parse(content)
      } catch {
        console.error(`[recallguard] Meta AI returned invalid content (attempt=${attempt})`)
        return { ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null }
      }

      const validation = validateAnalysis(data)
      if (!validation.valid) {
        // Sanitized diagnostics only: field paths and rule names are our
        // own vocabulary, but model-supplied property names are withheld.
        const validationErrors = sanitizeValidationErrors(validation.errors)
        console.error(`[recallguard] Meta AI output failed validation (${validationErrors.length} problems): ${validationErrors.join('; ')}`)
        return { ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null, validationErrors }
      }

      const latencyMs = Date.now() - started
      console.error(`[recallguard] Meta AI analysis completed (attempt=${attempt}, latencyMs=${latencyMs})`)
      return {
        ok: true,
        aiStatus: 'completed',
        errorCode: null,
        analysis: { ...data, model, provider: 'meta' },
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
      console.error(`[recallguard] Meta AI request failed (category=${lastCategory}, attempts=${attempt})`)
      return { ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null }
    }
  }
  console.error(`[recallguard] Meta AI request failed (category=${lastCategory}, attempts=${attempt})`)
  return { ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null }
}
