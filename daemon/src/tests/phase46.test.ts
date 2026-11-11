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
    projectName: 'Phase46-Export-Test',
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
      requireApprovalOn: ['FILE_DELETE'],
    },
  };
}

function httpGetRaw(
  url: string
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
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
            headers: res.headers,
            body: raw,
          });
        });
      })
      .on('error', reject);
  });
}

describe('Phase 46: Audit History Exporter & Markdown Report API (/api/history/export)', () => {
  it('exports task audit history as structured JSON and Markdown report via GET /api/history/export', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p46-'));
    let relay: MobileRelayServer | undefined;

    try {
      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });
      const store = engine.getAuditStore();

      store.recordRun('Setup database schema', {
        masterTaskId: 'task_db_01',
        engineMode: 'SINGLE_AGENT',
        overallSuccess: true,
        microTaskResults: [],
      });
      store.recordRun('Broken auth handler', {
        masterTaskId: 'task_auth_02',
        engineMode: 'MULTI_AGENT',
        overallSuccess: false,
        microTaskResults: [],
      });

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // 1. Export as default JSON
      const jsonRes = await httpGetRaw(
        `http://127.0.0.1:${port}/api/history/export?format=json`
      );
      assert.strictEqual(jsonRes.statusCode, 200);
      assert.ok(jsonRes.headers['content-type']?.includes('application/json'));
      const parsedJson = JSON.parse(jsonRes.body) as Array<{
        masterTaskId: string;
      }>;
      assert.strictEqual(parsedJson.length, 2);
      assert.strictEqual(parsedJson[0].masterTaskId, 'task_db_01');

      // 2. Export as Markdown report
      const mdRes = await httpGetRaw(
        `http://127.0.0.1:${port}/api/history/export?format=markdown`
      );
      assert.strictEqual(mdRes.statusCode, 200);
      assert.ok(mdRes.headers['content-type']?.includes('text/markdown'));
      assert.ok(mdRes.body.includes('# MeGa X Task Audit Execution Report'));
      assert.ok(mdRes.body.includes('| `task_db_01` | SINGLE_AGENT | ✅ PASSED |'));
      assert.ok(mdRes.body.includes('| `task_auth_02` | MULTI_AGENT | ❌ FAILED |'));
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

