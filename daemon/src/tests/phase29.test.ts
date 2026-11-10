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

describe('Phase 29: Remote Branch Checkout API (/api/checkout)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase29-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('POST /api/checkout switches active branch between megax/* task branch and base branch', async () => {
    const git = new GitManager(tempDir);
    const patcher = new FilePatcher(tempDir);

    git.runGit(['init']);
    git.runGit(['config', 'user.email', 'daemon@megax.local']);
    git.runGit(['config', 'user.name', 'MeGa X Daemon']);

    patcher.applyDiffs([
      { path: 'index.ts', content: 'export const v = 1;\n', action: 'CREATE' },
    ]);
    git.commitAll('chore: initial commit');
    const baseBranch = git.getCurrentBranch();

    git.createTaskBranch('switch_test');
    assert.equal(git.getCurrentBranch(), 'megax/switch_test');

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
      const res = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchName: baseBranch }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        checkedOut: boolean;
        currentBranch: string;
      };
      assert.equal(body.checkedOut, true);
      assert.equal(body.currentBranch, baseBranch);
      assert.equal(git.getCurrentBranch(), baseBranch);
    } finally {
      await relay.stop();
    }
  });
});

