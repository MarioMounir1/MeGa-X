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

describe('Phase 12: Live Git Diff Inspector & Mobile Diff Endpoint', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase12-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('GitManager.getWorkingTreeDiff and GET /api/diff expose live code diffs to Mobile Controller', async () => {
    const git = new GitManager(tempDir);
    const patcher = new FilePatcher(tempDir);

    git.runGit(['init']);
    git.runGit(['config', 'user.email', 'daemon@megax.local']);
    git.runGit(['config', 'user.name', 'MeGa X Daemon']);

    patcher.applyDiffs([
      {
        path: 'server.ts',
        content: 'export const port = 3000;\n',
        action: 'CREATE',
      },
    ]);
    git.commitAll('chore: initial commit');

    // Modify server.ts in working tree
    patcher.applyDiffs([
      {
        path: 'server.ts',
        content: 'export const port = 4040;\n',
        action: 'UPDATE',
      },
    ]);

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
      const res = await fetch(`http://127.0.0.1:${port}/api/diff`);
      assert.equal(res.status, 200);
      const diffPayload = (await res.json()) as {
        currentBranch: string;
        statusLines: string[];
        unifiedDiff: string;
      };

      assert.ok(diffPayload.statusLines.some((l) => l.includes('server.ts')));
      assert.ok(diffPayload.unifiedDiff.includes('-export const port = 3000;'));
      assert.ok(diffPayload.unifiedDiff.includes('+export const port = 4040;'));
    } finally {
      await relay.stop();
    }
  });
});

