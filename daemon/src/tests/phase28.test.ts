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

describe('Phase 28: Git Commit Log Inspector & /api/commits Endpoint (50-Test Milestone)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase28-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('GitManager.getRecentCommits and GET /api/commits return structured commit history', async () => {
    const git = new GitManager(tempDir);
    const patcher = new FilePatcher(tempDir);

    git.runGit(['init']);
    git.runGit(['config', 'user.email', 'daemon@megax.local']);
    git.runGit(['config', 'user.name', 'MeGa X Daemon']);

    patcher.applyDiffs([
      { path: 'a.ts', content: 'export const a = 1;\n', action: 'CREATE' },
    ]);
    git.commitAll('feat: first autonomous commit');

    patcher.applyDiffs([
      { path: 'b.ts', content: 'export const b = 2;\n', action: 'CREATE' },
    ]);
    git.commitAll('feat: second autonomous commit');

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
      const res = await fetch(`http://127.0.0.1:${port}/api/commits`);
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        commits: { hash: string; subject: string; author: string }[];
      };

      assert.equal(data.commits.length, 2);
      assert.equal(data.commits[0].subject, 'feat: second autonomous commit');
      assert.equal(data.commits[1].subject, 'feat: first autonomous commit');
      assert.equal(data.commits[0].author, 'MeGa X Daemon');
    } finally {
      await relay.stop();
    }
  });
});

