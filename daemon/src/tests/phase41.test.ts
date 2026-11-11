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
    projectName: 'Phase41-Stash-Test',
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

describe('Phase 41: Remote Git Stash Management API (/api/stash, /api/stash/push, /api/stash/pop)', () => {
  it('stashes uncommitted WIP edits, lists stash entries via GET /api/stash, and restores them via POST /api/stash/pop', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p41-'));
    let relay: MobileRelayServer | undefined;

    try {
      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });
      const git = engine.getGitManager();

      git.runGit(['init', '-b', 'main']);
      git.runGit(['config', 'user.name', 'MeGa X Test']);
      git.runGit(['config', 'user.email', 'test@megax.local']);

      fs.writeFileSync(
        path.join(tempDir, 'main.ts'),
        'export const v = 1;\n',
        'utf-8'
      );
      git.commitAll('Initial commit');

      // Make uncommitted WIP edits
      fs.writeFileSync(
        path.join(tempDir, 'main.ts'),
        'export const v = 2;\n',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'wip.ts'),
        'export const wip = true;\n',
        'utf-8'
      );

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // 1. Push stash via POST /api/stash/push
      const pushRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/stash/push`,
        'POST',
        { label: 'mobile-wip-41' }
      );
      assert.strictEqual(pushRes.statusCode, 200);
      assert.strictEqual(pushRes.body.stashed, true);

      // Working tree should now be clean
      assert.deepStrictEqual(git.getWorkingTreeDiff().statusLines, []);
      assert.strictEqual(fs.existsSync(path.join(tempDir, 'wip.ts')), false);

      // 2. Inspect GET /api/stash
      const listRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/stash`,
        'GET'
      );
      assert.strictEqual(listRes.statusCode, 200);
      assert.strictEqual(listRes.body.totalCount, 1);
      const stashes = listRes.body.stashes as Array<{
        ref: string;
        message: string;
      }>;
      assert.strictEqual(stashes[0].ref, 'stash@{0}');
      assert.ok(stashes[0].message.includes('mobile-wip-41'));

      // 3. Pop stash via POST /api/stash/pop
      const popRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/stash/pop`,
        'POST'
      );
      assert.strictEqual(popRes.statusCode, 200);
      assert.strictEqual(popRes.body.popped, true);

      // Verify WIP edits are restored and stash list is empty
      assert.strictEqual(fs.existsSync(path.join(tempDir, 'wip.ts')), true);
      const restoredMain = fs
        .readFileSync(path.join(tempDir, 'main.ts'), 'utf-8')
        .replace(/\r\n/g, '\n');
      assert.strictEqual(restoredMain, 'export const v = 2;\n');
      assert.strictEqual(git.listStashes().length, 0);
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

