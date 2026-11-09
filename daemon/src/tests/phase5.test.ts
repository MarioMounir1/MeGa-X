import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentRegistry,
  ConfigurableAgentAdapter,
} from '../agents/agentRegistry';
import { GitManager } from '../git/gitManager';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import {
  FcmNotificationPayload,
  MobileRelayServer,
  RelayOutboundMessage,
} from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

function createMaskedClientFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf-8');
  const maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ maskKey[i % 4];
  }

  if (payload.length < 126) {
    return Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]),
      maskKey,
      masked,
    ]);
  }

  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 0x80 | 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, maskKey, masked]);
}

describe('Phase 5: Bi-Directional Mobile Relay & FCM Interactive Approval', () => {
  let tempDir: string;
  let relay: MobileRelayServer;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase5-'));
    const git = new GitManager(tempDir);
    git.runGit(['init']);
    git.runGit(['config', 'user.email', 'daemon@megax.local']);
    git.runGit(['config', 'user.name', 'MeGa X Daemon']);

    fs.writeFileSync(
      path.join(tempDir, 'legacy.ts'),
      'export const oldCode = true;\n',
      'utf-8'
    );
    git.commitAll('chore: initial commit');
  });

  afterEach(async () => {
    if (relay) {
      await relay.stop();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('Streams live events over WebSocket, dispatches FCM push on FILE_DELETE, and resumes upon mobile approval', async () => {
    const fcmNotifications: FcmNotificationPayload[] = [];
    const registry = new AgentRegistry();

    registry.register(
      new ConfigurableAgentAdapter('claude-3-7-sonnet', {
        onExecute: (payload) => ({
          taskId: payload.taskId,
          explanation: 'Remove deprecated legacy.ts and create modern.ts',
          fileDiffs: [
            {
              path: 'legacy.ts',
              content: '',
              action: 'DELETE',
            },
            {
              path: 'modern.ts',
              content: 'export const modernCode = true;\n',
              action: 'CREATE',
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
        compileCommand: 'node -e "console.log(\'Compile OK\')"',
        testCommand: 'node -e "console.log(\'Tests OK\')"',
        maxFixAttempts: 3,
      },
      security: {
        requireApprovalOn: ['DB_MIGRATION', 'FILE_DELETE', 'MAX_RETRY_EXCEEDED'],
      },
    };

    const engine = new OrchestratorEngine({
      workspaceRoot: tempDir,
      config,
      agentRegistry: registry,
    });

    relay = new MobileRelayServer(engine, (fcmPayload) => {
      fcmNotifications.push(fcmPayload);
    });

    const port = await relay.start(0, '127.0.0.1');
    const receivedMessages: RelayOutboundMessage[] = [];

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/ws',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13',
        },
      });

      req.on('upgrade', (_res, socket) => {
        socket.on('data', (chunk: Buffer) => {
          // A single TCP chunk may contain one or more WebSocket frames
          let offset = 0;
          while (offset < chunk.length) {
            const sub = chunk.subarray(offset);
            const decoded = MobileRelayServer.decodeWsTextFrame(sub);
            if (!decoded) break;

            const byteLen = Buffer.byteLength(decoded, 'utf-8');
            const headerLen = byteLen < 126 ? 2 : byteLen < 65536 ? 4 : 10;
            offset += headerLen + byteLen;

            const msg = JSON.parse(decoded) as RelayOutboundMessage;
            receivedMessages.push(msg);

            if (msg.type === 'APPROVAL_REQUIRED') {
              // Simulate Flutter user tapping "APPROVE" in the interactive notification
              const decisionFrame = createMaskedClientFrame(
                JSON.stringify({
                  type: 'APPROVAL_DECISION',
                  payload: {
                    approvalId: msg.payload.approvalId,
                    taskId: msg.payload.taskId,
                    approved: true,
                    userNote: 'Approved deletion of legacy.ts from Flutter App',
                  },
                })
              );
              socket.write(decisionFrame);
            }

            if (msg.type === 'ORCHESTRATION_RESULT') {
              socket.end();
              resolve();
            }
          }
        });

        // Submit high-level prompt from mobile client over WebSocket
        const promptFrame = createMaskedClientFrame(
          JSON.stringify({
            type: 'PROMPT_SUBMIT',
            taskId: 'mobile_task_01',
            prompt: 'Replace legacy.ts with modern.ts',
          })
        );
        socket.write(promptFrame);
      });

      req.on('error', reject);
      req.end();
    });

    // Verify FCM Interactive Push was dispatched for FILE_DELETE
    assert.equal(fcmNotifications.length, 1);
    assert.ok(fcmNotifications[0].title.includes('FILE_DELETE'));

    // Verify terminal streams, state changes, and final orchestration completion arrived over WebSocket
    assert.ok(receivedMessages.some((m) => m.type === 'STATE_CHANGE'));
    assert.ok(receivedMessages.some((m) => m.type === 'TERMINAL_STREAM'));

    const finalMsg = receivedMessages.find(
      (m) => m.type === 'ORCHESTRATION_RESULT'
    );
    assert.ok(finalMsg && finalMsg.type === 'ORCHESTRATION_RESULT');
    assert.equal(finalMsg.payload.overallSuccess, true);
    assert.equal(
      fs.existsSync(path.join(tempDir, 'legacy.ts')),
      false
    );
    assert.equal(
      fs.existsSync(path.join(tempDir, 'modern.ts')),
      true
    );
  });
});
