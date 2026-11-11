import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

function createTestConfig(): MegaXConfig {
  return {
    projectName: 'Phase49-Pairing-Test',
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
      maxFixAttempts: 1,
    },
    security: {
      requireApprovalOn: ['FILE_DELETE'],
    },
  };
}

function httpGetJson(
  url: string
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf-8');
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: JSON.parse(raw) as Record<string, unknown>,
          });
        });
      })
      .on('error', reject);
  });
}

describe('Phase 49: Mobile QR Pairing Payload & Deep-Link Protocol (/api/pairing & megax://connect)', () => {
  it('generates megax:// deep-link QR pairing payload with token when relaySecretToken is set', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p49-'));
    let relay: MobileRelayServer | undefined;

    try {
      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });

      const secretToken = 'secret-pair-token-xyz';
      relay = new MobileRelayServer(engine, undefined, secretToken);
      const port = await relay.start(0);

      // GET /api/pairing (authenticated via token query param)
      const res = await httpGetJson(
        `http://127.0.0.1:${port}/api/pairing?token=${secretToken}`
      );

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.requiresToken, true);
      const qrPayload = res.body.qrPayload as {
        scheme: string;
        targetUrl: string;
        tokenRequired: boolean;
        qrUri: string;
      };

      assert.strictEqual(qrPayload.scheme, 'megax');
      assert.strictEqual(qrPayload.tokenRequired, true);
      assert.ok(qrPayload.qrUri.startsWith('megax://connect?url='));
      assert.ok(qrPayload.qrUri.includes(encodeURIComponent(secretToken)));
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

