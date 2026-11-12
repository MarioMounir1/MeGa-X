# Project MeGa X 🚀

**Autonomous, Local-First AI Multi-Agent Orchestrator with a Mobile Steering Wheel**

MeGa X enables developers to dispatch high-level feature requirements from a **Flutter Mobile Companion App**, relayed over WebSockets & Firebase Cloud Messaging (FCM) to a **Local Node.js + TypeScript Core Daemon** on their workstation. The Daemon drives AI models (`claude-3-7-sonnet`, `antigravity`, `codex`) to plan, write code on isolated Git branches (`megax/<task-id>`), verify builds/tests in a 3-attempt self-healing loop, and auto-commit clean code (or execute a hard Git rollback on failure).

---

## 🏗️ System Topology

1. **Mobile Controller (`mobile/` — Flutter)**:
   - Dispatches high-level feature prompts & toggles between `SINGLE_AGENT` and `MULTI_AGENT` modes at runtime.
   - Streams live `stdout`/`stderr`/`system` terminal logs over WebSockets.
   - Displays interactive security approval cards (`APPROVE` / `REJECT & ROLLBACK`) for `DB_MIGRATION`, `FILE_DELETE`, and `MAX_RETRY_EXCEEDED`.
2. **Bi-Directional Relay (`daemon/src/relay/` — WebSocket + HTTP REST + FCM Push Hook + Tailscale Discovery)**:
   - Bridges the Flutter Mobile Controller (and built-in Web Steering Wheel UI) with the Local Core Daemon over LAN / Tailscale (`ws://<host>:4040/ws`).
   - Supports constant-time Bearer/Query token authentication (`MEGAX_RELAY_TOKEN`), non-blocking stream throttling, and FIFO task queueing.
3. **Local Core Daemon (`daemon/` — Node.js + TypeScript)**:
   - **Dual Modes**: `SINGLE_AGENT` (unified planner + executor) and `MULTI_AGENT` (`Planner` $\rightarrow$ `Executor` $\rightarrow$ `Reviewer`).
   - **Self-Healing Engine**: Runs `compileCommand` and `testCommand` via child processes, capturing `stderr` stack traces into `errorLog` for automated remediation up to `maxFixAttempts`.
   - **Git Safety Net**: Pre-flight auto-stash protection, isolated `megax/<task-id>` task branching, auto-commit on verification pass, branch merge finalizer, and `git reset --hard` rollback on failure or emergency abort.

---

