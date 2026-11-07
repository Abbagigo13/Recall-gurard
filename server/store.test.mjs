// SQLite store tests. Databases live under /tmp only; the repository is
// never touched. Covers schema, seeding, provenance, restart persistence,
// transactions, backups, and the degraded memory fallback.
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync, mkdirSync, statSync, copyFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  initStore,
  SCHEMA_VERSION,
  PERSISTENCE_ERROR_CODE,
  PERSISTENCE_UNHEALTHY_CODE,
  publicPersistenceError
} from './store.mjs'

const BASE = `/tmp/rg-store-test-${process.pid}`
const DB_PATH = `${BASE}/recallguard.db`

const demoSessions = [
  {
    id: 'DEMO-TEST-SES-001',
    provenance: 'demo_seed',
    question: 'Demo question?',
    status: 'completed',
    createdAt: '2026-11-06T10:00:00.000Z',
    confidence: 0.9,
    confidenceStatus: 'measured',
    claims: [{ id: 'C1', text: 'demo', type: 'verified_fact' }],
    conclusion: 'demo conclusion',
    learningDelta: 'demo delta',
    recalledMemoryIds: []
  }
]

const demoMemories = [
  {
    id: 'DEMO-TEST-MEM-001',
    provenance: 'demo_seed',
    category: 'protocol_spec',
    title: 'Demo memory',
    content: 'Demo content',
    sourceReference: 'Demo source',
    walrusBlobId: 'demo_blob',
    createdAt: '2026-11-06T10:00:00.000Z',
    status: 'active',
    reliabilityScore: 0.9,
    storageVerified: false
  }
]

const demoDecisions = [
  {
    id: 'DEMO-TEST-DEC-001',
    provenance: 'demo_seed',
    topic: 'Demo topic',
    previousSessionId: 'DEMO-TEST-SES-001',
    currentSessionId: 'DEMO-TEST-SES-001',
    priorClaim: 'old',
    newClaim: 'new',
    changeReason: 'demo',
    impact: 'demo',
    timestamp: '2026-11-06T10:00:00.000Z'
  }
]

function liveSession(id) {
  return {
    id,
    provenance: 'live_production',
    question: `Live question ${id}?`,
    status: 'completed',
    createdAt: new Date().toISOString(),
    confidence: null,
    confidenceStatus: 'not_measured',
    researchPlan: { capability: 'sui_checkpoint_status' },
    onChainSuiData: {
      network: 'sui-mainnet',
      operation: 'checkpoint_status',
      checkpointSequence: '100',
      retrievedAt: new Date().toISOString(),
      evidenceStatus: 'retrieved_from_tatum',
      cryptographicallyVerified: false
    },
    recalledMemoryIds: [],
    claims: [],
    conclusion: `Conclusion ${id}`,
    learningDelta: 'none yet'
  }
}

before(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
})

