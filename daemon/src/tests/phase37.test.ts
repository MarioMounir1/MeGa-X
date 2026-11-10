import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import {
  AgentRegistry,
  ConfigurableAgentAdapter,
} from '../agents/agentRegistry';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

function createTestConfig(): MegaXConfig {
  return {
    projectName: 'Phase37-Status-Test',
    engineMode: 'SINGLE_AGENT',
    primaryAgent: 'status-agent',
    multiAgentConfig: {
      planner: 'status-agent',
      executor: 'status-agent',
      reviewer: 'status-agent',
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

describe('Phase 37: Live Orchestrator Status Telemetry (/api/status) & WebSocket State Replay', () => {
  it('exposes projectName, engineMode, uptimeSeconds, and lastStateEvent via GET /api/status and replays STATE_CHANGE on WebSocket connect', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p37-'));
    let relay: MobileRelayServer | undefined;

    try {
      const registry = new AgentRegistry();
      registry.register(
        new ConfigurableAgentAdapter('status-agent', {
          onExecute: async (payload) => ({
            taskId: payload.taskId,
            explanation: 'Created feature 37',
            fileDiffs: [
              {
                path: 'src/feature37.ts',
                action: 'CREATE',
                content: 'export const f37 = true;\n',
              },
            ],
          }),
        })
      );

      const engine = new OrchestratorEngine({
        workspaceRoot: tempDir,
        config: createTestConfig(),
        agentRegistry: registry,
      });

      relay = new MobileRelayServer(engine, undefined, '');
      const port = await relay.start(0);

      // 1. Check initial GET /api/status before any task has run
      const initialStatus = await httpGetJson(
        `http://127.0.0.1:${port}/api/status`
      );
      assert.strictEqual(initialStatus.statusCode, 200);
      assert.strictEqual(initialStatus.body.status, 'ONLINE');
      assert.strictEqual(initialStatus.body.projectName, 'Phase37-Status-Test');
      assert.strictEqual(initialStatus.body.engineMode, 'SINGLE_AGENT');
      assert.strictEqual(initialStatus.body.lastStateEvent, null);
      assert.strictEqual(typeof initialStatus.body.uptimeSeconds, 'number');

      // 2. Execute a feature prompt so OrchestratorEngine records lastStateEvent
      const runRes = await engine.runFeaturePrompt(
        'task-37',
        'Add feature 37'
      );
      assert.strictEqual(runRes.overallSuccess, true);

      // 3. Check GET /api/status after task completion
      const afterStatus = await httpGetJson(
        `http://127.0.0.1:${port}/api/status`
      );
      const lastState = afterStatus.body.lastStateEvent as {
        taskId: string;
        state: string;
      };
      assert.ok(lastState);
      assert.strictEqual(lastState.state, 'COMPLETED');

      // 4. Connect a WebSocket client and verify it immediately receives the replayed STATE_CHANGE frame
      const replayedStateFrame = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const socket = net.connect(port, '127.0.0.1', () => {
            const key = crypto.randomBytes(16).toString('base64');
            socket.write(
              [
                'GET /ws HTTP/1.1',
                `Host: 127.0.0.1:${port}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Key: ${key}`,
                'Sec-WebSocket-Version: 13',
                '\r\n',
              ].join('\r\n')
            );
          });

          let buffer = Buffer.alloc(0);
          socket.on('data', (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
              return;
            }
            const wsFrames = buffer.subarray(headerEnd + 4);
            if (wsFrames.length < 2) {
              return;
            }
            const decoded = MobileRelayServer.decodeWsTextFrame(wsFrames);
            if (decoded) {
              socket.destroy();
              resolve(JSON.parse(decoded) as Record<string, unknown>);
            }
          });
          socket.on('error', reject);
        }
      );

      assert.strictEqual(replayedStateFrame.type, 'STATE_CHANGE');
      const replayedPayload = replayedStateFrame.payload as {
        state: string;
      };
      assert.strictEqual(replayedPayload.state, 'COMPLETED');
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

