// AI provider orchestration tests (Phase 7). Qwen primary, Meta fallback.
// Provider clients are stubbed; no real network traffic leaves the process.
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { resolveProviderAnalysis } from './ai-provider.mjs'
import { QWEN_AI_ERROR_CODE } from './qwen-ai.mjs'
import { META_AI_ERROR_CODE } from './meta-ai.mjs'

const BASE = `/tmp/rg-ai-provider-test-${process.pid}`
const savedEnv = {}
before(() => {
  for (const key of ['RECALLGUARD_DB_PATH', 'TATUM_API_KEY', 'META_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_BASE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy']) {
    savedEnv[key] = process.env[key]
  }
  process.env.RECALLGUARD_DB_PATH = `${BASE}/recallguard.db`
  delete process.env.TATUM_API_KEY
  delete process.env.META_API_KEY
  delete process.env.DASHSCOPE_API_KEY
  delete process.env.QWEN_API_BASE
  delete process.env.HTTP_PROXY
  delete process.env.HTTPS_PROXY
  delete process.env.ALL_PROXY
  delete process.env.http_proxy
  delete process.env.https_proxy
  process.env.NO_PROXY = '127.0.0.1,localhost'
  process.env.no_proxy = '127.0.0.1,localhost'
})

const { resolveAiAnalysis } = await import('./routes/recallguard.mjs')

function validAnalysis(provider = 'qwen', model = 'qwen3.8-flash') {
  return {
    subQuestions: ['What checkpoint is latest?'],
    interpretation: 'The checkpoint advanced from 100 to 105.',
    contradictions: [],
    uncertainties: ['Whether 105 is final.'],
    evidenceGaps: [],
    confidenceNote: 'Moderate; based only on the supplied checkpoint metadata.',
    model,
    provider
  }
}

function qwenSuccess(analysis = validAnalysis()) {
  return async () => ({ ok: true, aiStatus: 'completed', errorCode: null, analysis, latencyMs: 12 })
}

function qwenFailure(errorCode = QWEN_AI_ERROR_CODE) {
  return async () => ({ ok: false, aiStatus: 'unavailable', errorCode, analysis: null })
}

function metaSuccess(analysis = validAnalysis('meta', 'muse-spark-1.3')) {
  return async () => ({ ok: true, aiStatus: 'completed', errorCode: null, analysis, latencyMs: 9 })
}

function metaFailure() {
  return async () => ({ ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null })
}

function trackingStore() {
  const records = []
  return {
    records,
    persistAiAnalysis: (record) => {
      records.push(record)
      return true
    }
  }
}

function testSession() {
  return {
    id: 'SES-TEST-001',
    question: 'What is the latest Sui checkpoint status on mainnet?',
    researchPlan: { capability: 'sui_checkpoint_status' },
    onChainSuiData: { checkpointSequence: '105' },
    evidenceComparison: { status: 'no_comparable_prior_evidence' }
  }
}

