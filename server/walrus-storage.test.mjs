// Walrus publishAndVerify tests. All network I/O is mocked via fetchFn;
// no real publisher or aggregator traffic leaves the process.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { publishAndVerify } from './walrus-storage.mjs'

const PAYLOAD = JSON.stringify({ hello: 'walrus', n: 1 })

function jsonResponse({ status = 200, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () =>
      typeof body === 'string' ? body : JSON.stringify(body)
  }
}

function textResponse({ status = 200, text }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new Error('not json') },
    text: async () => text
  }
}

// Route PUT calls to a programmed publisher queue and GET calls to a
// programmed aggregator queue.
function mockFetch({ putQueue, getQueue }) {
  const calls = []
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' })
    if ((init.method || 'GET') === 'PUT') {
      const next = putQueue.shift()
      if (next instanceof Error) throw next
      return next
    }
    const next = getQueue.shift()
    if (next instanceof Error) throw next
    return next
  }
  return { fetchFn, calls }
}

const noRetry = { retryDelaysMs: [], maxReadbackAttempts: 3 }

describe('publishAndVerify', () => {
  it('verifies exact-byte read-back on success', async () => {
    const { fetchFn, calls } = mockFetch({
      putQueue: [
        jsonResponse({
          body: {
            newlyCreated: {
              blobObject: {
                blobId: 'blob-1',
                id: 'obj-1',
                registeredEpoch: 7
              },
              cost: 123
            }
          }
        })
      ],
      getQueue: [textResponse({ text: PAYLOAD })]
    })

    const result = await publishAndVerify(PAYLOAD, { fetchFn, ...noRetry })

    assert.equal(result.writeStatus, 'accepted')
    assert.equal(result.storageVerified, true)
    assert.equal(result.storageStatus, 'verified_readback')
    assert.equal(result.blobId, 'blob-1')
    assert.equal(result.suiObjectId, 'obj-1')
    assert.equal(result.cost, 123)
    assert.equal(result.certifiedEpoch, 7)
    assert.equal(result.publishAttempts, 1)
    assert.equal(result.readbackAttempts, 1)
    assert.equal(result.error, null)
    assert.ok(result.totalLatencyMs >= 0)
    assert.ok(result.publishLatencyMs >= 0)
    assert.ok(result.readbackLatencyMs >= 0)
    assert.equal(calls.length, 2)
  })

  it('reports publish_failed when the publisher is unreachable', async () => {
    const { fetchFn } = mockFetch({
      putQueue: [new Error('connect timeout'), new Error('connect timeout')],
      getQueue: []
    })

    const result = await publishAndVerify(PAYLOAD, {
      fetchFn,
      retryDelaysMs: [],
      maxPublishAttempts: 2
    })

    assert.equal(result.writeStatus, 'failed')
    assert.equal(result.storageVerified, false)
    assert.equal(result.storageStatus, 'publish_failed')
    assert.equal(result.publishAttempts, 2)
    assert.equal(result.readbackAttempts, 0)
    assert.equal(result.blobId, null)
    assert.equal(typeof result.error, 'string')
    assert.match(result.error, /publisher/i)
  })

  it('does not retry a non-retryable publisher rejection', async () => {
    const { fetchFn } = mockFetch({
      putQueue: [jsonResponse({ status: 400, body: { error: 'bad' } })],
      getQueue: []
    })

    const result = await publishAndVerify(PAYLOAD, {
      fetchFn,
      retryDelaysMs: []
    })

    assert.equal(result.storageStatus, 'publish_failed')
    assert.equal(result.publishAttempts, 1)
    assert.equal(result.publishHttpStatus, 400)
  })

  it('retries a transient publisher error then succeeds', async () => {
    const { fetchFn } = mockFetch({
      putQueue: [
        jsonResponse({ status: 503, body: 'busy' }),
        jsonResponse({
          body: { newlyCreated: { blobObject: { blobId: 'b2', id: 'o2' } } }
        })
      ],
      getQueue: [textResponse({ text: PAYLOAD })]
    })

    const result = await publishAndVerify(PAYLOAD, {
      fetchFn,
      retryDelaysMs: []
    })

    assert.equal(result.publishAttempts, 2)
    assert.equal(result.storageStatus, 'verified_readback')
    assert.equal(result.blobId, 'b2')
  })

  it('reports readback_failed when the aggregator stays unavailable', async () => {
    const { fetchFn } = mockFetch({
      putQueue: [
        jsonResponse({
          body: { newlyCreated: { blobObject: { blobId: 'b3', id: 'o3' } } }
        })
      ],
      getQueue: [
        textResponse({ status: 500, text: 'down' }),
        textResponse({ status: 500, text: 'down' }),
        new Error('socket reset')
      ]
    })

    const result = await publishAndVerify(PAYLOAD, {
      fetchFn,
      retryDelaysMs: [],
      maxReadbackAttempts: 3
    })

    assert.equal(result.writeStatus, 'accepted')
    assert.equal(result.storageVerified, false)
    assert.equal(result.storageStatus, 'readback_failed')
    assert.equal(result.readbackAttempts, 3)
    assert.equal(typeof result.error, 'string')
  })

  it('reports readback_mismatch on byte inequality', async () => {
    const { fetchFn } = mockFetch({
      putQueue: [
        jsonResponse({
          body: { newlyCreated: { blobObject: { blobId: 'b4', id: 'o4' } } }
        })
      ],
      getQueue: [textResponse({ text: `${PAYLOAD} ` })]
    })

    const result = await publishAndVerify(PAYLOAD, {
      fetchFn,
      ...noRetry
    })

    assert.equal(result.storageVerified, false)
    assert.equal(result.storageStatus, 'readback_mismatch')
    assert.equal(result.readbackAttempts, 1)
  })

  it('reports missing_blob_id when the publisher omits identifiers', async () => {
    const { fetchFn } = mockFetch({
      putQueue: [jsonResponse({ body: {} })],
      getQueue: [textResponse({ text: PAYLOAD })]
    })

    const result = await publishAndVerify(PAYLOAD, {
      fetchFn,
      ...noRetry
    })

    assert.equal(result.writeStatus, 'accepted')
    assert.equal(result.storageVerified, false)
    assert.equal(result.storageStatus, 'missing_blob_id')
    assert.equal(result.readbackAttempts, 0)
  })

  it('handles the already-certified publisher response shape', async () => {
    const { fetchFn } = mockFetch({
      putQueue: [jsonResponse({ body: { alreadyCertified: { blobId: 'b9' } } })],
      getQueue: [textResponse({ text: PAYLOAD })]
    })

    const result = await publishAndVerify(PAYLOAD, {
      fetchFn,
      ...noRetry
    })

    assert.equal(result.blobId, 'b9')
    assert.equal(result.suiObjectId, null)
    assert.equal(result.storageStatus, 'verified_readback')
    assert.equal(result.storageVerified, true)
  })

  it('never throws, even when fetch itself is broken', async () => {
    const result = await publishAndVerify(PAYLOAD, {
      fetchFn: async () => { throw new Error('boom') },
      retryDelaysMs: [],
      maxPublishAttempts: 1
    })

    assert.equal(result.storageStatus, 'publish_failed')
    assert.equal(result.storageVerified, false)
  })
})
