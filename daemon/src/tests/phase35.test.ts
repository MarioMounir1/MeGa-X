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
    projectName: 'Phase35-Logs-Test',
    engineMode: 'SINGLE_AGENT',
    primaryAgent: 'claude-3-7-sonnet',
    multiAgentConfig: {
      planner: 'claude-3-7-sonnet',
      executor: 'antigravity',
      reviewer: 'codex',
    },
    verification: {
      compileCommand:
        'node -e "console.log(\'CompileStdOut\'); console.error(\'CompileStdErrWarning\');"',
      testCommand: 'node -e "console.log(\'TestStdOutPass\');"',
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

describe('Phase 35: Terminal Scrollback Filtering & Clear API (/api/logs & /api/logs/clear)', () => {
  it('filters buffered terminal logs by stream, taskId, and limit via GET /api/logs and clears buffer via POST /api/logs/clear', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p35-'));
    let relay: MobileRelayServer | undefined;

    try {
      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // Trigger verification run to populate stdout, stderr, and system logs for task_35
      await engine.getVerificationRunner().runVerificationSuite('task_35', 1);

      // 1. Fetch all logs
      const allLogsRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/logs`,
        'GET'
      );
      assert.strictEqual(allLogsRes.statusCode, 200);
      const totalBefore = Number(allLogsRes.body.totalCount);
      assert.ok(totalBefore >= 3);

      // 2. Filter by stream=stderr
      const stderrRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/logs?stream=stderr`,
        'GET'
      );
      assert.strictEqual(stderrRes.statusCode, 200);
      const stderrLogs = stderrRes.body.logs as Array<{
        stream: string;
        data: string;
      }>;
      assert.ok(stderrLogs.length >= 1);
      assert.ok(stderrLogs.every((l) => l.stream === 'stderr'));
      assert.ok(
        stderrLogs.some((l) => l.data.includes('CompileStdErrWarning'))
      );

      // 3. Filter by taskId=task_35 and limit=1
      const limitRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/logs?taskId=task_35&limit=1`,
        'GET'
      );
      assert.strictEqual(limitRes.statusCode, 200);
      assert.strictEqual(limitRes.body.totalCount, 1);

      // 4. Clear terminal scrollback via POST /api/logs/clear
      const clearRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/logs/clear`,
        'POST'
      );
      assert.strictEqual(clearRes.statusCode, 200);
      assert.strictEqual(clearRes.body.clearedCount, totalBefore);

      const emptyRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/logs`,
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

