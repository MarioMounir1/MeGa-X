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

describe('Phase 9: Live Mobile Mode Switching & Task Branch Merge Finalizer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase9-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('Switches dynamically between SINGLE_AGENT and MULTI_AGENT via /api/config', async () => {
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
      const getRes = await fetch(`http://127.0.0.1:${port}/api/config`);
      const initialCfg = (await getRes.json()) as MegaXConfig;
      assert.equal(initialCfg.engineMode, 'SINGLE_AGENT');

      const postRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engineMode: 'MULTI_AGENT' }),
      });
      assert.equal(postRes.status, 200);
      const updatedCfg = (await postRes.json()) as MegaXConfig;
      assert.equal(updatedCfg.engineMode, 'MULTI_AGENT');
      assert.equal(engine.getConfig().engineMode, 'MULTI_AGENT');
    } finally {
      await relay.stop();
    }
  });

  it('GitManager.mergeTaskBranch merges a verified megax/task branch into base branch and cleans up', () => {
    const git = new GitManager(tempDir);
    const patcher = new FilePatcher(tempDir);

    git.runGit(['init']);
    git.runGit(['config', 'user.email', 'daemon@megax.local']);
    git.runGit(['config', 'user.name', 'MeGa X Daemon']);

    patcher.applyDiffs([
      { path: 'app.ts', content: 'export const v = 1;\n', action: 'CREATE' },
    ]);
    git.commitAll('chore: initial commit');
    const baseBranch = git.getCurrentBranch();

    const taskBranch = git.createTaskBranch('task_merge_01');
    patcher.applyDiffs([
      {
        path: 'feature.ts',
        content: 'export const mergedFeature = true;\n',
        action: 'CREATE',
      },
    ]);
    git.commitAll('feat: add mergedFeature');

    const mergeHash = git.mergeTaskBranch(taskBranch, baseBranch, true);
    assert.ok(mergeHash);
    assert.equal(git.getCurrentBranch(), baseBranch);
    assert.equal(fs.existsSync(path.join(tempDir, 'feature.ts')), true);

    const remainingBranches = git.runGit(['branch', '--list', taskBranch]);
    assert.equal(remainingBranches, '');
  });
});

