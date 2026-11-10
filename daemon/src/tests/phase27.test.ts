import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

describe('Phase 27: Full Remote Config Patching & Validation via /api/config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase27-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('POST /api/config deep-merges and validates partial config updates and rejects invalid values', async () => {
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
      // 1. Valid partial patch (update maxFixAttempts and security.requireApprovalOn)
      const okRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verification: { maxFixAttempts: 5 },
          security: { requireApprovalOn: ['FILE_DELETE', 'DB_MIGRATION'] },
        }),
      });
      assert.equal(okRes.status, 200);
      const updated = (await okRes.json()) as MegaXConfig;
      assert.equal(updated.verification.maxFixAttempts, 5);
      assert.deepEqual(updated.security.requireApprovalOn, [
        'FILE_DELETE',
        'DB_MIGRATION',
      ]);

      // 2. Invalid patch (maxFixAttempts: 0) -> 400 Bad Request
      const badRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          verification: { maxFixAttempts: 0 },
        }),
      });
      assert.equal(badRes.status, 400);
    } finally {
      await relay.stop();
    }
  });
});

