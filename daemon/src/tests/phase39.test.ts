import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { FcmDispatcher } from '../relay/fcmDispatcher';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

function createTestConfig(): MegaXConfig {
  return {
    projectName: 'Phase39-Fcm-Test',
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
      requireApprovalOn: ['FILE_DELETE', 'DB_MIGRATION', 'MAX_RETRY_EXCEEDED'],
    },
  };
}

function httpRequestJson(
  url: string,
  method: 'GET' | 'POST',
  payload?: Record<string, unknown>
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = payload ? JSON.stringify(payload) : undefined;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: bodyStr
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyStr),
            }
          : undefined,
      },
      (res) => {
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
      }
    );
    req.on('error', reject);
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

describe('Phase 39: FCM Push Notification History & Diagnostic Test Push API (/api/fcm/history & /api/fcm/test)', () => {
  it('dispatches diagnostic push via POST /api/fcm/test and records FCM history via GET /api/fcm/history', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p39-'));
    let relay: MobileRelayServer | undefined;

    try {
      const fcmDispatcher = new FcmDispatcher({ logToConsole: false });
      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
      });

      relay = new MobileRelayServer(
        engine,
        fcmDispatcher.createSender(),
        ''
      );
      const port = await relay.start(0);

      // 1. Initial GET /api/fcm/history is empty and fcmConfigured is true
      const initialRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/fcm/history`,
        'GET'
      );
      assert.strictEqual(initialRes.statusCode, 200);
      assert.strictEqual(initialRes.body.totalCount, 0);
      assert.strictEqual(initialRes.body.fcmConfigured, true);

      // 2. Trigger a diagnostic test push via POST /api/fcm/test
      const testPushRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/fcm/test`,
        'POST',
        {
          title: 'Phase 39 Test Push',
          body: 'Verifying FCM relay pipeline',
        }
      );
      assert.strictEqual(testPushRes.statusCode, 200);
      assert.strictEqual(testPushRes.body.dispatched, true);

      // 3. Verify FcmDispatcher received the push and GET /api/fcm/history logged it
      assert.strictEqual(fcmDispatcher.getDispatchedHistory().length, 1);

      const afterRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/fcm/history`,
        'GET'
      );
      assert.strictEqual(afterRes.statusCode, 200);
      assert.strictEqual(afterRes.body.totalCount, 1);
      const list = afterRes.body.notifications as Array<{
        title: string;
        body: string;
        dispatchedAt: string;
        data: { trigger: string };
      }>;
      assert.strictEqual(list[0].title, 'Phase 39 Test Push');
      assert.strictEqual(list[0].data.trigger, 'DIAGNOSTIC_TEST');
      assert.ok(list[0].dispatchedAt.length > 0);
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

