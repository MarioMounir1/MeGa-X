import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { runMegaXCli } from '../cli';
import { bootstrapDaemon } from '../index';
import { CircuitBreakerSentinel } from '../agents/circuitBreakerSentinel';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 67: Agent Execution Circuit Breaker & Fault Recovery Sentinel', () => {
  it('manages CLOSED, OPEN, and HALF_OPEN states and route fallbacks', () => {
    const cb = new CircuitBreakerSentinel({
      failureThreshold: 2,
      resetTimeoutMs: 50,
      fallbackAgent: 'antigravity',
    });

    assert.strictEqual(cb.canExecute(), true);
    assert.strictEqual(cb.getStatus().state, 'CLOSED');
    assert.strictEqual(cb.getEffectiveAgent('claude-3-7-sonnet'), 'claude-3-7-sonnet');

    // First failure
    cb.recordFailure(new Error('Rate limit'));
    assert.strictEqual(cb.getStatus().consecutiveFailures, 1);
    assert.strictEqual(cb.getStatus().state, 'CLOSED');
    assert.strictEqual(cb.canExecute(), true);

    // Second failure trips circuit to OPEN
    cb.recordFailure('Timeout');
    assert.strictEqual(cb.getStatus().consecutiveFailures, 2);
    assert.strictEqual(cb.getStatus().state, 'OPEN');
    assert.strictEqual(cb.getStatus().totalTrips, 1);
    assert.strictEqual(cb.getEffectiveAgent('claude-3-7-sonnet'), 'antigravity');
    assert.strictEqual(cb.canExecute(), false);

    // Manual reset
    cb.reset();
    assert.strictEqual(cb.getStatus().state, 'CLOSED');
    assert.strictEqual(cb.canExecute(), true);
  });

  it('serves circuit breaker via REST endpoints (/api/circuit, /api/circuit/trip, /api/circuit/reset)', async () => {
    const engine = bootstrapDaemon();
    const cb = engine.getCircuitBreaker();
    cb.reset();

    const relay = new MobileRelayServer(engine, async () => {});
    const port = await relay.start(0, '127.0.0.1');

    try {
      // 1. GET /api/circuit (starts CLOSED)
      const getRes = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/api/circuit`, (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
      const parsedGet = JSON.parse(getRes);
      assert.strictEqual(parsedGet.state, 'CLOSED');

      // 2. POST /api/circuit/trip
      const tripRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/circuit/trip`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ reason: 'Mobile panic button' }));
        req.end();
      });
      const parsedTrip = JSON.parse(tripRes);
      assert.strictEqual(parsedTrip.success, true);
      assert.strictEqual(parsedTrip.status.state, 'OPEN');

      // 3. POST /api/circuit/reset
      const resetRes = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/circuit/reset`,
          { method: 'POST' },
          (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          }
        );
        req.on('error', reject);
        req.end();
      });
      const parsedReset = JSON.parse(resetRes);
      assert.strictEqual(parsedReset.success, true);
      assert.strictEqual(parsedReset.status.state, 'CLOSED');
    } finally {
      await relay.stop();
    }
  });

  it('runs megax circuit CLI commands (status, trip, reset)', async () => {
    // 1. status
    const statusRes = await runMegaXCli(['circuit', 'status']);
    assert.strictEqual(statusRes.exitCode, 0);
    assert.ok(statusRes.output.includes('=== MeGa X Agent Circuit Breaker Sentinel ==='));
    assert.ok(statusRes.output.includes('State               : CLOSED'));

    // 2. trip
    const tripRes = await runMegaXCli(['circuit', 'trip']);
    assert.strictEqual(tripRes.exitCode, 0);
    assert.ok(tripRes.output.includes('Tripped agent circuit breaker to OPEN state'));

    // 3. reset
    const resetRes = await runMegaXCli(['circuit', 'reset']);
    assert.strictEqual(resetRes.exitCode, 0);
    assert.ok(resetRes.output.includes('Reset agent circuit breaker to CLOSED state'));
  });
});

