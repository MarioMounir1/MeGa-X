import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { MegaXConfig } from '../types/contracts';

describe('Phase 21: WebSocket Ping/Pong Heartbeat & Mobile Multi-View Telemetry', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase21-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('MobileRelayServer responds to RFC-6455 Ping frames (0x89) with Pong frames (0x8A)', async () => {
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
      const pongReceived = await new Promise<boolean>((resolve, reject) => {
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
            if (chunk.length >= 2 && chunk[0] === 0x8a) {
              socket.end();
              resolve(true);
            }
          });

          // Send an empty RFC-6455 Ping frame (FIN=1, opcode=0x9 -> 0x89, len=0)
          socket.write(Buffer.from([0x89, 0x00]));
        });

        req.on('error', reject);
        req.end();
      });

      assert.equal(pongReceived, true);
    } finally {
      await relay.stop();
    }
  });
});

