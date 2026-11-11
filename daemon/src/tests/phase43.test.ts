import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

function createTestConfig(): MegaXConfig {
  return {
    projectName: 'Phase43-Metrics-Test',
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
      maxFixAttempts: 1,
    },
    security: {
      requireApprovalOn: ['FILE_DELETE', 'DB_MIGRATION', 'MAX_RETRY_EXCEEDED'],
    },
  };
}

function httpGetJson(
  url: string
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf-8');
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: JSON.parse(raw) as Record<string, unknown>,
          });
        });
      })
      .on('error', reject);
  });
}

describe('Phase 43: Granular Telemetry Analytics & Engine Mode Filter API (/api/metrics?mode=&limit=)', () => {
  it('computes engineMode breakdown, filters metrics by SINGLE_AGENT/MULTI_AGENT and limit', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p43-'));
    let relay: MobileRelayServer | undefined;

    try {
      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });
      const store = engine.getAuditStore();

      // Seed 3 run entries: 2 SINGLE_AGENT (1 success, 1 fail) and 1 MULTI_AGENT (success)
      store.recordRun('Single agent task 1', {
        masterTaskId: 'task_s1',
        engineMode: 'SINGLE_AGENT',
        overallSuccess: true,
        microTaskResults: [
          {
            taskId: 'task_s1',
            prompt: 'Single agent task 1',
            branchName: 'megax/task_s1',
            status: 'COMPLETED',
            attemptsUsed: 1,
          },
        ],
      });

      store.recordRun('Single agent task 2', {
        masterTaskId: 'task_s2',
        engineMode: 'SINGLE_AGENT',
        overallSuccess: false,
        microTaskResults: [
          {
            taskId: 'task_s2',
            prompt: 'Single agent task 2',
            branchName: 'megax/task_s2',
            status: 'FAILED',
            attemptsUsed: 2,
          },
        ],
      });

      store.recordRun('Multi agent task 3', {
        masterTaskId: 'task_m3',
        engineMode: 'MULTI_AGENT',
        overallSuccess: true,
        microTaskResults: [
          {
            taskId: 'task_m3_1',
            prompt: 'Multi agent subtask 1',
            branchName: 'megax/task_m3',
            status: 'COMPLETED',
            attemptsUsed: 2,
          },
        ],
      });

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // 1. Fetch unfiltered metrics
      const allRes = await httpGetJson(`http://127.0.0.1:${port}/api/metrics`);
      assert.strictEqual(allRes.statusCode, 200);
      assert.strictEqual(allRes.body.totalRuns, 3);
      assert.strictEqual(allRes.body.successfulRuns, 2);
      assert.strictEqual(allRes.body.failedOrRolledBackRuns, 1);
      const modeBreakdown = allRes.body.modeBreakdown as {
        singleAgentRuns: number;
        multiAgentRuns: number;
      };
      assert.strictEqual(modeBreakdown.singleAgentRuns, 2);
      assert.strictEqual(modeBreakdown.multiAgentRuns, 1);

      // 2. Filter by mode=SINGLE_AGENT
      const singleRes = await httpGetJson(
        `http://127.0.0.1:${port}/api/metrics?mode=SINGLE_AGENT`
      );
      assert.strictEqual(singleRes.statusCode, 200);
      assert.strictEqual(singleRes.body.totalRuns, 2);
      assert.strictEqual(singleRes.body.successfulRuns, 1);
      assert.strictEqual(singleRes.body.failedOrRolledBackRuns, 1);
      assert.strictEqual(singleRes.body.successRatePercent, 50);

      // 3. Filter by mode=MULTI_AGENT
      const multiRes = await httpGetJson(
        `http://127.0.0.1:${port}/api/metrics?mode=MULTI_AGENT`
      );
      assert.strictEqual(multiRes.statusCode, 200);
      assert.strictEqual(multiRes.body.totalRuns, 1);
      assert.strictEqual(multiRes.body.successfulRuns, 1);
      assert.strictEqual(multiRes.body.successRatePercent, 100);
      assert.strictEqual(multiRes.body.selfHealedPasses, 1);

      // 4. Filter by limit=1 (returns only the latest entry: task_m3)
      const limitRes = await httpGetJson(
        `http://127.0.0.1:${port}/api/metrics?limit=1`
      );
      assert.strictEqual(limitRes.statusCode, 200);
      assert.strictEqual(limitRes.body.totalRuns, 1);
      assert.strictEqual(limitRes.body.recentHistoryWindow, 1);
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

