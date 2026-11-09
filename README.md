# Project MeGa X 🚀

**Autonomous, Local-First AI Multi-Agent Orchestrator with a Mobile Steering Wheel**

MeGa X enables developers to dispatch high-level feature requirements from a **Flutter Mobile Companion App**, relayed over WebSockets & Firebase Cloud Messaging (FCM) to a **Local Node.js + TypeScript Core Daemon** on their workstation. The Daemon drives AI models (`claude-3-7-sonnet`, `antigravity`, `codex`) to plan, write code on isolated Git branches, verify builds/tests in a 3-attempt self-healing loop, and auto-commit clean code (or execute a hard Git rollback on failure).

---

## 🏗️ System Topology

1. **Mobile Controller (`mobile/` — Flutter)**:
   - Dispatches high-level feature prompts.
   - Streams live `stdout`/`stderr`/`system` terminal logs over WebSockets.
   - Displays interactive security approval cards (`APPROVE` / `REJECT & ROLLBACK`) for `DB_MIGRATION`, `FILE_DELETE`, and `MAX_RETRY_EXCEEDED`.
2. **Bi-Directional Relay (`daemon/src/relay/` — WebSocket + HTTP + FCM Hook)**:
   - Bridges the Flutter Mobile Controller and the Local Core Daemon over LAN / Tailscale (`ws://<host>:4040/ws`).
3. **Local Core Daemon (`daemon/` — Node.js + TypeScript)**:
   - **Dual Modes**: `SINGLE_AGENT` (unified planner + executor) and `MULTI_AGENT` (`Planner` $\rightarrow$ `Executor` $\rightarrow$ `Reviewer`).
   - **Self-Healing Engine**: Runs `compileCommand` and `testCommand` via child processes, capturing `stderr` stack traces into `errorLog` for automated remediation up to `maxFixAttempts`.
   - **Git Safety Net**: Isolates every task on `megax/<task-id>`, auto-commits verified changes, and runs `git reset --hard` if retries are exhausted or approval is denied.

---

## 🚀 Quickstart

```powershell
cd daemon
npm install
npm run build
npm test
npm start
```

