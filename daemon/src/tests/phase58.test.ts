import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { execSync } from 'child_process';
import { GitManager } from '../git/gitManager';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 58: Automated Task Branch Squashing & Atomic Release Finalizer', () => {
  it('squashes multiple trial-and-error retry commits on a megax/* task branch into a single atomic commit', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-squash-test-'));

    try {
      execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.name "Tester"', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.email "tester@megax.local"', { cwd: tempDir, stdio: 'ignore' });

      // Base commit on main
      fs.writeFileSync(path.join(tempDir, 'base.txt'), 'base\n');
      execSync('git add . && git commit -m "initial"', { cwd: tempDir, stdio: 'ignore' });

      const git = new GitManager(tempDir);

      // Create isolated task branch
      git.createTaskBranch('task_squash_1');
      assert.strictEqual(git.getCurrentBranch(), 'megax/task_squash_1');

      // Commit 1 (attempt 1 broken)
      fs.writeFileSync(path.join(tempDir, 'feature.ts'), 'export const broken = 1;\n');
      git.commitAll('attempt 1');

      // Commit 2 (attempt 2 fix)
      fs.writeFileSync(path.join(tempDir, 'feature.ts'), 'export const fixed = 2;\n');
      git.commitAll('attempt 2');

      // Commit 3 (attempt 3 docs)
      fs.writeFileSync(path.join(tempDir, 'feature.ts'), 'export const polished = 3;\n');
      git.commitAll('attempt 3');

      // Verify 3 commits ahead of main
      const commitCountBefore = parseInt(
        execSync('git rev-list --count main..megax/task_squash_1', { cwd: tempDir, encoding: 'utf-8' }).trim(),
        10
      );
      assert.strictEqual(commitCountBefore, 3);

      // Squash commits
      const squashResult = git.squashTaskBranchCommits(
        'megax/task_squash_1',
        'main',
        'feat: implement polished feature cleanly'
      );

      assert.strictEqual(squashResult.taskBranch, 'megax/task_squash_1');
      assert.ok(squashResult.squashedCommitHash);

      // Verify exactly 1 commit ahead of main
      const commitCountAfter = parseInt(
        execSync('git rev-list --count main..megax/task_squash_1', { cwd: tempDir, encoding: 'utf-8' }).trim(),
        10
      );
      assert.strictEqual(commitCountAfter, 1);

      // Verify content is preserved
      const content = fs.readFileSync(path.join(tempDir, 'feature.ts'), 'utf-8');
      assert.strictEqual(content, 'export const polished = 3;\n');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses to squash protected non-megax branches', () => {
    const git = new GitManager(process.cwd());
    assert.throws(
      () => git.squashTaskBranchCommits('main', 'main'),
      /Refusing to squash non-task branch/
    );
  });

  it('exposes branch squashing via POST /api/branches/squash endpoint', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-squash-api-'));

    try {
      execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.name "Tester"', { cwd: tempDir, stdio: 'ignore' });
      execSync('git config user.email "tester@megax.local"', { cwd: tempDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'init\n');
      execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

      const git = new GitManager(tempDir);
      git.createTaskBranch('task_api_squash');
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'edit 1\n');
      git.commitAll('edit 1');
      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'edit 2\n');
      git.commitAll('edit 2');

      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: {
          projectName: 'Squash-API',
          engineMode: 'SINGLE_AGENT',
          primaryAgent: 'claude-3-7-sonnet',
          multiAgentConfig: {
            planner: 'claude-3-7-sonnet',
            executor: 'antigravity',
            reviewer: 'codex',
          },
          verification: { testCommand: '', compileCommand: '', maxFixAttempts: 1 },
          security: { requireApprovalOn: [] },
        },
      });

      const relay = new MobileRelayServer(engine);
      const port = await relay.start(0);

      try {
        const res = await new Promise<any>((resolve, reject) => {
          const req = http.request(
            `http://localhost:${port}/api/branches/squash`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' } },
            (r) => {
              let data = '';
              r.on('data', (c) => (data += c));
              r.on('end', () => resolve(JSON.parse(data)));
            }
          );
          req.on('error', reject);
          req.write(
            JSON.stringify({
              taskBranch: 'megax/task_api_squash',
              baseBranch: 'main',
              commitMessage: 'feat: squashed via api',
            })
          );
          req.end();
        });

        assert.strictEqual(res.squashed, true);
        assert.strictEqual(res.taskBranch, 'megax/task_api_squash');
        assert.ok(res.squashedCommitHash);
      } finally {
        await relay.stop();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