describe('sqlite store', () => {
  it('initializes schema with version metadata', () => {
    const { store } = initStore({
      dbPath: DB_PATH,
      sessions: demoSessions,
      memories: demoMemories,
      decisions: demoDecisions
    })
    assert.equal(store.mode, 'sqlite')
    assert.equal(store.persistent, true)
    assert.equal(store.getStatus().schemaVersion, SCHEMA_VERSION)

    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name)
    for (const expected of [
      'research_sessions', 'memories', 'decisions',
      'revision_candidates', 'evidence_records', 'audit_events',
      'schema_meta'
    ]) {
      assert.ok(tables.includes(expected), `missing table ${expected}`)
    }
    const version = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get()
    assert.equal(version.value, String(SCHEMA_VERSION))
    db.close()
    store.close()
  })

  it('seeds demo data once without duplicates', () => {
    const first = initStore({
      dbPath: DB_PATH,
      sessions: demoSessions,
      memories: demoMemories,
      decisions: demoDecisions
    })
    first.store.close()

    const second = initStore({
      dbPath: DB_PATH,
      sessions: demoSessions,
      memories: demoMemories,
      decisions: demoDecisions
    })
    assert.equal(
      second.sessions.filter((s) => s.provenance === 'demo_seed').length,
      demoSessions.length
    )
    assert.equal(
      second.memories.filter((m) => m.provenance === 'demo_seed').length,
      demoMemories.length
    )
    assert.equal(second.decisions.length, demoDecisions.length)
    second.store.close()
  })

  it('persists sessions with evidence and audit in one transaction', () => {
    const { store } = initStore({
      dbPath: DB_PATH,
      sessions: demoSessions,
      memories: demoMemories,
      decisions: demoDecisions
    })
    assert.equal(store.persistSession(liveSession('SES-RT-001')), true)

    const live = store.listSessions('live_production')
    assert.equal(live.length, 1)
    assert.equal(live[0].question, 'Live question SES-RT-001?')
    assert.equal(live[0].onChainSuiData.checkpointSequence, '100')

    const evidence = store.listEvidence('SES-RT-001')
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0].capability, 'sui_checkpoint_status')

    const audits = store.listAudit(1000).filter((a) => a.entity_id === 'SES-RT-001')
    assert.equal(audits.length, 1)
    assert.equal(audits[0].action, 'session.created')
    store.close()
  })

  it('keeps demo and live provenance strictly separated', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    const liveSessions = store.listSessions('live_production')
    assert.ok(liveSessions.length >= 1)
    assert.ok(liveSessions.every((s) => s.provenance === 'live_production'))
    const demoSessionsListed = store.listSessions('demo_seed')
    assert.ok(demoSessionsListed.every((s) => s.provenance === 'demo_seed'))
    const liveMemories = store.listMemories({ provenance: 'live_production' })
    assert.ok(liveMemories.every((m) => m.provenance === 'live_production'))
    store.close()
  })

  it('rolls back related writes when the primary insert fails', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    const before = store.listSessions('all').length
    const auditsBefore = store.listAudit(100000).length

    // NULL question violates NOT NULL: the whole transaction must roll back.
    const bad = { ...liveSession('SES-RT-BAD'), question: null }
    assert.equal(store.persistSession(bad), false)
    assert.equal(store.listSessions('all').length, before)
    assert.equal(store.listEvidence('SES-RT-BAD').length, 0)
    assert.equal(store.listAudit(100000).length, auditsBefore)
    assert.equal(store.getStatus().lastError, 'PERSISTENCE_UNAVAILABLE')
    store.close()
  })

  it('persists memories, candidates and decisions distinctly', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    // Candidate foreign keys require both referenced sessions to exist.
    assert.equal(store.persistSession(liveSession('SES-RT-CAND-A')), true)
    assert.equal(store.persistSession(liveSession('SES-RT-CAND-B')), true)
    assert.equal(store.persistMemory({
      id: 'MEM-RT-001',
      provenance: 'live_production',
      category: 'on_chain_observation',
      title: 'Live memory',
      content: 'content',
      createdAt: new Date().toISOString(),
      status: 'active',
      storageVerified: true,
      storageStatus: 'verified_readback'
    }), true)

    const candidate = {
      id: 'CAND-RT-001',
      candidateType: 'evidence_change_candidate',
      status: 'pending_verification',
      verificationStatus: 'pending_independent_verification',
      provenance: 'live_production',
      capability: 'sui_chain_identifier',
      previousSessionId: 'SES-RT-CAND-A',
      currentSessionId: 'SES-RT-CAND-B',
      previousValue: 'a',
      currentValue: 'b',
      sourceEvidence: { network: 'sui-mainnet', cryptographicallyVerified: false },
      reason: 'test',
      createdAt: new Date().toISOString()
    }
    assert.equal(store.persistCandidate(candidate), true)

    // Candidates never appear in the committed-decisions list.
    assert.ok(store.listCandidates().some((c) => c.id === 'CAND-RT-001'))
    assert.ok(store.listDecisions('all').every((d) => d.id !== 'CAND-RT-001'))
    assert.equal(
      store.listMemories({ provenance: 'live_production' })
        .find((m) => m.id === 'MEM-RT-001').storageStatus,
      'verified_readback'
    )

    // Candidate lifecycle stays explicit.
    assert.equal(store.resolveCandidate('CAND-RT-001', 'verified by re-fetch'), true)
    assert.equal(store.resolveCandidate('CAND-RT-001', 'again'), false)
    store.close()
  })

  it('survives a close/reopen restart with data intact', () => {
    const first = initStore({ dbPath: DB_PATH })
    assert.equal(first.store.persistSession(liveSession('SES-RT-RESTART')), true)
    first.store.close()

    const second = initStore({ dbPath: DB_PATH })
    const found = second.store.listSessions('live_production')
      .find((s) => s.id === 'SES-RT-RESTART')
    assert.ok(found)
    assert.equal(found.conclusion, 'Conclusion SES-RT-RESTART')
    assert.equal(second.store.listEvidence('SES-RT-RESTART').length, 1)
    assert.ok(second.store.listCandidates('all').length >= 1)
    second.store.close()
  })

  it('creates a verified local backup snapshot', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    const { path: backupPath, bytes } = store.backupDatabase(`${BASE}/backups`)
    assert.ok(existsSync(backupPath))
    assert.ok(bytes > 0)

    const backup = new DatabaseSync(backupPath, { readOnly: true })
    const count = backup
      .prepare('SELECT COUNT(*) AS n FROM research_sessions')
      .get()
    const live = new DatabaseSync(DB_PATH, { readOnly: true })
    const liveCount = live
      .prepare('SELECT COUNT(*) AS n FROM research_sessions')
      .get()
    assert.equal(count.n, liveCount.n)
    assert.ok(count.n >= 1)
    backup.close()
    live.close()
    store.close()

    assert.ok(statSync(backupPath).size > 0)
  })

  it('degrades to explicit memory mode when forced', () => {
    const { store, sessions } = initStore({ forceMemory: true, sessions: demoSessions })
    assert.equal(store.mode, 'memory')
    assert.equal(store.persistent, false)
    assert.equal(store.persistSession(liveSession('X')), false)
    assert.deepEqual(store.listSessions(), [])
    assert.deepEqual(sessions, demoSessions)
    assert.match(store.getStatus().reason, /Memory mode/)
  })

  it('degrades to memory mode when the path cannot be opened', () => {
    const { store, memories } = initStore({
      dbPath: '/tmp/\0invalid-path.db',
      memories: demoMemories
    })
    assert.equal(store.mode, 'memory')
    assert.equal(store.persistent, false)
    assert.deepEqual(memories, demoMemories)
  })

  it('rejects candidates that reference nonexistent sessions', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    const bad = {
      id: 'CAND-RT-BADFK',
      candidateType: 'evidence_change_candidate',
      status: 'pending_verification',
      provenance: 'live_production',
      previousSessionId: 'SES-DOES-NOT-EXIST',
      currentSessionId: 'SES-ALSO-MISSING',
      createdAt: new Date().toISOString()
    }
    assert.equal(store.persistCandidate(bad), false)
    assert.ok(!store.listCandidates('all').some((c) => c.id === 'CAND-RT-BADFK'))
    assert.equal(store.getStatus().lastError, 'PERSISTENCE_UNAVAILABLE')
    store.close()
  })

  it('refuses to delete sessions that still have evidence or candidates', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    assert.equal(store.persistSession(liveSession('SES-RT-GUARDED')), true)
    store.close()

    // Foreign keys are enforced per connection, so enable them here too.
    const raw = new DatabaseSync(DB_PATH)
    raw.exec('PRAGMA foreign_keys = ON')
    assert.throws(
      () => raw.prepare("DELETE FROM research_sessions WHERE id = 'SES-RT-GUARDED'").run(),
      /FOREIGN KEY/i
    )
    raw.close()
  })

  it('keeps audit_events append-only at the database level', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    assert.equal(store.persistSession(liveSession('SES-RT-AUDIT')), true)
    store.close()

    const raw = new DatabaseSync(DB_PATH)
    const triggers = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_events'")
      .all()
      .map((r) => r.name)
    assert.ok(triggers.includes('trg_audit_events_no_update'))
    assert.ok(triggers.includes('trg_audit_events_no_delete'))

    // Plain INSERT still works.
    raw.prepare(
      "INSERT INTO audit_events (actor, action, entity_type, created_at) VALUES ('test', 'probe', 'database', ?)"
    ).run(new Date().toISOString())

    const target = raw
      .prepare("SELECT id FROM audit_events WHERE actor = 'test'")
      .get()
    assert.throws(
      () => raw.prepare('UPDATE audit_events SET actor = ? WHERE id = ?').run('mutant', target.id),
      /append-only/
    )
    assert.throws(
      () => raw.prepare('DELETE FROM audit_events WHERE id = ?').run(target.id),
      /append-only/
    )
    raw.close()
  })

  it('restores a backup into a working database', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    assert.equal(store.persistSession(liveSession('SES-RT-BEFORE-BACKUP')), true)
    const { path: backupPath } = store.backupDatabase(`${BASE}/backups`)
    store.close()

    // Simulate a restore: copy the snapshot to a live path and open it.
    const restorePath = `${BASE}/restored.db`
    rmSync(restorePath, { force: true })
    copyFileSync(backupPath, restorePath)

    const revived = initStore({ dbPath: restorePath })
    const found = revived.store.listSessions('live_production')
      .find((s) => s.id === 'SES-RT-BEFORE-BACKUP')
    assert.ok(found)
    assert.equal(found.conclusion, 'Conclusion SES-RT-BEFORE-BACKUP')
    assert.equal(revived.store.listEvidence('SES-RT-BEFORE-BACKUP').length, 1)

    // The restored database accepts new writes and reads them back.
    assert.equal(revived.store.persistSession(liveSession('SES-RT-AFTER-RESTORE')), true)
    const reread = revived.store.listSessions('live_production')
      .find((s) => s.id === 'SES-RT-AFTER-RESTORE')
    assert.ok(reread)
    assert.equal(reread.conclusion, 'Conclusion SES-RT-AFTER-RESTORE')
    revived.store.close()
  })

  it('migrates a genuine complete v1 database to v2 without touching data', () => {
    const v1Path = `${BASE}/v1.db`
    rmSync(v1Path, { force: true })
    const setup = new DatabaseSync(v1Path)
    // Faithful v1 layout: every Phase 3 table, no ai_analyses.
    setup.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    setup.exec("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')")
    setup.exec(`CREATE TABLE research_sessions (
      id TEXT PRIMARY KEY,
      provenance TEXT NOT NULL CHECK (provenance IN ('demo_seed', 'live_production')),
      question TEXT NOT NULL,
      network TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confidence REAL,
      confidence_status TEXT,
      research_plan_json TEXT,
      onchain_data_json TEXT,
      recalled_memory_ids_json TEXT,
      claims_json TEXT,
      conclusion TEXT,
      learning_delta TEXT,
      evidence_comparison_json TEXT,
      revision_candidate_json TEXT
    )`)
    setup.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      provenance TEXT NOT NULL CHECK (provenance IN ('demo_seed', 'live_production')),
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_reference TEXT,
      walrus_blob_id TEXT,
      walrus_sui_object_id TEXT,
      walrus_aggregator_url TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      superseded_by TEXT,
      reliability_score REAL,
      confidence REAL,
      confidence_status TEXT,
      storage_verified INTEGER NOT NULL DEFAULT 0,
      storage_status TEXT
    )`)
    setup.exec(`CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      provenance TEXT NOT NULL CHECK (provenance IN ('demo_seed', 'live_production')),
      topic TEXT NOT NULL,
      previous_session_id TEXT,
      current_session_id TEXT,
      prior_claim TEXT,
      new_claim TEXT,
      change_reason TEXT,
      impact TEXT,
      created_at TEXT NOT NULL
    )`)
    setup.exec(`CREATE TABLE revision_candidates (
      id TEXT PRIMARY KEY,
      candidate_type TEXT NOT NULL DEFAULT 'evidence_change_candidate',
      status TEXT NOT NULL DEFAULT 'pending_verification',
      verification_status TEXT,
      provenance TEXT NOT NULL CHECK (provenance IN ('demo_seed', 'live_production')),
      capability TEXT,
      previous_session_id TEXT,
      current_session_id TEXT,
      previous_value TEXT,
      current_value TEXT,
      source_evidence_json TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT,
      FOREIGN KEY (previous_session_id) REFERENCES research_sessions (id) ON DELETE RESTRICT,
      FOREIGN KEY (current_session_id) REFERENCES research_sessions (id) ON DELETE RESTRICT
    )`)
    setup.exec(`CREATE TABLE evidence_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES research_sessions (id) ON DELETE RESTRICT,
      capability TEXT,
      network TEXT,
      evidence_status TEXT,
      retrieved_at TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    )`)
    setup.exec(`CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      provenance TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    )`)
    setup.exec(`CREATE TRIGGER trg_audit_events_no_update
      BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE rejected'); END`)
    setup.exec(`CREATE TRIGGER trg_audit_events_no_delete
      BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit_events is append-only: DELETE rejected'); END`)
    const T = '2026-11-06T10:00:00.000Z'
    setup.exec(`INSERT INTO research_sessions (id, provenance, question, network, status, created_at, conclusion)
      VALUES ('SES-V1-A', 'live_production', 'Legacy question A?', 'sui-mainnet', 'completed', '${T}', 'done A'),
             ('SES-V1-B', 'live_production', 'Legacy question B?', 'sui-mainnet', 'completed', '${T}', 'done B')`)
    setup.exec(`INSERT INTO memories (id, provenance, category, title, content, created_at, status, storage_verified)
      VALUES ('MEM-V1-001', 'live_production', 'on_chain_observation', 'Legacy memory', 'content', '${T}', 'active', 1)`)
    setup.exec(`INSERT INTO decisions (id, provenance, topic, previous_session_id, current_session_id, created_at)
      VALUES ('DEC-V1-001', 'live_production', 'Legacy topic', 'SES-V1-A', 'SES-V1-B', '${T}')`)
    setup.exec(`INSERT INTO revision_candidates (id, provenance, previous_session_id, current_session_id, created_at)
      VALUES ('CAND-V1-001', 'live_production', 'SES-V1-A', 'SES-V1-B', '${T}')`)
    setup.exec(`INSERT INTO evidence_records (session_id, capability, network, created_at)
      VALUES ('SES-V1-A', 'sui_checkpoint_status', 'sui-mainnet', '${T}')`)
    setup.exec(`INSERT INTO audit_events (actor, action, entity_type, entity_id, provenance, created_at)
      VALUES ('legacy-test', 'session.created', 'research_session', 'SES-V1-A', 'live_production', '${T}')`)
    setup.close()

    const revived = initStore({ dbPath: v1Path })
    assert.equal(revived.store.getStatus().schemaVersion, 2)

    // Every record and relationship survives the additive migration.
    const sessions = revived.store.listSessions('live_production')
    assert.equal(sessions.length, 2)
    assert.ok(sessions.some((s) => s.id === 'SES-V1-A' && s.question === 'Legacy question A?'))
    assert.equal(revived.store.listMemories({ provenance: 'live_production' }).length, 1)
    assert.equal(revived.store.listDecisions('live_production').length, 1)
    const candidates = revived.store.listCandidates('all')
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].previousSessionId, 'SES-V1-A')
    assert.equal(candidates[0].currentSessionId, 'SES-V1-B')
    assert.equal(revived.store.listEvidence('SES-V1-A').length, 1)
    assert.ok(revived.store.listAudit(100000).some((a) => a.entity_id === 'SES-V1-A'))

    // Foreign keys still enforced after migration.
    const raw = new DatabaseSync(v1Path)
    raw.exec('PRAGMA foreign_keys = ON')
    assert.throws(
      () => raw.prepare("DELETE FROM research_sessions WHERE id = 'SES-V1-A'").run(),
      /FOREIGN KEY/i
    )
    // Append-only audit triggers still enforced after migration.
    assert.throws(
      () => raw.prepare('DELETE FROM audit_events WHERE entity_id = ?').run('SES-V1-A'),
      /append-only/
    )
    raw.close()

    // The new table is available immediately after migration.
    assert.equal(revived.store.persistAiAnalysis({
      id: 'AI-SES-V1-A', sessionId: 'SES-V1-A', model: 'muse-spark-1.3',
      provider: 'meta', promptVersion: '1.0.0', status: 'completed',
      analysis: { interpretation: 'migrated' }
    }), true)
    revived.store.close()

    // Re-init is idempotent and stays on v2 with data intact.
    const again = initStore({ dbPath: v1Path })
    assert.equal(again.store.getStatus().schemaVersion, 2)
    assert.equal(again.store.listSessions('live_production').length, 2)
    assert.equal(again.store.listAiAnalysisBySession('SES-V1-A').length, 1)
    again.store.close()
  })

  it('persists AI analyses linked to their session', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    assert.equal(store.persistSession(liveSession('SES-RT-AI-001')), true)
    assert.equal(store.persistAiAnalysis({
      id: 'AI-SES-RT-AI-001', sessionId: 'SES-RT-AI-001', model: 'muse-spark-1.3',
      provider: 'meta', promptVersion: '1.0.0', status: 'completed',
      analysis: {
        subQuestions: ['q?'], interpretation: 'ok', contradictions: [],
        uncertainties: [], evidenceGaps: [], confidenceNote: 'n'
      },
      latencyMs: 42, errorCode: null
    }), true)
    const rows = store.listAiAnalysisBySession('SES-RT-AI-001')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].model, 'muse-spark-1.3')
    assert.equal(rows[0].provider, 'meta')
    assert.equal(rows[0].promptVersion, '1.0.0')
    assert.equal(rows[0].status, 'completed')
    assert.equal(rows[0].analysis.interpretation, 'ok')
    assert.equal(rows[0].latencyMs, 42)
    const audits = store.listAudit(100000).filter((a) => a.entity_id === 'AI-SES-RT-AI-001')
    assert.equal(audits.length, 1)
    assert.equal(audits[0].action, 'ai_analysis.created')
    store.close()
  })

  it('rejects AI analyses that reference nonexistent sessions', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    assert.equal(store.persistAiAnalysis({
      id: 'AI-NOPE', sessionId: 'SES-DOES-NOT-EXIST', model: 'muse-spark-1.3',
      provider: 'meta', promptVersion: '1.0.0', status: 'completed', analysis: {}
    }), false)
    assert.equal(store.listAiAnalysisBySession('SES-DOES-NOT-EXIST').length, 0)
    assert.equal(store.getStatus().lastError, 'PERSISTENCE_UNAVAILABLE')
    store.close()
  })

  it('persists unavailable and invalid attempts with stable codes only', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    assert.equal(store.persistSession(liveSession('SES-RT-AI-FAIL')), true)
    assert.equal(store.persistAiAnalysis({
      id: 'AI-SES-RT-AI-FAIL', sessionId: 'SES-RT-AI-FAIL', model: 'unknown',
      provider: 'meta', promptVersion: '1.0.0', status: 'unavailable',
      analysis: null, latencyMs: null, errorCode: 'META_AI_UNAVAILABLE'
    }), true)
    const rows = store.listAiAnalysisBySession('SES-RT-AI-FAIL')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'unavailable')
    assert.equal(rows[0].model, 'unknown')
    assert.equal(rows[0].analysis, null)
    assert.equal(rows[0].errorCode, 'META_AI_UNAVAILABLE')
    const audits = store.listAudit(100000).filter((a) => a.entity_id === 'AI-SES-RT-AI-FAIL')
    assert.equal(audits.length, 1)
    assert.equal(audits[0].action, 'ai_analysis.created')
    store.close()
  })

  it('keeps one AI analysis per session across retries', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    assert.equal(store.persistSession(liveSession('SES-RT-AI-DUP')), true)
    const record = (id) => ({
      id, sessionId: 'SES-RT-AI-DUP', model: 'muse-spark-1.3', provider: 'meta',
      promptVersion: '1.0.0', status: 'completed', analysis: {}
    })
    assert.equal(store.persistAiAnalysis(record('AI-DUP-1')), true)
    assert.equal(store.persistAiAnalysis(record('AI-DUP-2')), false)
    assert.equal(store.listAiAnalysisBySession('SES-RT-AI-DUP').length, 1)
    store.close()
  })

  it('disables AI analysis writes when the store is unhealthy', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    store.markUnhealthy('test')
    assert.equal(store.persistAiAnalysis({
      id: 'AI-X', sessionId: 'SES-RT-AI-001', model: 'm', provider: 'meta',
      promptVersion: '1.0.0', status: 'completed', analysis: {}
    }), false)
    store.close()
  })

  it('rejects unsupported future schema versions without hiding data', () => {
    const futurePath = `${BASE}/future.db`
    rmSync(futurePath, { force: true })
    const setup = new DatabaseSync(futurePath)
    setup.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    setup.exec("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '999')")
    setup.exec('CREATE TABLE marker (id TEXT PRIMARY KEY)')
    setup.exec("INSERT INTO marker (id) VALUES ('original-data')")
    setup.close()

    assert.throws(
      () => initStore({ dbPath: futurePath }),
      /Unsupported database schema version 999/
    )

    // The existing database is untouched: version and data still intact.
    const check = new DatabaseSync(futurePath, { readOnly: true })
    assert.equal(
      check.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value,
      '999'
    )
    assert.equal(check.prepare('SELECT id FROM marker').get().id, 'original-data')
    check.close()
  })

  it('persists session and candidate atomically or not at all', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    const auditsBefore = store.listAudit(100000).length

    const session = liveSession('SES-RT-ATOMIC')
    const badCandidate = {
      id: 'CAND-RT-ATOMIC-BAD',
      candidateType: 'evidence_change_candidate',
      status: 'pending_verification',
      provenance: 'live_production',
      // SES-RT-ATOMIC will exist mid-transaction, but this one never will,
      // so the foreign key fails and the whole transaction must roll back.
      previousSessionId: 'SES-NEVER-EXISTS',
      currentSessionId: 'SES-RT-ATOMIC',
      createdAt: new Date().toISOString()
    }
    assert.equal(store.persistSessionWithCandidate(session, badCandidate), false)
    assert.ok(!store.listSessions('all').some((s) => s.id === 'SES-RT-ATOMIC'))
    assert.equal(store.listEvidence('SES-RT-ATOMIC').length, 0)
    assert.ok(!store.listCandidates('all').some((c) => c.id === 'CAND-RT-ATOMIC-BAD'))
    assert.equal(store.listAudit(100000).length, auditsBefore)

    const goodCandidate = {
      ...badCandidate,
      id: 'CAND-RT-ATOMIC-GOOD',
      previousSessionId: 'SES-RT-CAND-A',
      currentSessionId: 'SES-RT-ATOMIC'
    }
    assert.equal(store.persistSessionWithCandidate(session, goodCandidate), true)
    assert.ok(store.listSessions('all').some((s) => s.id === 'SES-RT-ATOMIC'))
    assert.equal(store.listEvidence('SES-RT-ATOMIC').length, 1)
    assert.ok(store.listCandidates('all').some((c) => c.id === 'CAND-RT-ATOMIC-GOOD'))
    store.close()
  })

  it('exposes only stable public error codes, never raw driver detail', () => {
    assert.equal(PERSISTENCE_ERROR_CODE, 'PERSISTENCE_UNAVAILABLE')
    assert.deepEqual(publicPersistenceError('research session'), {
      error: 'Failed to persist research session',
      code: 'PERSISTENCE_UNAVAILABLE'
    })
    assert.deepEqual(publicPersistenceError('memory record'), {
      error: 'Failed to persist memory record',
      code: 'PERSISTENCE_UNAVAILABLE'
    })

    const { store } = initStore({ dbPath: DB_PATH })
    // Force a real driver failure, then prove nothing raw leaks publicly.
    assert.equal(store.persistSession({ ...liveSession('SES-RT-LEAK'), question: null }), false)
    const status = store.getStatus()
    assert.equal(status.lastError, 'PERSISTENCE_UNAVAILABLE')
    const serialized = JSON.stringify(status)
    assert.ok(!serialized.includes('constraint failed'))
    assert.ok(!serialized.includes('research_sessions'))
    assert.ok(!serialized.includes('NOT NULL'))
    store.close()
  })

  it('marks the store unhealthy on rollback failure and disables writes', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    assert.equal(store.healthy, true)
    // Exercises the exact callback runTransaction invokes when ROLLBACK fails.
    store.onRollbackFailure(new Error('simulated rollback I/O error'))
    assert.equal(store.healthy, false)
    assert.equal(store.persistSession(liveSession('SES-RT-NOPE')), false)
    assert.equal(store.persistMemory({
      id: 'MEM-RT-NOPE',
      provenance: 'live_production',
      category: 'epistemic_stance',
      title: 'nope',
      content: 'nope',
      createdAt: new Date().toISOString(),
      status: 'active'
    }), false)
    const status = store.getStatus()
    assert.equal(status.lastError, PERSISTENCE_UNHEALTHY_CODE)
    assert.match(status.reason, /unhealthy/)
    // The raw simulated detail is logged server-side, never in the status.
    assert.ok(!JSON.stringify(status).includes('simulated rollback I/O error'))
    store.close()
  })

  it('keeps filesystem paths and OS errors out of public persistence status', () => {
    const forced = initStore({ forceMemory: true })
    assert.ok(!JSON.stringify(forced.store.getStatus()).includes('/'))

    const degraded = initStore({ dbPath: '/tmp/\0invalid-path.db' })
    const serialized = JSON.stringify(degraded.store.getStatus())
    assert.ok(!serialized.includes('tmp'))
    assert.ok(!serialized.includes('ENOENT'))
    assert.ok(!serialized.includes('invalid-path'))
    assert.match(degraded.store.getStatus().reason, /degraded memory mode/)
  })

  it('never exposes the database path in the public persistence status', () => {
    const { store } = initStore({ dbPath: DB_PATH })
    // Internal path stays available for diagnostics and backup operations.
    assert.ok(typeof store.dbPath === 'string' && store.dbPath.length > 0)
    // Public status carries no filesystem path.
    const status = store.getStatus()
    assert.equal(status.dbPath, null)
    const serialized = JSON.stringify(status)
    assert.ok(!serialized.includes(store.dbPath))
    assert.ok(!serialized.includes('/tmp/'))
    assert.ok(!serialized.includes('recallguard.db'))
    store.close()
  })
})
