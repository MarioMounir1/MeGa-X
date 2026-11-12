import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as http from 'http';
import {
  NetworkHealthMonitor,
  NetworkTransitionEvent,
} from '../relay/networkWatchdog';
import { OrchestratorEngine } from '../orchestrator/orchestratorEngine';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 57: Cross-Platform Tailscale & Network Health Watchdog', () => {
  const fakeLanOnly: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
    'Wi-Fi': [
      {
        address: '192.168.1.100',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '00:11:22:33:44:55',
        internal: false,
        cidr: '192.168.1.100/24',
      },
    ],
  };

  const fakeTailscaleAndLan: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
    'Wi-Fi': [
      {
        address: '192.168.1.100',
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '00:11:22:33:44:55',
        internal: false,
        cidr: '192.168.1.100/24',
      },
    ],
    tailscale0: [
      {
        address: '100.101.102.103',
        netmask: '255.255.255.255',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: false,
        cidr: '100.101.102.103/32',
      },
    ],
  };

  const fakeLoopbackOnly: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
    lo: [
      {
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '127.0.0.1/8',
      },
    ],
  };

  it('evaluates baseline status and detects LAN vs Tailscale interfaces', () => {
    const monitor = new NetworkHealthMonitor(4040, {
      interfacesProvider: () => fakeLanOnly,
    });

    const snapLan = monitor.getSnapshot();
    assert.strictEqual(snapLan.status, 'ONLINE');
    assert.strictEqual(snapLan.lanConnected, true);
    assert.strictEqual(snapLan.tailscaleConnected, false);
    assert.strictEqual(snapLan.primaryEndpoint, 'ws://192.168.1.100:4040/ws');

    // Switch to Tailscale
    const snapTailscale = monitor.checkNow(fakeTailscaleAndLan);
    assert.strictEqual(snapTailscale.status, 'ONLINE');
    assert.strictEqual(snapTailscale.tailscaleConnected, true);
    assert.strictEqual(snapTailscale.primaryEndpoint, 'ws://100.101.102.103:4040/ws');
  });

  it('dispatches transition events when network interfaces bounce or change', () => {
    const events: NetworkTransitionEvent[] = [];
    const monitor = new NetworkHealthMonitor(4040, {
      interfacesProvider: () => fakeLanOnly,
      listener: (evt) => events.push(evt),
    });

    // 1. Initial State already emitted
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'INITIAL_STATE');

    // 2. Connect Tailscale
    monitor.checkNow(fakeTailscaleAndLan);
    const tsConnectEvt = events.find((e) => e.type === 'TAILSCALE_CONNECTED');
    assert.ok(tsConnectEvt);
    assert.strictEqual(tsConnectEvt.currentPrimary, 'ws://100.101.102.103:4040/ws');

    // 3. Drop all external interfaces (Airplane mode / loopback only)
    monitor.checkNow(fakeLoopbackOnly);
    const degradedEvt = events.find((e) => e.type === 'CONNECTIVITY_DEGRADED');
    assert.ok(degradedEvt);
    assert.strictEqual(degradedEvt.currentPrimary, 'ws://127.0.0.1:4040/ws');

    // 4. Restore LAN
    monitor.checkNow(fakeLanOnly);
    const restoredEvt = events.find((e) => e.type === 'CONNECTIVITY_RESTORED');
    assert.ok(restoredEvt);
  });

  it('serves live network health snapshot via GET /api/network/health', async () => {
    const engine = new OrchestratorEngine({
      workspaceRoot: process.cwd(),
      config: {
        projectName: 'Net-Health-Test',
        engineMode: 'SINGLE_AGENT',
        primaryAgent: 'claude-3-7-sonnet',
        multiAgentConfig: {
          planner: 'claude-3-7-sonnet',
          executor: 'antigravity',
          reviewer: 'codex',
        },
        verification: { testCommand: '', compileCommand: '', maxFixAttempts: 1 },
        security: { requireApprovalOn: [] },
      },
    });

    const relay = new MobileRelayServer(engine);
    const port = await relay.start(0);

    try {
      const snap = await new Promise<any>((resolve, reject) => {
        http.get(`http://localhost:${port}/api/network/health`, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
      });

      assert.ok(['ONLINE', 'DEGRADED', 'OFFLINE'].includes(snap.status));
      assert.ok(typeof snap.primaryEndpoint === 'string');
      assert.ok(typeof snap.tailscaleConnected === 'boolean');
      assert.ok(typeof snap.lanConnected === 'boolean');
      assert.ok(Array.isArray(snap.activeEndpoints));
      assert.ok(Array.isArray(snap.transitionHistory));
    } finally {
      await relay.stop();
    }
  });
});

