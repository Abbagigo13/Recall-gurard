// Shared Walrus publisher/aggregator helper with exact-byte read-back.
//
// Byte read-back equality means the aggregator returned exactly the bytes we
// published. It says nothing about whether the stored claims are true.

const DEFAULT_PUBLISHER_URL =
  process.env.WALRUS_PUBLISHER_URL ||
  'https://publisher.walrus-testnet.walrus.space'

const DEFAULT_AGGREGATOR_URL =
  process.env.WALRUS_AGGREGATOR_URL ||
  process.env.WALRUS_STORAGE_URL ||
  'https://aggregator.walrus-testnet.walrus.space'

const DEFAULT_PUBLISH_TIMEOUT_MS = 18000
const DEFAULT_READBACK_TIMEOUT_MS = 12000
const DEFAULT_MAX_PUBLISH_ATTEMPTS = 3
const DEFAULT_MAX_READBACK_ATTEMPTS = 5
const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 3000]

// Stable public code for Walrus write failures. Raw exception text stays
// server-side; HTTP responses carry only this code plus a fixed message.
export const WALRUS_WRITE_ERROR_CODE = 'WALRUS_WRITE_FAILED'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Keep error strings short and free of request bodies or credentials:
// only the failure kind and HTTP status are reported.
function safeMessage(error) {
  const message =
    error && typeof error.message === 'string' && error.message
      ? error.message
      : 'Unknown error'
  return message.slice(0, 500)
}

// Retry transient failures (network errors surface as throws and are retried
// by the caller; here only HTTP 429/5xx are retryable).
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

function delayForAttempt(retryDelaysMs, attempt) {
  if (!Array.isArray(retryDelaysMs) || retryDelaysMs.length === 0) return 0
  const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]
  return Number.isFinite(delay) && delay > 0 ? delay : 0
}

/**
 * Publish a payload to Walrus and verify it with an exact-byte read-back.
 *
 * Never throws: every failure is reported in the returned object so a failed
 * write cannot crash or discard the caller's session or memory record.
 *
 * @param {string|object} payload exact bytes (or value to JSON-stringify)
 * @param {object} options overrides for endpoints, attempts, timeouts, fetch
 * @returns {object} result with writeStatus, storageStatus, storageVerified,
 *   blobId, suiObjectId, aggregatorUrl, attempts, latencies, sanitized error
 */
/**
 * Classify one aggregator probe HTTP status into a stable health value.
 * Pure function: no I/O, no secrets, safe to log and expose.
 *
 * - probe_accepted: expected probe response (any 2xx, or 404
 *   blob-not-found). Preserves the previous `response.ok` semantics.
 * - probe_rejected: host answered with another 4xx — reachable, but the
 *   probe was rejected, so service health is inconclusive (never healthy).
 * - service_error: host answered 5xx.
 */
export function classifyAggregatorProbeStatus(httpStatus) {
  if (httpStatus === 404) return 'probe_accepted'
  if (Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus < 300) return 'probe_accepted'
  if (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500) return 'probe_rejected'
  if (Number.isInteger(httpStatus) && httpStatus >= 500 && httpStatus < 600) return 'service_error'
  return 'probe_rejected'
}

/**
 * Non-mutating aggregator connectivity probe: one exact-byte-free GET of a
 * nonexistent blob. Never publishes, never writes, never throws — a
 * network failure reports `unreachable`.
 */
// A syntactically valid but never-stored Walrus blob id (32 zero bytes in
// base64url). The aggregator answers a well-formed missing blob with 404
// (probe_accepted); a malformed id such as a plain word can be answered with
// 400 instead, which showed as a misleading "probe_rejected" health badge.
const PROBE_BLOB_ID = 'A'.repeat(43)

export async function probeWalrusAggregator({
  fetchFn = fetch,
  aggregatorUrl = DEFAULT_AGGREGATOR_URL,
  timeoutMs = 6000
} = {}) {
  const started = Date.now()
  try {
    const response = await fetchFn(`${aggregatorUrl}/v1/blobs/${PROBE_BLOB_ID}`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs)
    })
    return {
      status: classifyAggregatorProbeStatus(response.status),
      latencyMs: Date.now() - started
    }
  } catch {
    return { status: 'unreachable', latencyMs: Date.now() - started }
  }
}

