import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

describe('Phase 10: Secure Relay Token Authentication', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase10-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('Blocks unauthenticated requests with 401 and permits Bearer / query token requests when relaySecretToken is configured', async () => {
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
    const relay = new MobileRelayServer(
      engine,
      undefined,
      'super-secret-tailscale-token'
    );
    const port = await relay.start(0, '127.0.0.1');

    try {
      // 1. Unauthenticated request -> 401
      const unauthRes = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.equal(unauthRes.status, 401);

      // 2. Wrong token -> 401
      const wrongRes = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      assert.equal(wrongRes.status, 401);

      // 3. Valid Bearer header -> 200
      const bearerRes = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Authorization: 'Bearer super-secret-tailscale-token' },
      });
      assert.equal(bearerRes.status, 200);

      // 4. Valid query parameter (?token=...) -> 200
      const queryRes = await fetch(
        `http://127.0.0.1:${port}/api/status?token=super-secret-tailscale-token`
      );
      assert.equal(queryRes.status, 200);
    } finally {
      await relay.stop();
    }
  });
});

