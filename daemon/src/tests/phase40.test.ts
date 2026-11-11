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
    projectName: 'Phase40-Rollback-Test',
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

describe('Phase 40: On-Demand Hard Git Rollback & Working Tree Sanitizer (/api/rollback — 40-Phase Milestone)', () => {
  it('wipes dirty tracked/untracked changes, returns to main, deletes broken task branch, and preserves .megax audit store', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p40-'));
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

      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'app.ts'),
        'export const clean = true;\n',
        'utf-8'
      );
      git.commitAll('Initial clean commit');

      // Record an audit store entry in .megax/audit-history.json
      engine.getAuditStore().recordRun('Milestone 40 run', {
        masterTaskId: 'run-40',
        engineMode: 'SINGLE_AGENT',
        overallSuccess: true,
        microTaskResults: [],
      });

      // Switch to megax/broken-40 and dirty the working tree
      git.createTaskBranch('broken-40');
      fs.writeFileSync(
        path.join(tempDir, 'src', 'app.ts'),
        'SYNTAX ERROR BROKEN EDIT\n',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'untracked.ts'),
        'export const garbage = 1;\n',
        'utf-8'
      );

      assert.strictEqual(git.getWorkingTreeDiff().statusLines.length, 2);

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // Trigger POST /api/rollback
      const rollbackRes = await httpPostJson(
        `http://127.0.0.1:${port}/api/rollback`,
        {
          returnBranch: 'main',
          deleteTaskBranch: 'megax/broken-40',
        }
      );

      assert.strictEqual(rollbackRes.statusCode, 200);
      assert.strictEqual(rollbackRes.body.rolledBack, true);
      assert.strictEqual(rollbackRes.body.currentBranch, 'main');
      assert.deepStrictEqual(rollbackRes.body.statusLines, []);

      // Verify tracked file was restored, untracked file was wiped, and task branch deleted
      const restoredContent = fs
        .readFileSync(path.join(tempDir, 'src', 'app.ts'), 'utf-8')
        .replace(/\r\n/g, '\n');
      assert.strictEqual(restoredContent, 'export const clean = true;\n');
      assert.strictEqual(
        fs.existsSync(path.join(tempDir, 'src', 'untracked.ts')),
        false
      );
      assert.deepStrictEqual(git.listTaskBranches(), []);

      // Verify .megax/audit-history.json survived the hard rollback
      assert.strictEqual(engine.getAuditStore().readAll().length, 1);
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

