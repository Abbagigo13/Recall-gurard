// Qwen AI client tests. All network I/O is mocked via fetchFn; no real
// Alibaba traffic leaves the process and no credential is used.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeWithQwen,
  normalizeQwenOptions,
  parseQwenRetryAfterMs,
  qwenApiBase,
  qwenModel,
  qwenStatus,
  qwenConfigured,
  qwenResponseFormat,
  QWEN_AI_ERROR_CODE,
  QWEN_AI_INVALID_CODE,
  QWEN_MODEL_DEFAULT
} from './qwen-ai.mjs'

const TEST_KEY = 'test-qwen-key-0123456789abcdef'
const TEST_BASE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'

const savedEnv = {}
before(() => {
  for (const key of ['DASHSCOPE_API_KEY', 'QWEN_API_BASE', 'QWEN_MODEL', 'QWEN_TIMEOUT_MS', 'QWEN_RESPONSE_FORMAT']) {
    savedEnv[key] = process.env[key]
  }
  process.env.DASHSCOPE_API_KEY = TEST_KEY
  process.env.QWEN_API_BASE = TEST_BASE
  delete process.env.QWEN_MODEL
  delete process.env.QWEN_TIMEOUT_MS
  delete process.env.QWEN_RESPONSE_FORMAT
})

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function validAnalysis() {
  return {
    subQuestions: ['What checkpoint is latest?'],
    interpretation: 'The checkpoint advanced from 100 to 105.',
    contradictions: [{ claim: 'a', against: 'b', severity: 'low' }],
    uncertainties: ['Whether 105 is final.'],
    evidenceGaps: ['No object metadata was retrieved.'],
    confidenceNote: 'Moderate; based only on the supplied checkpoint metadata.'
  }
}

function chatResponse({ body, status = 200, headers = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (typeof body === 'string') throw new Error('not json')
      return body
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  }
}

function completionResponse(analysis) {
  return chatResponse({
    body: { choices: [{ message: { content: JSON.stringify(analysis) } }] }
  })
}

function mockFetch(queue) {
  const calls = []
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init })
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  }
  return { fetchFn, calls }
}

const noRetry = { maxAttempts: 1 }

// Capture console.error output without printing it, restoring afterwards.
async function capturedErrors(fn) {
  const lines = []
  const original = console.error
  console.error = (...args) => { lines.push(args.join(' ')) }
  try {
    return { value: await fn(), lines }
  } finally {
    console.error = original
  }
}

