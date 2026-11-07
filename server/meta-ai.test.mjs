// Meta AI client tests. All network I/O is mocked via fetchFn; no real
// Meta traffic leaves the process and no credential is used.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeResearch,
  validateAnalysis,
  buildAnalysisMessages,
  normalizeMetaOptions,
  parseRetryAfterMs,
  RESEARCH_ANALYSIS_SCHEMA,
  META_AI_ERROR_CODE,
  META_AI_INVALID_CODE,
  META_MODEL_DEFAULT
} from './meta-ai.mjs'

const TEST_KEY = 'test-meta-key-0123456789abcdef'
let savedKey

before(() => {
  savedKey = process.env.META_API_KEY
  process.env.META_API_KEY = TEST_KEY
})

after(() => {
  if (savedKey === undefined) delete process.env.META_API_KEY
  else process.env.META_API_KEY = savedKey
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

describe('meta-ai client', () => {
  it('returns validated analysis on success', async () => {
    const { fetchFn, calls } = mockFetch([completionResponse(validAnalysis())])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, ...noRetry })
    assert.equal(result.ok, true)
    assert.equal(result.aiStatus, 'completed')
    assert.equal(result.errorCode, null)
    assert.equal(result.analysis.model, META_MODEL_DEFAULT)
    assert.equal(result.analysis.provider, 'meta')
    assert.equal(result.analysis.interpretation, 'The checkpoint advanced from 100 to 105.')
    assert.equal(calls.length, 1)
  })

  it('posts to the Meta chat completions endpoint with strict JSON schema', async () => {
    const { fetchFn, calls } = mockFetch([completionResponse(validAnalysis())])
    await analyzeResearch({ question: 'q?' }, { fetchFn, ...noRetry })
    const { url, init } = calls[0]
    assert.equal(url, 'https://api.meta.ai/v1/chat/completions')
    assert.equal(init.method, 'POST')
    // Bearer header present; value never asserted beyond shape.
    assert.match(init.headers.Authorization, /^Bearer .+/)
    assert.ok(init.headers.Authorization.length > 'Bearer '.length)
    const body = JSON.parse(init.body)
    assert.equal(body.model, 'muse-spark-1.3')
    assert.equal(body.temperature, 0)
    assert.equal(body.response_format.type, 'json_schema')
    assert.equal(body.response_format.json_schema.strict, true)
    assert.equal(body.response_format.json_schema.name, 'recallguard_research_analysis')
  })

  it('rejects schema-violating output without exposing internals', async () => {
    const bad = { ...validAnalysis() }
    delete bad.confidenceNote
    const { fetchFn } = mockFetch([completionResponse(bad)])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, ...noRetry })
    assert.equal(result.ok, false)
    assert.equal(result.aiStatus, 'unavailable')
    assert.equal(result.errorCode, META_AI_ERROR_CODE)
    assert.equal(result.analysis, null)
  })

  it('rejects guardrail-violating output', async () => {
    const bad = {
      ...validAnalysis(),
      interpretation: 'The checkpoint is cryptographically verified on chain.'
    }
    const { fetchFn } = mockFetch([completionResponse(bad)])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, ...noRetry })
    assert.equal(result.ok, false)
    assert.equal(result.analysis, null)
  })

  it('rejects invalid JSON content', async () => {
    const { fetchFn } = mockFetch([
      chatResponse({ body: { choices: [{ message: { content: '{not json' } }] } })
    ])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, ...noRetry })
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, META_AI_ERROR_CODE)
  })

  it('rejects empty message content', async () => {
    const { fetchFn } = mockFetch([
      chatResponse({ body: { choices: [{ message: {} }] } })
    ])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, ...noRetry })
    assert.equal(result.ok, false)
  })

  it('reports invalid status on 401 without retrying', async () => {
    const { fetchFn, calls } = mockFetch([chatResponse({ status: 401, body: { error: 'x' } })])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, maxAttempts: 3 })
    assert.equal(result.ok, false)
    assert.equal(result.aiStatus, 'invalid')
    assert.equal(result.errorCode, META_AI_INVALID_CODE)
    assert.equal(calls.length, 1)
  })

  it('fails fast on non-retryable 400', async () => {
    const { fetchFn, calls } = mockFetch([chatResponse({ status: 400, body: 'bad' })])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, maxAttempts: 3 })
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, META_AI_ERROR_CODE)
    assert.equal(calls.length, 1)
  })

  it('retries a 429 then succeeds', async () => {
    const { fetchFn, calls } = mockFetch([
      chatResponse({ status: 429, body: 'slow down' }),
      completionResponse(validAnalysis())
    ])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, maxAttempts: 3 })
    assert.equal(result.ok, true)
    assert.equal(result.aiStatus, 'completed')
    assert.equal(calls.length, 2)
  })

  it('gives up after repeated 429s', async () => {
    const { fetchFn, calls } = mockFetch([
      chatResponse({ status: 429, body: 'a' }),
      chatResponse({ status: 429, body: 'b' }),
      chatResponse({ status: 429, body: 'c' })
    ])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, maxAttempts: 3 })
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, META_AI_ERROR_CODE)
    assert.equal(calls.length, 3)
  })

  it('retries a 500 then succeeds', async () => {
    const { fetchFn, calls } = mockFetch([
      chatResponse({ status: 500, body: 'boom' }),
      completionResponse(validAnalysis())
    ])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, maxAttempts: 3 })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 2)
  })

  it('retries a network failure then succeeds', async () => {
    const { fetchFn, calls } = mockFetch([
      new Error('connect timeout'),
      completionResponse(validAnalysis())
    ])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, maxAttempts: 3 })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 2)
  })

  it('handles malformed envelope JSON safely', async () => {
    const { fetchFn } = mockFetch([{ ok: true, status: 200, json: async () => { throw new Error('bad'); }, text: async () => 'bad' }])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, ...noRetry })
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, META_AI_ERROR_CODE)
  })

  it('returns unavailable when no key is configured, without calling fetch', async () => {
    delete process.env.META_API_KEY
    let called = false
    const result = await analyzeResearch(
      { question: 'q?' },
      { fetchFn: async () => { called = true; throw new Error('must not be called'); }, ...noRetry }
    )
    assert.equal(result.ok, false)
    assert.equal(result.aiStatus, 'unavailable')
    assert.equal(called, false)
    process.env.META_API_KEY = TEST_KEY
  })

  it('validates contradiction severity values', async () => {
    const bad = { ...validAnalysis(), contradictions: [{ claim: 'a', against: 'b', severity: 'certain' }] }
    assert.equal(validateAnalysis(bad).valid, false)
    assert.equal(validateAnalysis(validAnalysis()).valid, true)
  })

  it('clamps retry and timeout options to safe bounds', () => {
    assert.deepEqual(normalizeMetaOptions({}), { maxAttempts: 3, timeoutMs: 30000 })
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: 99, timeoutMs: 5000 }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: 1 }).maxAttempts, 1)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: 0 }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: -2 }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: 2.5 }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: 'x' }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ timeoutMs: -5 }).timeoutMs, 30000)
    assert.deepEqual(normalizeMetaOptions({ timeoutMs: NaN }).timeoutMs, 30000)
    assert.deepEqual(normalizeMetaOptions({ timeoutMs: 'fast' }).timeoutMs, 30000)
    assert.deepEqual(normalizeMetaOptions({ timeoutMs: 5000 }).timeoutMs, 5000)
  })

  it('never exceeds three attempts regardless of caller options', async () => {
    const { fetchFn, calls } = mockFetch([
      chatResponse({ status: 503, body: 'a' }),
      chatResponse({ status: 503, body: 'b' }),
      chatResponse({ status: 503, body: 'c' }),
      chatResponse({ status: 503, body: 'd' }),
      chatResponse({ status: 503, body: 'e' })
    ])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, maxAttempts: 99 })
    assert.equal(result.ok, false)
    assert.equal(calls.length, 3)
  })

  it('parses numeric and HTTP-date Retry-After forms', () => {
    assert.equal(parseRetryAfterMs('2'), 2000)
    assert.equal(parseRetryAfterMs('0.5'), 500)
    assert.equal(parseRetryAfterMs('120'), 10000)
    assert.equal(parseRetryAfterMs(null), null)
    assert.equal(parseRetryAfterMs('garbage!!'), null)
    assert.equal(parseRetryAfterMs('-1'), null)
    const now = Date.now()
    const future = new Date(now + 4000).toUTCString()
    const parsed = parseRetryAfterMs(future, now)
    assert.ok(parsed >= 3000 && parsed <= 4000)
    const past = new Date(now - 60000).toUTCString()
    assert.equal(parseRetryAfterMs(past, now), 0)
  })

  it('honors HTTP-date Retry-After then succeeds', async () => {
    const { fetchFn, calls } = mockFetch([
      {
        ok: false,
        status: 429,
        headers: { get: () => new Date(Date.now() + 300).toUTCString() },
        json: async () => ({}),
        text: async () => ''
      },
      completionResponse(validAnalysis())
    ])
    const result = await analyzeResearch({ question: 'q?' }, { fetchFn, maxAttempts: 3 })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 2)
  })

  it('fails closed on timeout without hanging', async () => {
    const hangingFetch = (_url, init = {}) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('The operation was aborted due to timeout')
        error.name = 'TimeoutError'
        reject(error)
      })
    })
    const started = Date.now()
    const result = await analyzeResearch(
      { question: 'q?' },
      { fetchFn: hangingFetch, timeoutMs: 60, maxAttempts: 1 }
    )
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, META_AI_ERROR_CODE)
    assert.ok(Date.now() - started < 5000)
  })

  it('rejects malformed array elements and unexpected properties', () => {
    const badElements = { ...validAnalysis(), subQuestions: ['ok', 42] }
    assert.equal(validateAnalysis(badElements).valid, false)
    const badUncertainty = { ...validAnalysis(), uncertainties: [null] }
    assert.equal(validateAnalysis(badUncertainty).valid, false)
    const badGap = { ...validAnalysis(), evidenceGaps: ['ok', { nested: true }] }
    assert.equal(validateAnalysis(badGap).valid, false)
    const badItem = {
      ...validAnalysis(),
      contradictions: [{ claim: 'a', against: 'b', severity: 'low', extra: 'x' }]
    }
    assert.equal(validateAnalysis(badItem).valid, false)
    const badTop = { ...validAnalysis(), verdict: 'buy' }
    assert.equal(validateAnalysis(badTop).valid, false)
    const badItemType = { ...validAnalysis(), contradictions: ['not-an-object'] }
    assert.equal(validateAnalysis(badItemType).valid, false)
    assert.equal(validateAnalysis(validAnalysis()).valid, true)
  })

  it('rejects prohibited content in every text field', () => {
    const cases = [
      ['subQuestions', ['Is it cryptographically verified?']],
      ['interpretation', 'The checkpoint is cryptographically verified on chain.'],
      ['contradictions.claim', [{ claim: 'It is independently verified', against: 'retrieval log', severity: 'high' }]],
      ['contradictions.against', [{ claim: 'a', against: 'a verified fact from Tatum', severity: 'low' }]],
      ['uncertainties', ['Whether to supersede the old memory.']],
      ['evidenceGaps', ['Need a belief revision before concluding.']],
      ['confidenceNote', 'Cryptographic proof is conclusive.']
    ]
    for (const [field, value] of cases) {
      const candidate = { ...validAnalysis() }
      const leaf = field.split('.')[0]
      if (field.startsWith('contradictions.')) {
        candidate.contradictions = field.endsWith('.claim')
          ? [{ claim: value[0].claim, against: 'b', severity: 'low' }]
          : [{ claim: 'a', against: value[0].against, severity: 'low' }]
      } else {
        candidate[leaf] = value
      }
      assert.equal(validateAnalysis(candidate).valid, false, `expected rejection in ${field}`)
    }
  })

  it('allows honest denials that mention prohibited words', () => {
    const allowed = {
      ...validAnalysis(),
      interpretation: 'The checkpoint advanced, but it is not cryptographically verified.',
      confidenceNote: 'No verified fact is established; retrieval alone proves nothing.',
      uncertainties: ['Whether the object cannot be independently verified without another fetch.'],
      evidenceGaps: ['Cryptographic proof is missing, so verification is unverified.']
    }
    assert.equal(validateAnalysis(allowed).valid, true)
  })

  it('accepts only actual numbers for retry and timeout options', () => {
    // Documented fallback: anything that is not a valid number resets to
    // { maxAttempts: 3, timeoutMs: 30000 }. Strings are never coerced.
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: '2' }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: '3' }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: true }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: false }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: null }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: undefined }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: 2 }).maxAttempts, 2)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: 3 }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: 4 }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ maxAttempts: Infinity }).maxAttempts, 3)
    assert.deepEqual(normalizeMetaOptions({ timeoutMs: '5000' }).timeoutMs, 30000)
    assert.deepEqual(normalizeMetaOptions({ timeoutMs: true }).timeoutMs, 30000)
    assert.deepEqual(normalizeMetaOptions({ timeoutMs: null }).timeoutMs, 30000)
    assert.deepEqual(normalizeMetaOptions({ timeoutMs: Infinity }).timeoutMs, 30000)
    assert.deepEqual(normalizeMetaOptions({ timeoutMs: 0 }).timeoutMs, 30000)
  })

  it('rejects ambiguous double negatives and distant negations', () => {
    const denied = [
      'It is not impossible that the claim was verified.',
      'It is not true that the claim was never verified.',
      'The result is not unverified.',
      'It is not false that the claim was verified.',
      'The claim was verified. That is false.',
      'The claim is verified. It is not.'
    ]
    for (const interpretation of denied) {
      const candidate = { ...validAnalysis(), interpretation }
      assert.equal(validateAnalysis(candidate).valid, false, `expected rejection: ${interpretation}`)
    }
  })

  it('preserves clear directly attached denials', () => {
    const allowed = [
      'This claim is not cryptographically verified.',
      'The claim has not been independently verified.',
      'No verified fact is established.',
      'The checkpoint cannot be independently verified.'
    ]
    for (const interpretation of allowed) {
      const candidate = { ...validAnalysis(), interpretation }
      assert.equal(validateAnalysis(candidate).valid, true, `expected pass: ${interpretation}`)
    }
  })

  it('rejects affirmative proof claims but allows clear proof denials', () => {
    const rejected = [
      'The claim is proven.',
      'This is a proven fact.',
      'The evidence proves the claim.'
    ]
    for (const interpretation of rejected) {
      const candidate = { ...validAnalysis(), interpretation }
      assert.equal(validateAnalysis(candidate).valid, false, `expected rejection: ${interpretation}`)
    }
    const allowed = [
      'The claim is not proven.',
      'There is no proof that the claim is true.'
    ]
    for (const interpretation of allowed) {
      const candidate = { ...validAnalysis(), interpretation }
      assert.equal(validateAnalysis(candidate).valid, true, `expected pass: ${interpretation}`)
    }
  })

  it('matches only exact proof words, not provide/provider/provision', () => {
    const rejected = [
      'The claim is proven.',
      'The evidence proves the claim.',
      'This is a proven fact.'
    ]
    for (const interpretation of rejected) {
      const candidate = { ...validAnalysis(), interpretation }
      assert.equal(validateAnalysis(candidate).valid, false, `expected rejection: ${interpretation}`)
    }
    const allowed = [
      'There is no proof that the claim is true.',
      'Please provide the evidence.',
      'The provider supplied the evidence.',
      'The provision applies to this case.'
    ]
    for (const interpretation of allowed) {
      const candidate = { ...validAnalysis(), interpretation }
      assert.equal(validateAnalysis(candidate).valid, true, `expected pass: ${interpretation}`)
    }
  })

  it('never logs keys, bodies, or model output', async () => {
    const lines = []
    const original = console.error
    console.error = (...args) => { lines.push(args.join(' ')) }
    try {
      const { fetchFn } = mockFetch([chatResponse({ status: 401, body: { error: 'x' } })])
      await analyzeResearch({ question: 'secret user question' }, { fetchFn, maxAttempts: 1 })
    } finally {
      console.error = original
    }
    const joined = lines.join('\n')
    assert.ok(joined.length > 0)
    assert.ok(!joined.includes(TEST_KEY))
    assert.ok(!joined.includes('secret user question'))
    assert.ok(!joined.includes('Authorization'))
    assert.match(joined, /status=401/)
  })

  it('builds prompts from supplied evidence only', async () => {
    const messages = buildAnalysisMessages({
      question: 'Latest checkpoint?',
      capability: 'sui_checkpoint_status',
      onChainSuiData: { network: 'sui-mainnet', checkpointSequence: '105' },
      recalledMemories: [{ id: 'MEM-1', title: 't', provenance: 'live_production', content: 'SECRET-CONTENT', storageVerified: true }],
      evidenceComparison: { status: 'newer_observation' }
    })
    const userContent = messages.find((m) => m.role === 'user').content
    // Only identifiers and titles travel; full memory content stays out.
    assert.ok(userContent.includes('MEM-1'))
    assert.ok(!userContent.includes('SECRET-CONTENT'))
    assert.ok(messages.find((m) => m.role === 'system').content.includes('Never invent'))
  })
})
