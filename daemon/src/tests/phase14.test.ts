import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';
import { TunnelInspector } from '../relay/tunnelInspector';
import { MegaXConfig } from '../types/contracts';

describe('Phase 14: Tailscale & LAN Tunnel Auto-Discovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megax-phase14-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('TunnelInspector classifies Tailscale CGNAT (100.64.0.0/10) and prioritizes Tailscale over LAN', () => {
    const mockInterfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
      'Wi-Fi': [
        {
          address: '192.168.1.50',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:11:22:33:44:55',
          internal: false,
          cidr: '192.168.1.50/24',
        },
      ],
      Tailscale: [
        {
          address: '100.101.102.103',
          netmask: '255.192.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '100.101.102.103/10',
        },
      ],
    };

    const pairing = TunnelInspector.getPairingInfo(4040, true, mockInterfaces);
    assert.equal(pairing.port, 4040);
    assert.equal(pairing.requiresToken, true);
    assert.equal(pairing.recommendedWsUrl, 'ws://100.101.102.103:4040/ws');
    assert.equal(pairing.endpoints.length, 2);
    assert.equal(pairing.endpoints[0].networkType, 'TAILSCALE');
    assert.equal(pairing.endpoints[1].networkType, 'LAN');
  });

  it('GET /api/pairing returns host pairing manifest from MobileRelayServer', async () => {
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
      const res = await fetch(`http://127.0.0.1:${port}/api/pairing`);
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        port: number;
        androidEmulatorWsUrl: string;
      };
      assert.equal(data.port, port);
      assert.equal(data.androidEmulatorWsUrl, `ws://10.0.2.2:${port}/ws`);
    } finally {
      await relay.stop();
    }
  });
});