describe('qwen-ai client', () => {
  it('1. missing API key returns not-run unavailable without any fetch', async () => {
    delete process.env.DASHSCOPE_API_KEY
    try {
      const { fetchFn, calls } = mockFetch([completionResponse(validAnalysis())])
      const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, ...noRetry })
      assert.equal(result.ok, false)
      assert.equal(result.aiStatus, 'unavailable')
      assert.equal(result.errorCode, QWEN_AI_ERROR_CODE)
      assert.equal(result.ran, false)
      assert.equal(calls.length, 0)
    } finally {
      process.env.DASHSCOPE_API_KEY = TEST_KEY
    }
  })

  it('2. missing API base URL returns not-run unavailable without any fetch', async () => {
    delete process.env.QWEN_API_BASE
    try {
      const { fetchFn, calls } = mockFetch([completionResponse(validAnalysis())])
      const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, ...noRetry })
      assert.equal(result.ok, false)
      assert.equal(result.aiStatus, 'unavailable')
      assert.equal(result.ran, false)
      assert.equal(calls.length, 0)
      assert.equal(qwenConfigured(), false)
      assert.equal(qwenStatus(), 'not_configured')
    } finally {
      process.env.QWEN_API_BASE = TEST_BASE
    }
  })

  it('3. successful structured JSON response uses Bearer auth and json_object format', async () => {
    const { fetchFn, calls } = mockFetch([completionResponse(validAnalysis())])
    const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, ...noRetry })
    assert.equal(result.ok, true)
    assert.equal(result.aiStatus, 'completed')
    assert.equal(result.analysis.provider, 'qwen')
    assert.equal(result.analysis.model, QWEN_MODEL_DEFAULT)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${TEST_BASE}/chat/completions`)
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TEST_KEY}`)
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.response_format.type, 'json_object')
    assert.equal(body.temperature, 0)
    // json_object mode requires the word JSON in the prompt.
    const joined = body.messages.map((m) => m.content).join('\n')
    assert.match(joined, /json/i)
  })

  it('4. invalid JSON model content fails closed', async () => {
    const { fetchFn } = mockFetch([chatResponse({
      body: { choices: [{ message: { content: 'not json {{{' } }] }
    })])
    const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, ...noRetry })
    assert.equal(result.ok, false)
    assert.equal(result.aiStatus, 'unavailable')
    assert.equal(result.analysis, null)
  })

  it('5. schema-invalid response fails closed with sanitized diagnostics', async () => {
    const bad = { ...validAnalysis(), extraAuthority: 'we verify everything' }
    delete bad.confidenceNote
    const { fetchFn } = mockFetch([completionResponse(bad)])
    const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, ...noRetry })
    assert.equal(result.ok, false)
    assert.equal(result.aiStatus, 'unavailable')
    assert.ok(Array.isArray(result.validationErrors))
    assert.ok(result.validationErrors.length > 0)
    // Model-chosen key names are withheld, never echoed.
    for (const message of result.validationErrors) {
      assert.doesNotMatch(message, /extraAuthority/)
    }
  })

  it('6. HTTP 401 fails fast as invalid without retry', async () => {
    const { fetchFn, calls } = mockFetch([
      chatResponse({ status: 401, body: {} }),
      completionResponse(validAnalysis())
    ])
    const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, maxAttempts: 3 })
    assert.equal(result.ok, false)
    assert.equal(result.aiStatus, 'invalid')
    assert.equal(result.errorCode, QWEN_AI_INVALID_CODE)
    assert.equal(calls.length, 1)
  })

  it('7. HTTP 429 is retried and then succeeds', async () => {
    const { fetchFn, calls } = mockFetch([
      chatResponse({ status: 429, body: {} }),
      completionResponse(validAnalysis())
    ])
    const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, maxAttempts: 3 })
    assert.equal(result.ok, true)
    assert.equal(result.aiStatus, 'completed')
    assert.equal(calls.length, 2)
  })

  it('8. HTTP 500 exhausts retries and reports unavailable', async () => {
    const { fetchFn, calls } = mockFetch([
      chatResponse({ status: 500, body: {} }),
      chatResponse({ status: 500, body: {} }),
      chatResponse({ status: 500, body: {} })
    ])
    const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, maxAttempts: 3 })
    assert.equal(result.ok, false)
    assert.equal(result.aiStatus, 'unavailable')
    assert.equal(result.errorCode, QWEN_AI_ERROR_CODE)
    assert.equal(calls.length, 3)
  })

  it('9. network failure retries then reports unavailable', async () => {
    const failure = new Error('socket hang up')
    failure.name = 'TypeError'
    const { fetchFn, calls } = mockFetch([failure, failure])
    const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, maxAttempts: 2 })
    assert.equal(result.ok, false)
    assert.equal(result.aiStatus, 'unavailable')
    assert.equal(calls.length, 2)
  })

  it('10. timeout reports a timeout status', async () => {
    const timeout = new Error('The operation was aborted')
    timeout.name = 'TimeoutError'
    const { fetchFn } = mockFetch([timeout])
    const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, ...noRetry })
    assert.equal(result.ok, false)
    assert.equal(result.aiStatus, 'timeout')
    assert.equal(result.errorCode, QWEN_AI_ERROR_CODE)
  })

  it('11. retry limit is enforced and options are hard-capped', async () => {
    const { fetchFn, calls } = mockFetch([
      chatResponse({ status: 503, body: {} }),
      chatResponse({ status: 503, body: {} }),
      chatResponse({ status: 503, body: {} }),
      chatResponse({ status: 503, body: {} })
    ])
    const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, maxAttempts: 99 })
    assert.equal(result.ok, false)
    assert.equal(calls.length, 3)
    assert.deepEqual(normalizeQwenOptions({ maxAttempts: 99 }), { maxAttempts: 3, timeoutMs: 30000 })
    assert.deepEqual(normalizeQwenOptions({ maxAttempts: 'x', timeoutMs: -1 }), { maxAttempts: 3, timeoutMs: 30000 })
  })

  it('12. failures never log the API key or response material', async () => {
    const { fetchFn } = mockFetch([chatResponse({ status: 401, body: {} })])
    const { value, lines } = await capturedErrors(
      () => analyzeWithQwen({ question: 'q?' }, { fetchFn, ...noRetry })
    )
    assert.equal(value.aiStatus, 'invalid')
    for (const line of lines) {
      assert.doesNotMatch(line, new RegExp(TEST_KEY))
    }
    // Status helpers expose configuration only, never the secret.
    for (const text of [qwenStatus(), qwenModel(), qwenApiBase() ?? '', String(qwenConfigured())]) {
      assert.doesNotMatch(text, new RegExp(TEST_KEY))
    }
  })

  it('13. guardrail-violating output is rejected even when schema-valid', async () => {
    const hostile = {
      ...validAnalysis(),
      interpretation: 'The checkpoint is cryptographically verified on mainnet.'
    }
    const { fetchFn } = mockFetch([completionResponse(hostile)])
    const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, ...noRetry })
    assert.equal(result.ok, false)
    assert.equal(result.aiStatus, 'unavailable')
    assert.ok((result.validationErrors ?? []).some((m) => m.includes('guardrail')))
  })

  it('strict json_schema format is used only on explicit opt-in', async () => {
    process.env.QWEN_RESPONSE_FORMAT = 'json_schema'
    try {
      assert.equal(qwenResponseFormat(), 'json_schema')
      const { fetchFn, calls } = mockFetch([completionResponse(validAnalysis())])
      const result = await analyzeWithQwen({ question: 'q?' }, { fetchFn, ...noRetry })
      assert.equal(result.ok, true)
      const body = JSON.parse(calls[0].init.body)
      assert.equal(body.response_format.type, 'json_schema')
      assert.equal(body.response_format.json_schema.strict, true)
    } finally {
      delete process.env.QWEN_RESPONSE_FORMAT
    }
    assert.equal(qwenResponseFormat(), 'json_object')
  })

  it('retry-after parsing matches Meta conventions', async () => {
    assert.equal(parseQwenRetryAfterMs(null), null)
    assert.equal(parseQwenRetryAfterMs('2'), 2000)
    assert.equal(parseQwenRetryAfterMs('bogus-date-here'), null)
  })
})
