# RecallGuard Railway → Render Migration Runbook

Target: Render Web Service, Oregon, Node runtime, single instance, persistent
disk `recallguard-data` at `/data`, SQLite at `/data/recallguard.db`.

Source of truth for service shape: [render.yaml](../render.yaml) (no secrets
in source; every credential is dashboard-supplied).

## 0. Preconditions (already verified, do not repeat writes)

- GitHub `main` contains the approved migration base. Deploy exactly the
  approved commit; do not deploy an unreviewed tip.
- Local gates green: `npm run typecheck`, `npm test` (204/204), `npm run build`.
- Railway production is healthy (readiness READY, schema v2). Record its
  counts now via safe GETs for later comparison:
  - `GET /api/recallguard/health` → `counts` (sessions, memories, live/demo split)
  - `GET /api/recallguard/sessions` → session IDs
  - `GET /api/recallguard/memories` → memory IDs

## 1. Create the Render service

1. Render dashboard → New → Web Service → connect `Abbagigo13/Recall-gurard`, branch `main`, the approved commit.
2. Runtime Node, region Oregon, instance type Starter or higher (paid tiers
   are required for persistent disks), **instances = 1**. Single instance is
   mandatory: demo-auth sessions are in-memory and SQLite is a local file
   (`server/demo-auth.mjs`, `server/store.mjs`).
3. Build command: `npm install && npm run build`. Start command: `node server/index.mjs`.
4. Health check path: `/api/recallguard/health/ready`.

## 2. Attach the persistent disk (before first deploy)

Disks Tab → Add Disk: name `recallguard-data`, mount path `/data`, size 1 GB.
The app resolves `RECALLGUARD_DB_PATH=/data/recallguard.db` (see §4). Deploying
without the disk drops the store into non-persistent memory mode — do not run
live traffic in that state.

## 3. Environment variables (dashboard only, never in source)

| Key | Value / source |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22` (node:sqlite requires Node 22.5+) |
| `RECALLGUARD_DB_PATH` | `/data/recallguard.db` |
| `QWEN_API_BASE` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| `QWEN_MODEL` | `qwen3.8-flash` |
| `QWEN_RESPONSE_FORMAT` | `json_schema` |
| `META_MODEL` | `muse-spark-1.3` |
| `META_API_BASE` | Meta default (leave unset unless the account needs it) |
| `TATUM_API_KEY` | copy from Railway (secret) |
| `DASHSCOPE_API_KEY` | new secret |
| `META_API_KEY` | copy from Railway (secret) |
| `RECALLGUARD_DEMO_PASSPHRASE` | copy from Railway (secret) |

Do NOT set `CREDS_PATH`, `HTTP_PROXY`, `HTTPS_PROXY`, or `PORT` (Render
provides `PORT`; proxy vars must stay unset so outbound traffic is direct).
Do NOT change these Railway variables — copy values out, leave Railway intact.

## 4. Database migration (manual — Railway is unreachable from automation)

No database work has been performed. Do not let the app boot against an empty
`/data/recallguard.db` and then copy over it: confirm placement BEFORE first
startup (step 5 order matters).

1. **Quiesce Railway** (dashboard → Suspend service) so the backup is consistent.
2. **Shell into Railway** (service Shell tab) and run, with values substituted:
   - `node -e` script using `initStore({ dbPath: '/data/recallguard.db' })` →
     `backupDatabase('/data/backups')` (supported `VACUUM INTO` snapshot), then
     `sqlite3 <snapshot> 'PRAGMA integrity_check;'` must print `ok`.
   - Record counts: sessions, memories, audit rows; note schema (`schema_meta` = 2).
3. **Transfer**: download the snapshot from the Railway shell session to a
   workstation, then upload to the Render disk via Render Shell (`cat >
   /data/recallguard.db` or `scp` per Render docs). Verify checksum before
   and after. Never expose the file publicly.
4. **Verify on Render** (Shell, app stopped): `sqlite3 /data/recallguard.db
   'PRAGMA integrity_check;'` → `ok`; schema version 2; counts match step 2.
5. Only then start the service. First boot must report `persistent: true`,
   `schemaVersion: 2`, and the recorded counts via `/health`.

If the Railway shell is unavailable, STOP: do not improvise an export
endpoint or scrape records over HTTP.

## 5. Deploy and verify health (read-only)

1. Deploy the approved commit; watch the build log for a clean `vite build`
   and `listening on 0.0.0.0:$PORT`.
2. `GET /api/recallguard/health/ready` → `{ready: true}`.
3. `GET /api/recallguard/health` → Tatum connected, `persistent: true`,
   schema 2, counts equal to §0.
4. `GET /api/recallguard/config-status` → `qwen.configured: true`,
   `qwen.model: qwen3.8-flash`; `meta.configured: true`. No secret values.
5. `GET /api/recallguard/sessions` and `/memories` → IDs match §0 exactly.

## 6. Post-migration live tests (each needs its own explicit approval)

- **Qwen test**: one `POST /sessions` with `noFallback: true, skipWalrus: true`;
  expect `aiProvider: qwen`, `aiFallbackUsed: false`, strict-schema analysis.
- **Meta fallback test**: one `POST /sessions` with defaults and a forced
  Qwen failure; expect `aiFallbackUsed: true`.
- **Tatum**: live checkpoint in the session's `onChainSuiData`.
- **Walrus**: one `POST /sessions` with defaults; expect verified read-back.
- Never run these without approval; never retry a live call.

## 7. Rollback (preserves data)

- Rewinding the Render service to the previous commit does not touch `/data`:
  records survive either direction.
- For a full retreat: unsuspend Railway (its volume was never modified) and
  point traffic back. The Render disk snapshot from §4 doubles as a backup.
- Rollback trigger: readiness not READY within 10 minutes, counts mismatch,
  or any startup/persistence error.
