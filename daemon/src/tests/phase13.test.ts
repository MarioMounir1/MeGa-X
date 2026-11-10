import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentRegistry,
  ConfigurableAgentAdapter,
} from '../agents/agentRegistry';
import { GitManager } from '../git/gitManager';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

describe('Phase 13: Mobile Emergency Kill-Switch & Active Process Cancellation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase13-'));
    const git = new GitManager(tempDir);
    git.runGit(['init']);
    git.runGit(['config', 'user.email', 'daemon@megax.local']);
    git.runGit(['config', 'user.name', 'MeGa X Daemon']);
    fs.writeFileSync(
      path.join(tempDir, 'service.ts'),
      'export const status = "clean";\n',
      'utf-8'
    );
    git.commitAll('chore: initial commit');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('POST /api/abort kills an active verification command and rolls back the task branch', async () => {
    const registry = new AgentRegistry();
    registry.register(
      new ConfigurableAgentAdapter('claude-3-7-sonnet', {
        onExecute: (payload) => ({
          taskId: payload.taskId,
          explanation: 'Modify service.ts',
          fileDiffs: [
            {
              path: 'service.ts',
              content: 'export const status = "dirty";\n',
              action: 'UPDATE',
            },
          ],
        }),
      })
    );

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
        compileCommand: 'node -e "setTimeout(() => {}, 5000)"',
        testCommand: 'node -e "process.exit(0)"',
        maxFixAttempts: 3,
      },
      security: {
        requireApprovalOn: ['FILE_DELETE'],
      },
    };

    const engine = new OrchestratorEngine({
      workspaceRoot: tempDir,
      config,
      agentRegistry: registry,
    });

    const relay = new MobileRelayServer(engine);
    const port = await relay.start(0, '127.0.0.1');

    try {
      const runPromise = engine.runFeaturePrompt(
        'task_to_abort',
        'Run slow task'
      );

      // Trigger Emergency Kill-Switch after 200ms while compileCommand is sleeping
      await new Promise((r) => setTimeout(r, 200));
      const abortRes = await fetch(`http://127.0.0.1:${port}/api/abort`, {
        method: 'POST',
      });
      assert.equal(abortRes.status, 200);

      const result = await runPromise;
      assert.equal(result.overallSuccess, false);
      assert.equal(result.microTaskResults[0].status, 'ROLLED_BACK');
      assert.ok(
        result.microTaskResults[0].failureReason?.includes('Kill-Switch')
      );

      // Confirm hard Git rollback restored service.ts to "clean"
      assert.equal(
        fs
          .readFileSync(path.join(tempDir, 'service.ts'), 'utf-8')
          .replace(/\r\n/g, '\n'),
        'export const status = "clean";\n'
      );
    } finally {
      await relay.stop();
    }
  });
});

