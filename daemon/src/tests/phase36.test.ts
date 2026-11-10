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
    projectName: 'Phase36-Approvals-Test',
    engineMode: 'SINGLE_AGENT',
    primaryAgent: 'migration-agent',
    multiAgentConfig: {
      planner: 'migration-agent',
      executor: 'migration-agent',
      reviewer: 'migration-agent',
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

describe('Phase 36: Pending Security Approval Inspector (/api/approvals) & WebSocket Reconnect Replay', () => {
  it('exposes full pending approval payloads via GET /api/approvals and replays APPROVAL_REQUIRED on late WebSocket connect', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-p36-'));
    let relay: MobileRelayServer | undefined;

    try {
      const registry = new AgentRegistry();
      registry.register(
        new ConfigurableAgentAdapter('migration-agent', {
          onExecute: async (payload) => ({
            taskId: payload.taskId,
            explanation: 'Add Prisma DB migration',
            fileDiffs: [
              {
                path: 'prisma/migrations/001_init.sql',
                action: 'CREATE',
                content: 'ALTER TABLE users ADD COLUMN role TEXT;\n',
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

      // Start orchestration BEFORE any mobile WebSocket client is connected
      const runPromise = engine.runFeaturePrompt(
        'task-36',
        'Run DB schema migration'
      );

      // Poll GET /api/approvals until the DB_MIGRATION approval gate is registered
      let approvalId = '';
      for (let i = 0; i < 30; i++) {
        const res = await httpRequestJson(
          `http://127.0.0.1:${port}/api/approvals`,
          'GET'
        );
        if (Number(res.body.totalCount) === 1) {
          const list = res.body.pendingApprovals as Array<{
            approvalId: string;
            trigger: string;
            affectedFiles: string[];
          }>;
          assert.strictEqual(list[0].trigger, 'DB_MIGRATION');
          assert.deepStrictEqual(list[0].affectedFiles, [
            'prisma/migrations/001_init.sql',
          ]);
          approvalId = list[0].approvalId;
          break;
        }
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.ok(approvalId.length > 0, 'Expected pending approvalId');

      // Now connect a late WebSocket client and verify it immediately receives the replayed APPROVAL_REQUIRED frame
      const replayedMessage = await new Promise<Record<string, unknown>>(
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

      assert.strictEqual(replayedMessage.type, 'APPROVAL_REQUIRED');
      const replayedPayload = replayedMessage.payload as {
        approvalId: string;
        trigger: string;
      };
      assert.strictEqual(replayedPayload.approvalId, approvalId);
      assert.strictEqual(replayedPayload.trigger, 'DB_MIGRATION');

      // Resolve the approval gate via POST /api/approval
      const approveRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/approval`,
        'POST',
        {
          approvalId,
          taskId: 'task-36_single',
          approved: true,
        }
      );
      assert.strictEqual(approveRes.statusCode, 200);

      const finalResult = await runPromise;
      assert.strictEqual(finalResult.overallSuccess, true);

      // Verify GET /api/approvals is now empty
      const afterRes = await httpRequestJson(
        `http://127.0.0.1:${port}/api/approvals`,
        'GET'
      );
      assert.strictEqual(afterRes.body.totalCount, 0);
    } finally {
      if (relay) {
        await relay.stop();
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

