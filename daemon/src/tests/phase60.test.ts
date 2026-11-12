import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'http';
import {
  bootstrapDaemon,
  startDaemonRelayServer,
  getDaemonInstanceSummary,
  getEcosystemHealthReport,
} from '../index';

describe('Phase 60: Grand Diamond Milestone (60 Test Suites) — Autonomous Ecosystem Verification', () => {
  it('generates a comprehensive ecosystem health report confirming all subsystems are operational', () => {
    const engine = bootstrapDaemon();
    const report = getEcosystemHealthReport(engine);

    assert.strictEqual(report.version, '1.0.0');
    assert.strictEqual(report.status, 'HEALTHY');
    assert.strictEqual(report.subsystems.daemonCore, true);
    assert.strictEqual(report.subsystems.gitManager, true);
    assert.strictEqual(report.subsystems.securityGate, true);
    assert.strictEqual(report.subsystems.networkWatchdog, true);
    assert.strictEqual(report.subsystems.consensusEngine, true);
    assert.strictEqual(report.subsystems.benchmarkProfiler, true);
    assert.strictEqual(report.metrics.totalTestSuites, 60);
    assert.ok(report.metrics.registeredAgentCount >= 3);
  });

  it('verifies the full live daemon lifecycle and REST endpoint connectivity across subsystems', async () => {
    const { engine, relay, port } = await startDaemonRelayServer(0);

    try {
      const summary = getDaemonInstanceSummary(engine, port);
      assert.strictEqual(summary.version, '1.0.0');
      assert.ok(summary.endpoints.dashboardUrl.includes(String(port)));

      const endpointsToTest = [
        { path: '/api/status', expectedKey: 'status' },
        { path: '/api/network/health', expectedKey: 'status' },
        { path: '/api/pairing', expectedKey: 'recommendedWsUrl' },
        { path: '/api/consensus', expectedKey: 'evaluations' },
        { path: '/api/tags', expectedKey: 'tags' },
        { path: '/api/benchmark/scenarios', expectedArray: true },
      ];

      for (const ep of endpointsToTest) {
        const responseData = await new Promise<any>((resolve, reject) => {
          http.get(`http://localhost:${port}${ep.path}`, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch (err) {
                reject(err);
              }
            });
          }).on('error', reject);
        });

        if (ep.expectedArray) {
          assert.ok(
            Array.isArray(responseData),
            `Expected array response from ${ep.path}`
          );
        } else if (ep.expectedKey) {
          assert.ok(
            ep.expectedKey in responseData,
            `Expected key "${ep.expectedKey}" in response from ${ep.path}`
          );
        }
      }
    } finally {
      await relay.stop();
    }
  });
});

