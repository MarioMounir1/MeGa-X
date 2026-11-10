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
    projectName: 'Phase34-History-Test',
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

function httpRequestJson(
  url: string,
  method: 'GET' | 'POST'
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
      },
      (res) => {
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
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Phase 34: Persistent Audit History Querying & Pruning (/api/history & /api/history/clear)', () => {
  it('filters audit history by status, limit, and taskId via GET /api/history and clears entries via POST /api/history/clear', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p34-'));
    let relay: MobileRelayServer | undefined;

    try {
      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });
      const store = engine.getAuditStore();

      store.recordRun('Add JWT login endpoint', {
        masterTaskId: 'run-pass-1',
        engineMode: 'SINGLE_AGENT',
        overallSuccess: true,
        microTaskResults: [],
      });
      store.recordRun('Broken DB migration', {
        masterTaskId: 'run-fail-2',
        engineMode: 'MULTI_AGENT',
        overallSuccess: false,
        microTaskResults: [],
      });
      store.recordRun('Add unit test suite', {
        masterTaskId: 'run-pass-3',
        engineMode: 'SINGLE_AGENT',
        overallSuccess: true,
        microTaskResults: [],
      });

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // 1. Filter by status=SUCCESS
      const successRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/history?status=SUCCESS`,
        'GET'
      );
      assert.strictEqual(successRes.statusCode, 200);
      assert.strictEqual(successRes.body.totalCount, 2);

      // 2. Filter by status=FAILED
      const failedRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/history?status=FAILED`,
        'GET'
      );
      assert.strictEqual(failedRes.statusCode, 200);
      assert.strictEqual(failedRes.body.totalCount, 1);

      // 3. Filter by limit=1 (returns most recent entry: run-pass-3)
      const limitRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/history?limit=1`,
        'GET'
      );
      assert.strictEqual(limitRes.statusCode, 200);
      const limitedHistory = limitRes.body.history as Array<{
        masterTaskId: string;
      }>;
      assert.strictEqual(limitedHistory.length, 1);
      assert.strictEqual(limitedHistory[0].masterTaskId, 'run-pass-3');

      // 4. Filter by taskId=run-fail-2
      const taskRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/history?taskId=run-fail-2`,
        'GET'
      );
      assert.strictEqual(taskRes.statusCode, 200);
      assert.strictEqual(taskRes.body.totalCount, 1);

      // 5. Clear history via POST /api/history/clear
      const clearRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/history/clear`,
        'POST'
      );
      assert.strictEqual(clearRes.statusCode, 200);
      assert.strictEqual(clearRes.body.clearedCount, 3);

      const emptyRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/history`,
        'GET'
      );
      assert.strictEqual(emptyRes.body.totalCount, 0);
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

