// Test: Verify that Tatum Sui RPC HTTP errors are handled safely and NEVER reported as verified facts
import { describe, it } from 'node:test'
import assert from 'node:assert'

describe('Tatum Sui RPC Error Handling Guarantee', () => {
  it('should mark HTTP 404 responses as isVerifiedFact: false and not fabricate on-chain data', async () => {
    const res = await fetch('http://localhost:3000/api/recallguard/sui/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'sui_getChainIdentifier',
        params: [],
        network: 'mainnet'
      })
    })

    const data = await res.json()
    assert.strictEqual(res.status, 404, 'Response status should mirror gateway 404 status')
    assert.strictEqual(data.isVerifiedFact, false, 'Failed RPC calls must NEVER be marked as verified facts')
    assert.ok(data.diagnostics, 'Diagnostics explanation should be provided')
    assert.strictEqual(data.diagnostics.issue, 'Gateway endpoint returned HTTP 404 Not Found')
    assert.ok(data.diagnostics.resolution, 'Resolution notes should be provided')
    assert.strictEqual(typeof data.response, 'object', 'Sanitized response must be captured')
  })

  it('should return safe diagnostics showing root cause without exposing secrets', async () => {
    const res = await fetch('http://localhost:3000/api/recallguard/sui/diagnostics')
    assert.strictEqual(res.status, 200)
    const data = await res.json()
    
    assert.strictEqual(data.apiKeyConfigured, true)
    assert.ok(Array.isArray(data.suiGatewayDiagnostics))
    assert.ok(data.rootCauseSummary)
    
    // Ensure no API keys or credentials leaked into JSON
    const text = JSON.stringify(data)
    assert.ok(!text.includes(process.env.TATUM_API_KEY || 'SECRET_KEY_NOT_IN_STRING'), 'Secrets must never be in responses')
  })

  it('should refuse mutative or private-key transaction methods', async () => {
    const res = await fetch('http://localhost:3000/api/recallguard/sui/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'unsafe_transferSui',
        params: ['0x1', '0x2', '1000', '0x3']
      })
    })

    assert.strictEqual(res.status, 403)
    const data = await res.json()
    assert.strictEqual(data.isVerifiedFact, false)
    assert.ok(data.error.includes('read-only'))
  })
})
