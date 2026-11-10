import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitManager } from '../git/gitManager';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { FilePatcher } from '../patcher/filePatcher';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

describe('Phase 17: Pre-Flight Auto-Stash Protection & Task Branch Registry API', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase17-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('GitManager stashes dirty manual edits before task isolation and restores them cleanly', () => {
    const git = new GitManager(tempDir);
    const patcher = new FilePatcher(tempDir);

    git.runGit(['init']);
    git.runGit(['config', 'user.email', 'daemon@megax.local']);
    git.runGit(['config', 'user.name', 'MeGa X Daemon']);

    patcher.applyDiffs([
      { path: 'main.ts', content: 'export const v = 1;\n', action: 'CREATE' },
    ]);
    git.commitAll('chore: initial commit');

    // Simulate uncommitted developer work in progress
    patcher.applyDiffs([
      { path: 'wip.ts', content: 'export const wip = true;\n', action: 'CREATE' },
    ]);

    const stashed = git.stashUncommittedChanges('preflight-task-01');
    assert.equal(stashed, true);
    assert.equal(fs.existsSync(path.join(tempDir, 'wip.ts')), false);

    // Pop stash and verify developer's WIP file is restored
    git.popLastStash();
    assert.equal(fs.existsSync(path.join(tempDir, 'wip.ts')), true);
  });

  it('GET /api/branches lists active branch and all megax/* task branches', async () => {
    const git = new GitManager(tempDir);
    const patcher = new FilePatcher(tempDir);

    git.runGit(['init']);
    git.runGit(['config', 'user.email', 'daemon@megax.local']);
    git.runGit(['config', 'user.name', 'MeGa X Daemon']);

    patcher.applyDiffs([
      { path: 'index.ts', content: 'export const x = 1;\n', action: 'CREATE' },
    ]);
    git.commitAll('chore: initial commit');

    git.createTaskBranch('feature_alpha');
    git.createTaskBranch('feature_beta');

    const config: MegaXConfig = {
      projectName: 'Target-Project',
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
        maxFixAttempts: 3,
      },
      security: {
        requireApprovalOn: ['FILE_DELETE'],
      },
    };

    const engine = new OrchestratorEngine({ workspaceRoot: tempDir, config });
    const relay = new MobileRelayServer(engine);
    const port = await relay.start(0, '127.0.0.1');

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/branches`);
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        currentBranch: string;
        taskBranches: string[];
      };

      assert.equal(data.currentBranch, 'megax/feature_beta');
      assert.deepEqual(data.taskBranches.sort(), [
        'megax/feature_alpha',
        'megax/feature_beta',
      ]);
    } finally {
      await relay.stop();
    }
  });
});
