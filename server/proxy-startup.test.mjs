// Server startup proxy order. The supported production entry point must
// install the proxy-aware fetch dispatcher before any route module (and
// thus before any Meta request) can load. Read-only source check: no
// imports of the server, no global side effects, no network traffic.
// Importing proxy-bootstrap itself in a unit test would mutate the global
// dispatcher for the whole test process, so the source order is asserted
// instead — the smallest safe check.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function sourceOf(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('server startup proxy order', () => {
  it('loads proxy-bootstrap before routes, guard, and credentials use', () => {
    const entry = sourceOf('./index.mjs')
    const lines = entry.split('\n')
    const at = (fragment) => lines.findIndex((line) => line.includes(fragment))
    const proxy = at('proxy-bootstrap')
    const recallguardRoutes = at('routes/recallguard')
    const tatumRoutes = at('routes/tatum')
    const guard = at('credential-guard')
    const creds = at('credentials-store')
    assert.ok(proxy !== -1, 'entry point imports proxy-bootstrap')
    assert.ok(recallguardRoutes !== -1 && tatumRoutes !== -1, 'entry point imports routes')
    assert.ok(proxy < recallguardRoutes, 'proxy installs before recallguard routes load')
    assert.ok(proxy < tatumRoutes, 'proxy installs before tatum routes load')
    assert.ok(proxy < guard && proxy < creds, 'proxy installs before guard/credentials load')
  })

  it('routes Meta and Walrus traffic through the global fetch dispatcher', () => {
    // Both helpers default to the global fetch, which is the dispatcher
    // proxy-bootstrap configures — no alternate transport by default.
    assert.ok(sourceOf('./meta-ai.mjs').includes('fetchFn = fetch'))
    assert.ok(sourceOf('./walrus-storage.mjs').includes('fetchFn = fetch'))
    const boot = sourceOf('./proxy-bootstrap.mjs')
    assert.ok(boot.includes('setGlobalDispatcher'), 'bootstrap installs a global dispatcher')
    assert.ok(boot.includes('Proxy'), 'dispatcher is proxy-aware')
  })
})
