# RecallGuard

> Autonomous AI Research Agent with Persistent Memory & Verifiable Sui Blockchain Truth
> Built for the **Tatum × Walrus Total Recall Hackathon**

---

## 0. Judges' Guide — Explore & Test in 5 Minutes

Run it: `npm install && npm run dev`, then open `http://localhost:3000`.

1. **Landing page** → click **Enter Dashboard**. No login needed to look around.
2. **Dashboard tab** — check the Tatum Sui RPC and Walrus Memory status badges, plus live metrics (sessions, memories, verified facts). If API keys are not configured, badges honestly report `Not configured` instead of fake data.
3. **Research Workspace tab** — submit a question (e.g. "What is the current Sui reference gas price?"). Open the created session to see recalled memories, evaluated claims (`verified_fact` vs `unverified_claim` vs `ai_interpretation`), and the learning log when on-chain facts override earlier claims.
4. **Evidence Verification tab** — run a read-only Sui RPC call (try `sui_getLatestCheckpointSequenceNumber` or `suix_getReferenceGasPrice`). No wallet, no signing, no private keys.
5. **Memory Explorer tab** — search memories, filter by category, inspect a Walrus blob id.
6. **Learning Engine + Audit Timeline tabs** — see why conclusions changed and the full session → memory → decision provenance chain.
7. **memwal SDK tab** — the Walrus Memory Python SDK integration spec (`/api/recallguard/walrus/sdk-spec`).
8. **Writes need the demo passphrase**: research/memory/RPC writes return `AUTH_REQUIRED` until unlocked via the passphrase box in the dashboard header. Ask the host for the passphrase, or set your own locally with `RECALLGUARD_DEMO_PASSPHRASE=your-phrase` in `.env` before starting the server.
9. **API spot-checks** (no auth needed): `/api/recallguard/health`, `/api/recallguard/metrics`, `/api/recallguard/config-status`, `/api/recallguard/sessions`, `/api/recallguard/timeline`.
10. **Tests**: `npm test` (offline, scratch DB in `/tmp`) and `npm run typecheck`.

What to judge: memories persist across sessions (SQLite + Walrus blob ids), claims are verified against live Tatum Sui RPC rather than asserted, and belief revisions are logged with reasons — not silent edits.

---

## 1. Executive Summary

RecallGuard is a production-grade AI research engine that learns across iterative research sessions, preserves evidence in persistent decentralized memory, and dynamically refines its conclusions when verifiable on-chain facts contradict prior assumptions.

Unlike typical stateless AI agents that hallucinate or repeat obsolete claims, RecallGuard:

1. **Remembers** past claims, hypotheses, and evidence vectors using decentralized persistent memory specifications (compatible with the official Walrus Memory Python SDK `memwal`).
2. **Verifies** on-chain facts directly through Tatum's managed Sui JSON-RPC gateway without requesting wallet transactions or exposing private keys.
3. **Evolves transparently** through an empirical Learning Engine that logs epistemic shifts, explains why prior conclusions were superseded, and measures performance without fabricating metrics.

---

## 2. Architecture & Core Modules

```
                        ┌───────────────────────────────────────────────┐
                        │             RecallGuard Dashboard             │
                        │      (React + TypeScript + Tatum Design)      │
                        └──────────────────────┬────────────────────────┘
                                               │ /api/recallguard/*
                                               ▼
                        ┌───────────────────────────────────────────────┐
                        │               Express Server                  │
                        │       (server/routes/recallguard.mjs)         │
                        └──────┬────────────────────────────────┬───────┘
                               │                                │
                 Read-Only Sui │                                │ Persistent
                 JSON-RPC      ▼                                ▼ Memory Blobs
                  ┌─────────────────────────┐      ┌─────────────────────────┐
                  │    Tatum Gateway        │      │      Walrus Memory      │
                  │  (Sui Mainnet / Testnet)│      │  (memwal Python SDK /   │
                  │   sui_getLatest...      │      │   Aggregator RedStuff)  │
                  └─────────────────────────┘      └─────────────────────────┘
```

### Module Breakdown

- **Research Workspace**: User-facing inquiry cockpit. Runs semantic retrieval against past memories and evaluates claims categorized into:
  - `Verified Facts`: Cryptographically provable data anchored via Tatum Sui RPC.
  - `Unverified Claims`: Speculative or third-party web community assertions.
  - `AI-Generated Interpretations`: Epistemic inferences synthesized from recalled memories.
- **Persistent Memory Explorer**: Searchable memory index with categorical filtering, source references, reliability scores, and Walrus blob identifiers.
- **Evidence Verification (Tatum Sui RPC)**: Direct interactive read-only console executing standard Sui JSON-RPC methods (`sui_getLatestCheckpointSequenceNumber`, `suix_getReferenceGasPrice`, `sui_getObject`, etc.).
- **Learning Engine**: Auditable log of hypothesis adjustments and Bayesian-style belief revision, recording why stance changes occurred.
- **Audit Timeline**: End-to-end provenance visualizer tracing session inquiries, recalled memories, and state adjustments.

---

## 3. Walrus Memory Integration (`memwal`)

RecallGuard implements memory integration tailored for the official Walrus Memory Python SDK (`memwal`):

- **Data Redundancy**: 2D Reed-Solomon encoding (`RedStuff`) providing $3f + 1$ Byzantine fault tolerance.
- **Adapter Specs**: The server provides an interactive SDK inspection endpoint (`/api/recallguard/walrus/sdk-spec`) detailing the exact Python integration patterns for autonomous daemons.
- **Honest States**: If an external node or API key is not configured, RecallGuard displays explicit configuration notices rather than inventing falsified storage responses.

---

## 4. Getting Started

### Prerequisites

- Node.js 18+
- Tatum API Key (from [co.tatum.io](https://co.tatum.io))

### Setup Instructions

1. **Clone and Install Dependencies**:

   ```bash
   git clone <repo-url>
   cd recallguard
   npm install
   ```

2. **Configure Environment Variables** (all optional for a read-only look-around):

   Create a `.env` file in the project root (there is no `.env.example`; `.env` is gitignored):

   ```env
   TATUM_API_KEY=your_tatum_api_key_here
   META_API_KEY=your_meta_api_key_here
   RECALLGUARD_DEMO_PASSPHRASE=your-demo-phrase
   ```

   Without keys the app still runs — status badges report `Not configured` and AI/RPC features degrade gracefully instead of failing.

3. **Run the Application**:

   ```bash
   npm run dev
   # or node server/index.mjs
   ```

   Access the dashboard at `http://localhost:3000`.

---

## 5. Security & Read-Only Guarantees

- **No Private Key Ingestion**: RecallGuard enforces zero transaction signing and read-only Sui queries.
- **Credential Protection**: `TATUM_API_KEY` stays on the server side and is scrubbed by `credentialGuard` middleware before any response reaches the browser.
