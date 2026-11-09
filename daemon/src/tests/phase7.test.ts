import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { FcmDispatcher } from '../relay/fcmDispatcher';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

describe('Phase 7: FCM Push Dispatcher & Built-in Web Steering Wheel UI', () => {
  it('FcmDispatcher formats Android/iOS interactive approval envelopes and records history', async () => {
    const fcm = new FcmDispatcher({
      targetTopicOrToken: 'device_token_abc',
      logToConsole: false,
    });

    const payload = {
      title: '⚠️ MeGa X Security Gate: DB_MIGRATION',
      body: 'Task modifies prisma/schema.prisma',
      data: {
        approvalId: 'apr_123',
        taskId: 'task_01',
        trigger: 'DB_MIGRATION',
        affectedFiles: '["prisma/schema.prisma"]',
        actions: '["APPROVE","ROLLBACK"]',
      },
    };

    const envelope = fcm.buildFcmEnvelope(payload) as {
      message: { topic: string; notification: { title: string } };
    };
    assert.equal(envelope.message.topic, 'device_token_abc');
    assert.equal(
      envelope.message.notification.title,
      '⚠️ MeGa X Security Gate: DB_MIGRATION'
    );

    await fcm.send(payload);
    assert.equal(fcm.getDispatchedHistory().length, 1);
  });

  it('MobileRelayServer serves the Web Steering Wheel Dashboard at GET / and health at GET /api/status', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase7-'));
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
      const uiRes = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(uiRes.status, 200);
      const html = await uiRes.text();
      assert.ok(html.includes('MeGa X • Mobile Steering Wheel'));

      const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.equal(statusRes.status, 200);
      const statusJson = (await statusRes.json()) as { status: string };
      assert.equal(statusJson.status, 'ONLINE');
    } finally {
      await relay.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

