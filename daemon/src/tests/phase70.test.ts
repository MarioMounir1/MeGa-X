import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { runMegaXCli } from '../cli';
import { bootstrapDaemon, getEcosystemHealthReport } from '../index';
import { AgentDeadlockWatchdog } from '../orchestrator/deadlockWatchdog';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 70: Platinum Milestone (70 Test Suites) — Autonomous Multi-Agent Deadlock & Livelock Watchdog', () => {
  it('detects cyclic dependencies (deadlock) and oscillating diffs (livelock)', () => {
    const watchdog = new AgentDeadlockWatchdog({
      oscillationThreshold: 3,
      maxStallDurationMs: 100,
    });

    // 1. Healthy task
    watchdog.trackTaskStart('task_healthy');
    watchdog.recordAgentTurn('task_healthy', 'claude-3-7-sonnet', 'diff_1');
    const healthyCheck = watchdog.inspect('task_healthy');
    assert.strictEqual(healthyCheck.healthy, true);

    // 2. Cyclic dependency deadlock
    watchdog.setAgentDependency('task_cycle', 'planner', 'planner');
    const deadlockCheck = watchdog.inspect('task_cycle');
    assert.strictEqual(deadlockCheck.healthy, false);
    assert.strictEqual(deadlockCheck.detectedIssue, 'DEADLOCK');
    assert.strictEqual(deadlockCheck.actionRecommended, 'ABORT');

    // 3. Repeated diff livelock
    watchdog.trackTaskStart('task_oscillation');
    watchdog.recordAgentTurn('task_oscillation', 'agentA', 'diff_alpha');
    watchdog.recordAgentTurn('task_oscillation', 'agentB', 'diff_alpha');
    watchdog.recordAgentTurn('task_oscillation', 'agentA', 'diff_alpha');
    const livelockCheck = watchdog.inspect('task_oscillation');
    assert.strictEqual(livelockCheck.healthy, false);
    assert.strictEqual(livelockCheck.detectedIssue, 'LIVELOCK');
    assert.strictEqual(livelockCheck.actionRecommended, 'FALLBACK_PRIMARY');
  });

  it('serves deadlock watchdog via REST endpoints (/api/deadlock and /api/deadlock/check)', async () => {
    const engine = bootstrapDaemon();
    const watchdog = engine.getDeadlockWatchdog();
    watchdog.clearAll();

    watchdog.trackTaskStart('task_rest_dl');
    watchdog.recordAgentTurn('task_rest_dl', 'agent1', 'sigA');

    const relay = new MobileRelayServer(engine, async () => {});
    const port = await relay.start(0, '127.0.0.1');

    try {
      // 1. GET /api/deadlock?taskId=task_rest_dl
      const getRes = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/api/deadlock?taskId=task_rest_dl`, (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
      const parsedGet = JSON.parse(getRes);
      assert.strictEqual(parsedGet.healthy, true);
      assert.strictEqual(parsedGet.taskId, 'task_rest_dl');

      // 2. POST /api/deadlock/check
      const checkRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/deadlock/check`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ taskId: 'task_rest_dl' }));
        req.end();
      });
      const parsedCheck = JSON.parse(checkRes);
      assert.strictEqual(parsedCheck.healthy, true);
    } finally {
      await relay.stop();
    }
  });

  it('runs megax deadlock CLI command and confirms Platinum Milestone (70 test suites)', async () => {
    const { exitCode, output } = await runMegaXCli(['deadlock']);
    assert.strictEqual(exitCode, 0);
    assert.ok(output.includes('=== MeGa X Multi-Agent Deadlock Watchdog'));

    const engine = bootstrapDaemon();
    const report = getEcosystemHealthReport(engine);
    assert.strictEqual(report.status, 'HEALTHY');
    assert.strictEqual(report.metrics.totalTestSuites, 70);
    assert.strictEqual(report.subsystems.deadlockWatchdog, true);
  });
});
