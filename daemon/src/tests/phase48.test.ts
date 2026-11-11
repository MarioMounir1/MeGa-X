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
    projectName: 'Phase48-Patch-DryRun-Test',
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

function httpPostJson(
  url: string,
  payload: Record<string, unknown>
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
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
    req.write(bodyStr);
    req.end();
  });
}

describe('Phase 48: Atomic Patch Pre-Flight Dry Run API (/api/patch/dry-run)', () => {
  it('validates FileDiff batch, identifies required triggers, blocks protected files without modifying disk', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p48-'));
    let relay: MobileRelayServer | undefined;

    try {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'existing.ts'),
        'export const x = 1;\n',
        'utf-8'
      );

      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // 1. Valid batch dry-run with creation and deletion
      const validRes = await httpPostJson(
        `http://127.0.0.1:${port}/api/patch/dry-run`,
        {
          fileDiffs: [
            {
              path: 'src/newFeature.ts',
              action: 'CREATE',
              content: 'export const feature = true;\n',
            },
            {
              path: 'src/existing.ts',
              action: 'DELETE',
              content: '',
            },
          ],
        }
      );

      assert.strictEqual(validRes.statusCode, 200);
      assert.strictEqual(validRes.body.valid, true);
      assert.strictEqual(validRes.body.createdCount, 1);
      assert.strictEqual(validRes.body.deletedCount, 1);
      const triggers = validRes.body.triggersRequired as Array<{ trigger: string }>;
      assert.ok(triggers.some((t) => t.trigger === 'FILE_DELETE'));

      // Crucial: Disk remains completely untouched by dry-run
      assert.strictEqual(
        fs.existsSync(path.join(tempDir, 'src', 'newFeature.ts')),
        false
      );
      assert.strictEqual(
        fs.existsSync(path.join(tempDir, 'src', 'existing.ts')),
        true
      );

      // 2. Dry-run targeting protected file (.env) returns HTTP 403
      const protectedRes = await httpPostJson(
        `http://127.0.0.1:${port}/api/patch/dry-run`,
        {
          fileDiffs: [
            {
              path: '.env',
              action: 'UPDATE',
              content: 'SECRET=exposed\n',
            },
          ],
        }
      );
      assert.strictEqual(protectedRes.statusCode, 403);
      assert.strictEqual(protectedRes.body.valid, false);

      // 3. Dry-run with path traversal returns HTTP 400
      const traversalRes = await httpPostJson(
        `http://127.0.0.1:${port}/api/patch/dry-run`,
        {
          fileDiffs: [
            {
              path: '../outside.ts',
              action: 'CREATE',
              content: 'hacked',
            },
          ],
        }
      );
      assert.strictEqual(traversalRes.statusCode, 400);
      assert.strictEqual(traversalRes.body.valid, false);
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

