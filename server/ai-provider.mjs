// AI provider orchestration (Phase 7). Qwen is the primary provider, Meta
// Muse Spark 1.3 is the fallback. Sequential only: Meta is never invoked
// after a successful Qwen result, Qwen is never retried after falling back
// to Meta, and the two providers are never called simultaneously.
//
// Result contract (extends the single-provider shape additively):
// {
//   ok, aiStatus, errorCode, analysis, latencyMs?,
//   provider: 'qwen' | 'meta' | null,  // last provider that actually ran
//   model: string | null,
//   fallbackUsed: boolean,  // true only when the Meta fallback ran
//   qwen: { status, errorCode, ran },  // sanitized attempt outcome, always set
//   meta: { status, errorCode, ran } | null  // null when fallback never ran
// }
//
// Failure never throws and never fabricates an analysis: when both
// providers fail the result is a safe unavailable outcome and the caller
// (resolveAiAnalysis) preserves the deterministic session.

import { analyzeWithQwen, QWEN_AI_ERROR_CODE, qwenModel } from './qwen-ai.mjs'
import { analyzeResearch, META_AI_ERROR_CODE, metaModel } from './meta-ai.mjs'

export const AI_ORCHESTRATOR_VERSION = '1.0.0'

// Stable, sanitized per-attempt outcome for audit records. No prompts,
// response bodies, or raw error detail — status and code only.
function attemptOutcome(result, fallbackCode) {
  if (!result || typeof result !== 'object') {
    return { status: 'unavailable', errorCode: fallbackCode }
  }
  if (result.ok === true && result.analysis) {
    return { status: 'completed', errorCode: null }
  }
  const aiStatus = result.aiStatus
  const status = aiStatus === 'invalid' || aiStatus === 'timeout' || aiStatus === 'unavailable'
    ? aiStatus
    : 'unavailable'
  return { status, errorCode: result.errorCode || fallbackCode }
}

function qwenOutcome(result) {
  return attemptOutcome(result, QWEN_AI_ERROR_CODE)
}

function metaOutcome(result) {
  return attemptOutcome(result, META_AI_ERROR_CODE)
}

export async function resolveProviderAnalysis(
  input = {},
  { qwenFn = analyzeWithQwen, metaFn = analyzeResearch, qwenOptions = {}, metaOptions = {}, allowFallback = true } = {}
) {
  // A. Primary first: Qwen. Never throws past the client boundary; a
  // throwing test double is treated as an unavailable attempt.
  let qwenResult
  try {
    qwenResult = await qwenFn(input, qwenOptions)
  } catch {
    qwenResult = { ok: false, aiStatus: 'unavailable', errorCode: QWEN_AI_ERROR_CODE, analysis: null }
  }
  const qwen = qwenOutcome(qwenResult)

  // B. Qwen success: select Qwen, do not call Meta.
  if (qwenResult && qwenResult.ok === true && qwenResult.analysis) {
    return {
      ok: true,
      aiStatus: 'completed',
      errorCode: null,
      analysis: qwenResult.analysis,
      latencyMs: qwenResult.latencyMs ?? null,
      provider: 'qwen',
      model: qwenResult.analysis.model || qwenModel(),
      fallbackUsed: false,
      fallbackDisabled: !allowFallback,
      qwen,
      meta: null
    }
  }

  // B2. Fallback disabled: report the honest Qwen outcome without ever
  // invoking Meta. The deterministic session stays intact upstream.
  if (!allowFallback) {
    const qwenRan = !qwenResult || qwenResult.ran !== false
    const status = qwenResult && (qwenResult.aiStatus === 'invalid' || qwenResult.aiStatus === 'timeout' || qwenResult.aiStatus === 'unavailable')
      ? qwenResult.aiStatus
      : 'unavailable'
    return {
      ok: false,
      aiStatus: status,
      errorCode: (qwenResult && qwenResult.errorCode) || QWEN_AI_ERROR_CODE,
      analysis: null,
      validationErrors: qwenResult && Array.isArray(qwenResult.validationErrors)
        ? qwenResult.validationErrors
        : [],
      latencyMs: null,
      provider: qwenRan ? 'qwen' : null,
      model: qwenRan ? qwenModel() : null,
      fallbackUsed: false,
      fallbackDisabled: true,
      qwen: { ...qwen, ran: qwenRan },
      meta: null
    }
  }

  // C. Qwen failed: record the sanitized category and fall back to Meta
  // with its existing retry/timeout policies.
  let metaResult
  try {
    metaResult = await metaFn(input, metaOptions)
  } catch {
    metaResult = { ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null }
  }
  const meta = metaOutcome(metaResult)

  // D. Meta fallback success: return Meta, preserve Qwen failure category.
  if (metaResult && metaResult.ok === true && metaResult.analysis) {
    return {
      ok: true,
      aiStatus: 'completed',
      errorCode: null,
      analysis: metaResult.analysis,
      latencyMs: metaResult.latencyMs ?? null,
      provider: 'meta',
      model: metaResult.analysis.model || metaModel(),
      fallbackUsed: true,
      fallbackDisabled: false,
      qwen,
      meta
    }
  }

  // E. Both failed: safe unavailable outcome. No analysis is fabricated;
  // the deterministic session stays intact upstream. Attribution names
  // only providers that actually ran: Meta when the fallback ran, else
  // Qwen when only the primary ran, else neither. A provider that never
  // ran is never named, and fallback is claimed only when it ran.
  const metaRan = !metaResult || metaResult.ran !== false
  const qwenRan = !qwenResult || qwenResult.ran !== false
  const qwenFinal = { ...qwen, ran: qwenRan }
  const metaFinal = metaRan ? { ...meta, ran: true } : null
  // Outcome fields come from the last attempt that actually ran, so an
  // uncontacted provider contributes no status, code, or diagnostics.
  const lastRan = metaRan ? metaResult : (qwenRan ? qwenResult : null)
  const lastStatus = lastRan && (lastRan.aiStatus === 'invalid' || lastRan.aiStatus === 'timeout' || lastRan.aiStatus === 'unavailable')
    ? lastRan.aiStatus
    : 'unavailable'
  // Sanitized validation diagnostics from the attempt that actually ran:
  // field paths and rule names only, never model text.
  const validationErrors = lastRan && Array.isArray(lastRan.validationErrors)
    ? lastRan.validationErrors
    : []
  return {
    ok: false,
    aiStatus: lastStatus,
    errorCode: (lastRan && lastRan.errorCode) || (metaRan ? META_AI_ERROR_CODE : QWEN_AI_ERROR_CODE),
    analysis: null,
    validationErrors,
    latencyMs: null,
    provider: metaRan ? 'meta' : (qwenRan ? 'qwen' : null),
    model: metaRan ? metaModel() : (qwenRan ? qwenModel() : null),
    fallbackUsed: metaRan,
    fallbackDisabled: false,
    qwen: qwenFinal,
    meta: metaFinal
  }
}
