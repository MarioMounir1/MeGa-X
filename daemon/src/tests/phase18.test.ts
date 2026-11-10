import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { TelemetryMetricsCollector } from '../storage/metricsCollector';
import { AuditLogEntry } from '../storage/taskAuditStore';
import { MegaXConfig } from '../types/contracts';

describe('Phase 18: System Telemetry Metrics Collector & /api/metrics Endpoint', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase18-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('TelemetryMetricsCollector accurately computes first-attempt, self-healed, and rollback metrics', () => {
    const sampleEntries: AuditLogEntry[] = [
      {
        masterTaskId: 'run_1',
        prompt: 'Task 1 (first attempt pass)',
        engineMode: 'SINGLE_AGENT',
        overallSuccess: true,
        recordedAt: '2026-11-10T00:00:00Z',
        microTaskResults: [
          {
            taskId: 'run_1',
            prompt: 'Task 1',
            branchName: 'megax/run_1',
            status: 'COMPLETED',
            attemptsUsed: 1,
            commitHash: 'abc1234',
          },
        ],
      },
      {
        masterTaskId: 'run_2',
        prompt: 'Task 2 (self-healed on attempt 2)',
        engineMode: 'SINGLE_AGENT',
        overallSuccess: true,
        recordedAt: '2026-11-10T00:05:00Z',
        microTaskResults: [
          {
            taskId: 'run_2',
            prompt: 'Task 2',
            branchName: 'megax/run_2',
            status: 'COMPLETED',
            attemptsUsed: 2,
            commitHash: 'def5678',
          },
        ],
      },
      {
        masterTaskId: 'run_3',
        prompt: 'Task 3 (failed all 3 attempts)',
        engineMode: 'MULTI_AGENT',
        overallSuccess: false,
        recordedAt: '2026-11-10T00:10:00Z',
        microTaskResults: [
          {
            taskId: 'run_3',
            prompt: 'Task 3',
            branchName: 'megax/run_3',
            status: 'ROLLED_BACK',
            attemptsUsed: 3,
          },
        ],
      },
    ];

    const summary = TelemetryMetricsCollector.computeFromEntries(sampleEntries);
    assert.equal(summary.totalRuns, 3);
    assert.equal(summary.successfulRuns, 2);
    assert.equal(summary.failedOrRolledBackRuns, 1);
    assert.equal(summary.successRatePercent, 67);
    assert.equal(summary.firstAttemptPasses, 1);
    assert.equal(summary.selfHealedPasses, 1);
    assert.equal(summary.rolledBackMicroTasks, 1);
    assert.equal(summary.averageAttemptsPerTask, 2);
  });

  it('GET /api/metrics returns live telemetry metrics from MobileRelayServer', async () => {
    const config: MegaXConfig = {
      projectName: 'Target-Project',
      engineMode: 'SINGLE_AGENT',
      primaryAgent: 'claude-3-7-sonnet',
      multiAgentConfig: {
        planner: 'claude-3-7-sonnet',
        executor: 'antigravity',
        reviewer: 'codex',
      },
      verification: {
        compileCommand: 'node -e "process.exit(0)"',
        testCommand: 'node -e "process.exit(0)"',
        maxFixAttempts: 3,
      },
      security: {
        requireApprovalOn: ['FILE_DELETE'],
      },
    };

    const engine = new OrchestratorEngine({ workspaceRoot: tempDir, config });
    const relay = new MobileRelayServer(engine);
    const port = await relay.start(0, '127.0.0.1');

    try {
      await engine.runFeaturePrompt('metric_task_1', 'Build metrics test');
      const res = await fetch(`http://127.0.0.1:${port}/api/metrics`);
      assert.equal(res.status, 200);
      const metrics = (await res.json()) as {
        totalRuns: number;
        successfulRuns: number;
        firstAttemptPasses: number;
      };
      assert.equal(metrics.totalRuns, 1);
      assert.equal(metrics.successfulRuns, 1);
      assert.equal(metrics.firstAttemptPasses, 1);
    } finally {
      await relay.stop();
    }
  });
});

