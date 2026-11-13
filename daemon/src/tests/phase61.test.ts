import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { runMegaXCli } from '../cli';
import { bootstrapDaemon, EcosystemHealthReport } from '../index';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 61: Full Ecosystem Health REST Endpoint & CLI Diagnostics', () => {
  it('serves ecosystem health report via GET /api/ecosystem/health', async () => {
    const engine = bootstrapDaemon();
    const relay = new MobileRelayServer(engine, async () => {});
    const port = await relay.start(0, '127.0.0.1');

    try {
      const responseData = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/api/ecosystem/health`, (res) => {
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(
              res.headers['content-type'],
              'application/json'
            );
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });

      const report = JSON.parse(responseData) as EcosystemHealthReport;
      assert.strictEqual(report.version, '1.0.0');
      assert.strictEqual(report.status, 'HEALTHY');
      assert.strictEqual(report.subsystems.daemonCore, true);
      assert.strictEqual(report.subsystems.networkWatchdog, true);
      assert.strictEqual(report.subsystems.consensusEngine, true);
      assert.strictEqual(report.subsystems.benchmarkProfiler, true);
      assert.ok(report.metrics.totalTestSuites >= 60);
      assert.ok(report.metrics.registeredAgentCount >= 3);
    } finally {
      await relay.stop();
    }
  });

  it('executes megax health CLI and prints formatted subsystem status', async () => {
    const { exitCode, output } = await runMegaXCli(['health']);

    assert.strictEqual(exitCode, 0);
    assert.ok(output.includes('=== MeGa X Ecosystem Health Report ==='));
    assert.ok(output.includes('Status         : HEALTHY'));
    assert.ok(output.includes('Daemon Core       : HEALTHY'));
    assert.ok(output.includes('Consensus Engine  : HEALTHY'));
    assert.ok(output.includes('Benchmark Profiler: HEALTHY'));
    assert.ok(output.includes('Total Test Suites :'));
  });
});
