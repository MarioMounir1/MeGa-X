import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import {
  bootstrapDaemon,
  getDaemonInstanceSummary,
  startDaemonRelayServer,
} from '../index';
import { GitManager } from '../git/gitManager';

describe('Phase 50: Grand Milestone (50 Test Suites, 72+ Tests) — Full Daemon Lifecycle & Instance Summary', () => {
  it('bootstraps full daemon instance, boots mobile relay, and exports complete instance summary', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p50-'));

    try {
      const git = new GitManager(tempDir);
      git.runGit(['init', '-b', 'main']);
      git.runGit(['config', 'user.name', 'MeGa X Milestone 50']);
      git.runGit(['config', 'user.email', 'm50@megax.local']);

      const configPath = path.join(tempDir, 'megax.config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            projectName: 'MeGa-X-Milestone-50',
            engineMode: 'MULTI_AGENT',
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
              requireApprovalOn: ['DB_MIGRATION', 'FILE_DELETE', 'MAX_RETRY_EXCEEDED'],
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      fs.writeFileSync(
        path.join(tempDir, 'index.ts'),
        'export const milestone = 50;\n',
        'utf-8'
      );
      git.commitAll('Initial commit for milestone 50');

      // 1. Bootstrap Daemon directly from config
      const engine = bootstrapDaemon(configPath);
      assert.strictEqual(engine.getConfig().projectName, 'MeGa-X-Milestone-50');
      assert.strictEqual(engine.getConfig().engineMode, 'MULTI_AGENT');

      // 2. Start relay server
      const { relay, port } = await startDaemonRelayServer(0, configPath);
      assert.ok(port > 0);

      // 3. Inspect DaemonInstanceSummary
      const summary = getDaemonInstanceSummary(engine, port);
      assert.strictEqual(summary.projectName, 'MeGa-X-Milestone-50');
      assert.strictEqual(summary.engineMode, 'MULTI_AGENT');
      assert.strictEqual(summary.version, '1.0.0');
      assert.strictEqual(summary.endpoints.dashboardUrl, `http://localhost:${port}/`);
      assert.strictEqual(summary.endpoints.wsUrl, `ws://localhost:${port}/ws`);

      await relay.stop();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
