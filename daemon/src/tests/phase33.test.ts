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
    projectName: 'Phase33-Branch-Test',
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

describe('Phase 33: Remote Task Branch Deletion & Branch Comparison API (/api/branches/delete & /api/branches/diff)', () => {
  it('inspects task branch diff via GET /api/branches/diff, deletes megax/* branch safely, and blocks deleting main', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p33-'));
    let relay: MobileRelayServer | undefined;

    try {
      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });
      const git = engine.getGitManager();

      // Initialize git repo on 'main'
      git.runGit(['init', '-b', 'main']);
      git.runGit(['config', 'user.name', 'MeGa X Test']);
      git.runGit(['config', 'user.email', 'test@megax.local']);

      fs.writeFileSync(
        path.join(tempDir, 'app.ts'),
        'export const v = 1;\n',
        'utf-8'
      );
      git.commitAll('Initial commit on main');

      // Create task branch megax/task-33 and commit a change
      const taskBranch = git.createTaskBranch('task-33');
      assert.strictEqual(taskBranch, 'megax/task-33');
      fs.writeFileSync(
        path.join(tempDir, 'app.ts'),
        'export const v = 2;\nexport const feature33 = true;\n',
        'utf-8'
      );
      git.commitAll('Task 33 changes');

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // 1. Inspect branch diff against main via GET /api/branches/diff
      const diffRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/branches/diff?branch=megax/task-33&base=main`,
        'GET'
      );
      assert.strictEqual(diffRes.statusCode, 200);
      assert.strictEqual(diffRes.body.taskBranch, 'megax/task-33');
      assert.ok(String(diffRes.body.unifiedDiff).includes('feature33'));

      // 2. Attempt to delete protected 'main' branch -> HTTP 400
      const protectRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/branches/delete`,
        'POST',
        { taskBranch: 'main' }
      );
      assert.strictEqual(protectRes.statusCode, 400);

      // 3. Delete active task branch 'megax/task-33' -> auto-switches to 'main' and deletes branch
      const deleteRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/branches/delete`,
        'POST',
        { taskBranch: 'megax/task-33', fallbackBranch: 'main' }
      );
      assert.strictEqual(deleteRes.statusCode, 200);
      assert.strictEqual(deleteRes.body.deleted, true);
      assert.strictEqual(deleteRes.body.deletedBranch, 'megax/task-33');
      assert.strictEqual(deleteRes.body.currentBranch, 'main');
      assert.deepStrictEqual(git.listTaskBranches(), []);
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