export async function publishAndVerify(payload, options = {}) {
  const {
    publisherUrl = DEFAULT_PUBLISHER_URL,
    aggregatorUrl = DEFAULT_AGGREGATOR_URL,
    epochs = 1,
    fetchFn = fetch,
    maxPublishAttempts = DEFAULT_MAX_PUBLISH_ATTEMPTS,
    maxReadbackAttempts = DEFAULT_MAX_READBACK_ATTEMPTS,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    publishTimeoutMs = DEFAULT_PUBLISH_TIMEOUT_MS,
    readbackTimeoutMs = DEFAULT_READBACK_TIMEOUT_MS
  } = options

  const startedAt = Date.now()
  const bodyText =
    typeof payload === 'string' ? payload : JSON.stringify(payload)

  const baseResult = {
    writeStatus: 'failed',
    storageVerified: false,
    storageStatus: 'publish_failed',
    blobId: null,
    suiObjectId: null,
    aggregatorUrl: null,
    cost: null,
    certifiedEpoch: null,
    publisherResponse: null,
    publishHttpStatus: null,
    publishAttempts: 0,
    readbackAttempts: 0,
    publishLatencyMs: 0,
    readbackLatencyMs: 0,
    totalLatencyMs: 0,
    error: null
  }

  try {
    // 1. Publish with bounded retries for transient failures.
    const publishStartedAt = Date.now()
    let pubData = null
    let lastPublishError = 'Walrus publisher did not respond.'

    let publishAttempts = 0
    while (publishAttempts < maxPublishAttempts) {
      publishAttempts += 1
      try {
        const pubRes = await fetchFn(
          `${publisherUrl}/v1/blobs?epochs=${epochs}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: bodyText,
            signal: AbortSignal.timeout(publishTimeoutMs)
          }
        )

        baseResult.publishHttpStatus = pubRes.status

        if (pubRes.ok) {
          try {
            pubData = await pubRes.json()
          } catch {
            pubData = null
          }
          lastPublishError = null
          break
        }

        let details = ''
        try {
          details = (await pubRes.text()).slice(0, 1000)
        } catch {
          details = ''
        }
        lastPublishError =
          `Walrus publisher returned HTTP ${pubRes.status}` +
          (details ? `: ${details}` : '')

        if (!isRetryableStatus(pubRes.status)) break
      } catch (error) {
        lastPublishError =
          `Walrus publisher communication failed: ${safeMessage(error)}`
      }

      if (publishAttempts < maxPublishAttempts) {
        await sleep(delayForAttempt(retryDelaysMs, publishAttempts - 1))
      }
    }

    baseResult.publishAttempts = publishAttempts
    baseResult.publishLatencyMs = Date.now() - publishStartedAt

    if (!pubData || typeof pubData !== 'object') {
      baseResult.error = lastPublishError
      baseResult.totalLatencyMs = Date.now() - startedAt
      return baseResult
    }

    // 2. Extract identifiers from either publisher response shape.
    const blobId =
      pubData.newlyCreated?.blobObject?.blobId ||
      pubData.alreadyCertified?.blobId ||
      null
    const suiObjectId = pubData.newlyCreated?.blobObject?.id || null

    baseResult.publisherResponse = pubData
    baseResult.blobId = blobId
    baseResult.suiObjectId = suiObjectId
    baseResult.cost = pubData.newlyCreated?.cost || null
    baseResult.certifiedEpoch =
      pubData.newlyCreated?.blobObject?.registeredEpoch || null

    if (!blobId) {
      baseResult.writeStatus = 'accepted'
      baseResult.storageStatus = 'missing_blob_id'
      baseResult.error = 'Publisher response did not contain a blob ID.'
      baseResult.totalLatencyMs = Date.now() - startedAt
      return baseResult
    }

    const blobAggregatorUrl = `${aggregatorUrl}/v1/blobs/${blobId}`
    baseResult.aggregatorUrl = blobAggregatorUrl
    baseResult.writeStatus = 'accepted'
    baseResult.storageStatus = 'write_accepted_unverified'

    // 3. Verify with exact-byte read-back.
    const readbackStartedAt = Date.now()
    let lastReadbackError = null
    let readbackAttempts = 0

    for (let attempt = 0; attempt < maxReadbackAttempts; attempt++) {
      readbackAttempts = attempt + 1
      try {
        const readbackRes = await fetchFn(blobAggregatorUrl, {
          signal: AbortSignal.timeout(readbackTimeoutMs)
        })

        if (readbackRes.ok) {
          const retrievedPayload = await readbackRes.text()

          if (retrievedPayload === bodyText) {
            baseResult.storageVerified = true
            baseResult.storageStatus = 'verified_readback'
            baseResult.error = null
          } else {
            baseResult.storageStatus = 'readback_mismatch'
            baseResult.error =
              'Retrieved blob does not exactly match the uploaded payload.'
          }
          break
        }

        lastReadbackError =
          `Walrus read-back returned HTTP ${readbackRes.status}`

        if (readbackRes.status !== 404 && readbackRes.status < 500) break
      } catch (error) {
        lastReadbackError =
          `Walrus read-back failed: ${safeMessage(error)}`
      }

      if (attempt < maxReadbackAttempts - 1) {
        await sleep(delayForAttempt(retryDelaysMs, attempt))
      }
    }

    baseResult.readbackAttempts = readbackAttempts
    baseResult.readbackLatencyMs = Date.now() - readbackStartedAt

    if (!baseResult.storageVerified &&
        baseResult.storageStatus !== 'readback_mismatch') {
      baseResult.storageStatus = 'readback_failed'
      baseResult.error =
        lastReadbackError || 'Walrus read-back failed after retries.'
    }

    baseResult.totalLatencyMs = Date.now() - startedAt
    return baseResult
  } catch (error) {
    // Absolute fallback: never throw out of the helper.
    baseResult.error = `Walrus storage operation failed: ${safeMessage(error)}`
    baseResult.storageStatus = 'publish_failed'
    baseResult.totalLatencyMs = Date.now() - startedAt
    return baseResult
  }
}
