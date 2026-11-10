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
    projectName: 'Phase31-Test',
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
      maxFixAttempts: 2,
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

describe('Phase 31: Workspace File Tree & Safe File Inspector (/api/files & /api/file)', () => {
  it('lists and filters workspace files via GET /api/files and safely reads/guards files via GET /api/file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p31-'));
    let relay: MobileRelayServer | undefined;

    try {
      fs.mkdirSync(path.join(tempDir, 'src', 'services'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'index.ts'),
        'export const appName = "MeGa X";\nexport const version = 31;\n',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'services', 'authService.ts'),
        'export function verifyUser(): boolean { return true; }\n',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, '.env'),
        'SECRET_KEY=super-secret-value\n',
        'utf-8'
      );

      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // 1. List all candidate files
      const listRes = await httpGetJson(`http://127.0.0.1:${port}/api/files`);
      assert.strictEqual(listRes.statusCode, 200);
      assert.strictEqual(listRes.body.totalCount, 2);
      const files = listRes.body.files as Array<{
        path: string;
        sizeBytes: number;
        extension: string;
      }>;
      assert.deepStrictEqual(
        files.map((f) => f.path),
        ['src/index.ts', 'src/services/authService.ts']
      );

      // 2. Filter files by query
      const filteredRes = await httpGetJson(
        `http://127.0.0.1:${port}/api/files?query=auth`
      );
      assert.strictEqual(filteredRes.statusCode, 200);
      assert.strictEqual(filteredRes.body.totalCount, 1);

      // 3. Read valid workspace file
      const fileRes = await httpGetJson(
        `http://127.0.0.1:${port}/api/file?path=src/index.ts`
      );
      assert.strictEqual(fileRes.statusCode, 200);
      assert.strictEqual(fileRes.body.path, 'src/index.ts');
      assert.ok(String(fileRes.body.content).includes('MeGa X'));
      assert.strictEqual(fileRes.body.lineCount, 3);

      // 4. Protected file (.env) must be rejected with HTTP 403
      const envRes = await httpGetJson(
        `http://127.0.0.1:${port}/api/file?path=.env`
      );
      assert.strictEqual(envRes.statusCode, 403);

      // 5. Path traversal (../outside.ts) must be rejected with HTTP 403
      const traversalRes = await httpGetJson(
        `http://127.0.0.1:${port}/api/file?path=../outside.ts`
      );
      assert.strictEqual(traversalRes.statusCode, 403);

      // 6. Non-existent file returns HTTP 404
      const missingRes = await httpGetJson(
        `http://127.0.0.1:${port}/api/file?path=src/doesNotExist.ts`
      );
      assert.strictEqual(missingRes.statusCode, 404);
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
