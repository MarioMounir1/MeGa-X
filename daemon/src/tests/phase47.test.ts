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
    projectName: 'Phase47-Security-Test',
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
      requireApprovalOn: ['FILE_DELETE', 'DB_MIGRATION'],
    },
  };
}

function httpRequestJson(
  url: string,
  method: 'GET' | 'POST',
  payload?: Record<string, unknown>
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = payload ? JSON.stringify(payload) : undefined;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: bodyStr
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyStr),
            }
          : undefined,
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
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

describe('Phase 47: Security Gate Policy & Trigger Configuration API (/api/security)', () => {
  it('reads security policy via GET /api/security and mutates active triggers and timeout via POST /api/security', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p47-'));
    let relay: MobileRelayServer | undefined;

    try {
      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // 1. Initial GET /api/security
      const initialRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/security`,
        'GET'
      );
      assert.strictEqual(initialRes.statusCode, 200);
      const initialTriggers = initialRes.body.requireApprovalOn as string[];
      assert.ok(initialTriggers.includes('FILE_DELETE'));
      assert.ok(initialTriggers.includes('DB_MIGRATION'));
      assert.strictEqual(initialRes.body.hasApprovalHandler, true);
      assert.ok(Number(initialRes.body.protectedFileRuleCount) >= 5);

      // 2. Mutate triggers via POST /api/security
      const updateRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/security`,
        'POST',
        {
          requireApprovalOn: ['MAX_RETRY_EXCEEDED'],
          approvalTimeoutMs: 30000,
        }
      );
      assert.strictEqual(updateRes.statusCode, 200);
      const updatedTriggers = updateRes.body.requireApprovalOn as string[];
      assert.deepStrictEqual(updatedTriggers, ['MAX_RETRY_EXCEEDED']);
      assert.strictEqual(updateRes.body.approvalTimeoutMs, 30000);

      // 3. Verify SecurityGate state reflects update
      const gate = engine.getSecurityGate();
      assert.strictEqual(gate.isTriggerEnabled('FILE_DELETE'), false);
      assert.strictEqual(gate.isTriggerEnabled('MAX_RETRY_EXCEEDED'), true);
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