describe('ai-provider orchestration', () => {
  it('1. Qwen success returns Qwen and never calls Meta', async () => {
    let metaCalls = 0
    const metaFn = async (...args) => {
      metaCalls += 1
      return metaSuccess()( ...args)
    }
    const result = await resolveProviderAnalysis({ question: 'q?' }, { qwenFn: qwenSuccess(), metaFn })
    assert.equal(result.ok, true)
    assert.equal(result.provider, 'qwen')
    assert.equal(result.model, 'qwen3.8-flash')
    assert.equal(result.fallbackUsed, false)
    assert.equal(result.meta, null)
    assert.equal(metaCalls, 0)
  })

  it('2. Qwen failure falls back to Meta and preserves the Qwen category', async () => {
    const result = await resolveProviderAnalysis({ question: 'q?' }, { qwenFn: qwenFailure(), metaFn: metaSuccess() })
    assert.equal(result.ok, true)
    assert.equal(result.provider, 'meta')
    assert.equal(result.model, 'muse-spark-1.3')
    assert.equal(result.fallbackUsed, true)
    assert.equal(result.qwen.errorCode, QWEN_AI_ERROR_CODE)
    assert.equal(result.meta.errorCode, null)
  })

  it('3. malformed Qwen output triggers the Meta fallback', async () => {
    const malformed = async () => ({ ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null })
    const result = await resolveProviderAnalysis({ question: 'q?' }, { qwenFn: malformed, metaFn: metaSuccess() })
    assert.equal(result.ok, true)
    assert.equal(result.provider, 'meta')
    assert.equal(result.fallbackUsed, true)
  })

  it('4. guardrail-rejected Qwen output attempts the Meta fallback', async () => {
    const rejected = async () => ({
      ok: false,
      aiStatus: 'unavailable',
      errorCode: QWEN_AI_ERROR_CODE,
      analysis: null,
      validationErrors: ['guardrail violation in interpretation']
    })
    let metaCalls = 0
    const metaFn = async () => {
      metaCalls += 1
      return metaSuccess()()
    }
    const result = await resolveProviderAnalysis({ question: 'q?' }, { qwenFn: rejected, metaFn })
    assert.equal(result.ok, true)
    assert.equal(metaCalls, 1)
  })

  it('5. both providers failing returns safe unavailable with no analysis', async () => {
    const result = await resolveProviderAnalysis({ question: 'q?' }, { qwenFn: qwenFailure(), metaFn: metaFailure() })
    assert.equal(result.ok, false)
    assert.equal(result.aiStatus, 'unavailable')
    assert.equal(result.analysis, null)
    // Both doubles ran, Meta last: naming Meta is honest, and the fallback
    // genuinely ran. (When a provider never runs it is never named.)
    assert.equal(result.provider, 'meta')
    assert.equal(result.fallbackUsed, true)
  })

  it('6. a Qwen ok-result without analysis is not passed downstream', async () => {
    const empty = async () => ({ ok: true, aiStatus: 'completed', errorCode: null, analysis: null })
    let metaCalls = 0
    const metaFn = async () => {
      metaCalls += 1
      return metaSuccess()()
    }
    const result = await resolveProviderAnalysis({ question: 'q?' }, { qwenFn: empty, metaFn })
    assert.equal(result.ok, true)
    assert.equal(result.provider, 'meta')
    assert.equal(metaCalls, 1)
  })

  it('7. one invocation persists exactly one analysis record', async () => {
    const store = trackingStore()
    const out = await resolveAiAnalysis(testSession(), [], {
      analyzeFn: async (input) => resolveProviderAnalysis(input, { qwenFn: qwenSuccess(), metaFn: metaSuccess() }),
      store
    })
    assert.equal(out.aiStatus, 'completed')
    assert.equal(store.records.length, 1)
    assert.equal(store.records[0].sessionId, 'SES-TEST-001')
  })

  it('8. provider and model attribution is correct on Qwen success', async () => {
    const store = trackingStore()
    const out = await resolveAiAnalysis(testSession(), [], {
      analyzeFn: async (input) => resolveProviderAnalysis(input, { qwenFn: qwenSuccess(), metaFn: metaSuccess() }),
      store
    })
    assert.equal(out.aiProvider, 'qwen')
    assert.equal(out.aiFallbackUsed, false)
    assert.equal(store.records[0].provider, 'qwen')
    assert.equal(store.records[0].model, 'qwen3.8-flash')
    assert.equal(store.records[0].status, 'completed')
  })

  it('9. fallback is recorded with both attempt outcomes on Meta success', async () => {
    const store = trackingStore()
    const out = await resolveAiAnalysis(testSession(), [], {
      analyzeFn: async (input) => resolveProviderAnalysis(input, { qwenFn: qwenFailure(), metaFn: metaSuccess() }),
      store
    })
    assert.equal(out.aiProvider, 'meta')
    assert.equal(out.aiFallbackUsed, true)
    const record = store.records[0]
    assert.equal(record.fallbackUsed, true)
    assert.equal(record.qwen.errorCode, QWEN_AI_ERROR_CODE)
    assert.equal(record.meta.errorCode, null)
  })

  it('10. deterministic session stays intact when both providers fail', async () => {
    const store = trackingStore()
    const session = testSession()
    const before = JSON.parse(JSON.stringify(session))
    const out = await resolveAiAnalysis(session, [], {
      analyzeFn: async (input) => resolveProviderAnalysis(input, { qwenFn: qwenFailure(), metaFn: metaFailure() }),
      store
    })
    assert.equal(out.aiStatus, 'unavailable')
    assert.equal(out.aiAnalysis, null)
    assert.deepEqual(session, before)
    assert.equal(store.records.length, 1)
    assert.equal(store.records[0].analysis, null)
  })

  it('throwing provider doubles fail closed to unavailable', async () => {
    const throwing = async () => { throw new Error('boom') }
    const result = await resolveProviderAnalysis({ question: 'q?' }, { qwenFn: throwing, metaFn: throwing })
    assert.equal(result.ok, false)
    assert.equal(result.aiStatus, 'unavailable')
  })

  it('7D pattern: Qwen timeout with Meta unconfigured attributes Qwen, never Meta', async () => {
    const qwenTimeout = async () => ({ ok: false, aiStatus: 'timeout', errorCode: QWEN_AI_ERROR_CODE, analysis: null })
    const metaUnconfigured = async () => ({ ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null, ran: false })
    const result = await resolveProviderAnalysis({ question: 'q?' }, { qwenFn: qwenTimeout, metaFn: metaUnconfigured })
    assert.equal(result.ok, false)
    assert.equal(result.provider, 'qwen')
    assert.equal(result.model, 'qwen3.8-flash')
    assert.equal(result.fallbackUsed, false)
    assert.equal(result.errorCode, QWEN_AI_ERROR_CODE)
    assert.equal(result.meta, null)
    assert.equal(result.qwen.status, 'timeout')
  })

  it('7D pattern persists honestly: no Meta attribution, fallback not claimed', async () => {
    const store = trackingStore()
    const qwenTimeout = async () => ({ ok: false, aiStatus: 'timeout', errorCode: QWEN_AI_ERROR_CODE, analysis: null })
    const metaUnconfigured = async () => ({ ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null, ran: false })
    const out = await resolveAiAnalysis(testSession(), [], {
      analyzeFn: async (input) => resolveProviderAnalysis(input, { qwenFn: qwenTimeout, metaFn: metaUnconfigured }),
      store
    })
    assert.equal(out.aiStatus, 'unavailable')
    assert.equal(out.aiProvider, 'qwen')
    assert.equal(out.aiFallbackUsed, false)
    assert.equal(out.aiErrorCode, QWEN_AI_ERROR_CODE)
    assert.equal(store.records.length, 1)
    assert.equal(store.records[0].provider, 'qwen')
    assert.equal(store.records[0].model, 'qwen3.8-flash')
  })

  it('allowFallback:false with Qwen success never calls Meta', async () => {
    let metaCalls = 0
    const metaFn = async () => {
      metaCalls += 1
      return metaSuccess()()
    }
    const result = await resolveProviderAnalysis({ question: 'q?' }, {
      qwenFn: qwenSuccess(), metaFn, allowFallback: false
    })
    assert.equal(result.ok, true)
    assert.equal(result.provider, 'qwen')
    assert.equal(result.fallbackUsed, false)
    assert.equal(result.fallbackDisabled, true)
    assert.equal(metaCalls, 0)
  })

  it('allowFallback:false with Qwen failure reports Qwen only', async () => {
    let metaCalls = 0
    const metaFn = async () => {
      metaCalls += 1
      return metaSuccess()()
    }
    const result = await resolveProviderAnalysis({ question: 'q?' }, {
      qwenFn: qwenFailure(), metaFn, allowFallback: false
    })
    assert.equal(result.ok, false)
    assert.equal(result.provider, 'qwen')
    assert.equal(result.errorCode, QWEN_AI_ERROR_CODE)
    assert.equal(result.fallbackUsed, false)
    assert.equal(result.fallbackDisabled, true)
    assert.equal(result.meta, null)
    assert.equal(metaCalls, 0)
  })

  it('neither provider configured records unavailable without inventing a provider', async () => {
    const store = trackingStore()
    const neverRan = async () => ({ ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null, ran: false })
    const out = await resolveAiAnalysis(testSession(), [], {
      analyzeFn: async (input) => resolveProviderAnalysis(input, {
        qwenFn: neverRan,
        metaFn: async () => ({ ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null, ran: false })
      }),
      store
    })
    assert.equal(out.aiStatus, 'unavailable')
    assert.equal(out.aiProvider, null)
    assert.equal(out.aiFallbackUsed, false)
    assert.equal(store.records.length, 1)
    assert.equal(store.records[0].provider, 'unavailable')
    assert.equal(store.records[0].model, 'unknown')
  })
})
