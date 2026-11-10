import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

describe('Phase 30: Remote One-Tap Manual Verification API (/api/verify)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase30-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('POST /api/verify executes compileCommand and testCommand on demand and streams output', async () => {
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
        compileCommand: 'node -e "console.log(\'ManualCompileOK\')"',
        testCommand: 'node -e "console.log(\'ManualTestsOK\')"',
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
      const verifyRes = await fetch(`http://127.0.0.1:${port}/api/verify`, {
        method: 'POST',
      });
      assert.equal(verifyRes.status, 200);
      const result = (await verifyRes.json()) as {
        passed: boolean;
        compileResult: { stdout: string };
        testResult: { stdout: string };
      };

      assert.equal(result.passed, true);
      assert.ok(result.compileResult.stdout.includes('ManualCompileOK'));
      assert.ok(result.testResult.stdout.includes('ManualTestsOK'));
    } finally {
      await relay.stop();
    }
  });
});