## 📡 Relay Server Endpoints (`http://localhost:4040`)

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/` | `GET` | Built-in Mobile/Web Steering Wheel Dashboard |
| `/ws` | `WS` | Bi-directional WebSocket stream (`PROMPT_SUBMIT`, `APPROVAL_DECISION`, `SET_ENGINE_MODE`, `ABORT_TASK`) |
| `/api/status` | `GET` | Live Daemon health, connected clients, and pending approval IDs |
| `/api/pairing` | `GET` | Auto-discovered Tailscale & LAN WebSocket URLs and `megax://connect` QR deep-link payload |
| `/api/config` | `GET` / `POST` | Inspect or dynamically switch `SINGLE_AGENT` / `MULTI_AGENT` mode |
| `/api/agents` | `GET` | Registered AI agent roster (`claude-3-7-sonnet`, `antigravity`, `codex`, etc.) & active role assignments |
| `/api/prompt` | `POST` | Enqueue a high-level feature prompt into the FIFO `TaskQueueManager` |
| `/api/approvals` | `GET` | List full payloads of all pending `SecurityGate` approvals |
| `/api/approval` | `POST` | Resolve a pending `SecurityGate` approval (`DB_MIGRATION`, `FILE_DELETE`, `MAX_RETRY_EXCEEDED`) |
| `/api/security` | `GET` / `POST` | Inspect and dynamically update `SecurityGate` triggers (`requireApprovalOn`, `approvalTimeoutMs`) |
| `/api/fcm/history` | `GET` | Bounded log of dispatched Firebase Cloud Messaging (FCM) notifications |
| `/api/fcm/test` | `POST` | Dispatch a diagnostic test FCM push notification from mobile |
| `/api/abort` | `POST` | Emergency Kill-Switch: terminates active child process & triggers hard Git rollback |
| `/api/rollback` | `POST` | On-demand hard Git rollback (`git reset --hard && git clean -fd`) & return to `main` |
| `/api/merge` | `POST` | Merges a verified `megax/<task-id>` branch into `main` and deletes the temporary branch |
| `/api/diff` | `GET` | Live working-tree status lines and unified Git diff (`git diff HEAD`) |
| `/api/branches` | `GET` | Active branch and all `megax/*` task branches |
| `/api/branches/diff` | `GET` | Unified Git diff between a `megax/*` task branch and `main` (`?branch=&base=`) |
| `/api/branches/squash` | `POST` | Squash intermediate retry commits on a `megax/*` task branch into a single atomic commit |
| `/api/branches/delete` | `POST` | Safely discard/delete a `megax/*` task branch (`main` protected) |
| `/api/commits` | `GET` | Recent Git commit history (`hash`, `subject`, `author`, `date`) |
| `/api/stash` | `GET` | List saved Git stash entries (`ref`, `message`, `date`) |
| `/api/stash/push` | `POST` | Stash uncommitted WIP edits (`--include-untracked`) from mobile |
| `/api/stash/pop` | `POST` | Restore the most recent Git stash entry onto the working tree |
| `/api/checkout` | `POST` | Switch the working tree to a specific branch |
| `/api/files` | `GET` | Workspace source file index (`?query=` substring search) |
| `/api/file` | `GET` | Safe workspace file inspector (`?path=`) with path-traversal & secret-file guards |
| `/api/patch/dry-run` | `POST` | Pre-flight validation of proposed `FileDiff[]` batch without writing to disk |
| `/api/search` | `GET` | Workspace source code content search (`?q=&limit=`) returning file, line number, and snippet |
| `/api/verify` | `POST` | Trigger compile + test verification run with optional custom overrides (`compileCommand`, `testCommand`, `timeoutMs`) |
| `/api/diagnostics` | `GET` | Redacted environment & AI provider key diagnostics |
| `/api/logs` | `GET` | Bounded terminal scrollback ring buffer (`?stream=stdout\|stderr\|system&taskId=&limit=`) |
| `/api/logs/clear` | `POST` | Clear the bounded terminal scrollback ring buffer |
| `/api/queue` | `GET` | Snapshot of FIFO task queue (`QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`) |
| `/api/queue/cancel` | `POST` | Cancel a waiting `QUEUED` task before it starts execution |
| `/api/queue/clear` | `POST` | Prune finished (`COMPLETED`, `FAILED`, `CANCELLED`) tasks from the queue |
| `/api/history` | `GET` | Persistent task execution audit log (`?status=SUCCESS\|FAILED&limit=&taskId=`) |
| `/api/history/export` | `GET` | Export task audit history in `json` or `markdown` format (`?format=`) |
| `/api/history/clear` | `POST` | Clear persisted `.megax/audit-history.json` entries |
| `/api/metrics` | `GET` | Self-healing recovery rate, first-attempt pass rate, average attempts, and mode breakdown (`?mode=&limit=`) |
| `/api/consensus` | `GET` | Multi-agent consensus status, approval ratio, votes, and conflict evaluations (`?limit=&taskId=`) |
| `/api/network/health` | `GET` | Active network interfaces, Tailscale connectivity state, primary WS endpoint, and transition history |

---

## 🚀 Quickstart & CLI

```powershell
cd daemon
npm install
npm run build
npm test          # Runs all 58 automated test suites
npm run demo      # Runs live self-healing showcase in an isolated Git repo
npm run serve     # Starts Mobile Relay Server & Web UI on http://localhost:4040
npx megax benchmark # Runs autonomous self-healing benchmark scenarios
```

### 📱 Mobile Steering Wheel (Flutter)

```powershell
cd mobile
flutter test      # Runs mobile unit & contract tests
flutter analyze   # Verifies static analysis
```

### 🐳 Docker & Docker Compose Deployment

MeGa X includes a production-grade multi-stage `Dockerfile` and `docker-compose.yml` with healthchecks:

```powershell
# Validate Docker configuration readiness via CLI
npx megax docker

# Launch background containerized daemon with volume-mounted workspace
docker compose up -d

# Check real-time container health
docker compose ps
curl http://localhost:4040/api/status
```
